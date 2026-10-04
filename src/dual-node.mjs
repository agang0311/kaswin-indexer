// Dual-node (primary + hot standby) wrapper over one-connection nodes. Same interface as openNode's result, so the engine
// is unchanged. Both connections carry the same UTXO subscriptions (duplicated events are harmless: the engine dedups by
// queue key and round state). Queries go to the active member; when it drops, the other becomes active at once and the
// caller gets a 'failover' event (run reconcile/retry). The dropped member is recreated by us (fresh client per attempt,
// bounded timeout) - measured 2026-09-30: SDK 2.0.1 built-in Retry does not recover after the endpoint refused
// connections for a while, and a connect against a refusing endpoint may hang past timeoutDuration.

const QUERY = ['getBlockDagInfo', 'getSinkBlueScore', 'getBlock', 'getBlocks', 'getMempoolEntriesByAddresses', 'getUtxosByAddresses',
  'getVirtualChainFromBlock', 'getVirtualChainFromBlockV2'];

/**
 * @param open  async (url) => single node ({identity, on, verify, subscribeUtxosChanged, ..., close}); must reject/timeout on failure
 * @param urls  exactly two distinct URLs (primary first)
 */
// heartbeatMs: public endpoints (behind Cloudflare) drop a WebSocket idle for ~60 s (measured 2026-09-30 on muon-10 and
// vector-10: idle socket dropped at ~61 s, one pinged every 20 s survived). The standby only receives notifications, so
// every member is pinged; a failed ping marks it down (also catches silent deaths).
export async function openDualNode({open, urls, log = () => {}, reconnectMs = [1000, 3000, 5000, 10000], connectTimeoutMs = 10000,
  heartbeatMs = 20000, setTimer = setTimeout, clearTimer = clearTimeout, setRepeat = setInterval, clearRepeat = clearInterval,
  pickReplacement = null, replaceAfter = 3}) {
  // pickReplacement({failedUrl, avoidP2pIds, avoidUrls}) -> url|null : pool mode. Without it the two URLs are fixed.
  if (!Array.isArray(urls) || urls.length !== 2 || urls[0] === urls[1]) throw Error('DUAL_NODE_NEEDS_TWO_DISTINCT_URLS');
  const handlers = {connect: [], disconnect: [], utxos: [], failover: []};
  const emit = (k, ...a) => handlers[k].forEach(f => { try { f(...a); } catch (e) { log('HANDLER_ERROR', k, String(e?.message ?? e)); } });
  const subs = new Set();
  let closed = false;
  const members = urls.map((url, slot) => ({slot, url, node: null, up: false, attempts: 0, timer: null, gen: 0}));
  let active = null;

  const withTimeout = (p, ms, what) => new Promise((resolve, reject) => {
    const t = setTimer(() => reject(Error(what + '_TIMEOUT')), ms);
    p.then(v => { clearTimer(t); resolve(v); }, e => { clearTimer(t); reject(e); });
  });
  const pickActive = reason => {
    const prev = active;
    active = members.find(m => m.up && m === prev) ?? members.find(m => m.up) ?? null;
    if (active !== prev) {
      if (active && prev) { log('FAILOVER', {from: prev.url, to: active.url, reason}); emit('failover', {from: prev.url, to: active.url}); }
      else if (active && !prev) { log('NODE_ACTIVE', {url: active.url, reason}); emit('connect'); }
      else if (!active) { log('ALL_NODES_DOWN', {reason}); emit('disconnect'); }
    }
  };
  const markDown = (m, reason) => {
    if (!m.up && !m.node) return;
    m.up = false;
    const old = m.node; m.node = null; m.gen++;
    if (old) Promise.resolve().then(() => old.close()).catch(() => {});
    log('NODE_DOWN', {url: m.url, reason});
    pickActive(reason);
    schedule(m);
  };
  const connect = async m => {
    const gen = ++m.gen;
    let node = null;
    try {
      node = await withTimeout(open(m.url), connectTimeoutMs, 'CONNECT');
      if (closed || gen !== m.gen) { try { await node.close(); } catch {} return false; }
      const other = members.find(x => x !== m && x.up);
      if (other && node.identity?.p2pId && other.node.identity?.p2pId === node.identity.p2pId) {
        try { await node.close(); } catch {}
        log('NODE_SAME_BACKEND', {url: m.url, as: other.url, p2pId: node.identity.p2pId});
        m.attempts = Math.max(m.attempts, replaceAfter);          // not a standby at all: replace immediately (pool mode)
        return false;
      }
      node.on('utxos', data => { if (m.node === node) emit('utxos', data, m.url); });
      node.on('disconnect', () => { if (m.node === node) markDown(m, 'SOCKET_DISCONNECTED'); });
      if (subs.size) await withTimeout(node.subscribeUtxosChanged([...subs]), connectTimeoutMs, 'SUBSCRIBE');
      if (closed || gen !== m.gen) { try { await node.close(); } catch {} return false; }
      m.node = node; m.up = true; m.attempts = 0;
      log('NODE_UP', {url: m.url, identity: node.identity, subscriptions: subs.size});
      pickActive('NODE_UP');
      return true;
    } catch (e) {
      if (node) { try { await node.close(); } catch {} }
      log('NODE_CONNECT_FAILED', {url: m.url, attempt: m.attempts || 1, message: String(e?.message ?? e)});
      return false;
    }
  };
  const schedule = m => {
    if (closed || m.timer || m.up) return;
    const ms = reconnectMs[Math.min(m.attempts, reconnectMs.length - 1)];
    m.attempts++;
    m.timer = setTimer(async () => {
      m.timer = null;
      if (pickReplacement && m.attempts > replaceAfter) {
        const other = members.find(x => x !== m);
        let next = null;
        try { next = await pickReplacement({failedUrl: m.url, avoidP2pIds: other?.up ? [other.node.identity?.p2pId].filter(Boolean) : [], avoidUrls: [m.url, other?.url].filter(Boolean)}); }
        catch (e) { log('NODE_REPLACEMENT_FAILED', {url: m.url, message: String(e?.message ?? e)}); }
        if (closed) return;
        if (next && next !== m.url && next !== other?.url) { log('NODE_REPLACED', {from: m.url, to: next}); m.url = next; m.attempts = 1; }
      }
      if (!(await connect(m))) schedule(m);
    }, ms);
    m.timer?.unref?.();
  };

  // Start: both in parallel; succeed as soon as one is up (the other keeps retrying in the background).
  const first = await Promise.all(members.map(m => connect(m)));
  members.forEach((m, i) => { if (!first[i]) schedule(m); });
  if (!active) { closed = true; members.forEach(m => m.timer && clearTimer(m.timer)); throw Error('NO_NODE_AVAILABLE'); }
  const beat = heartbeatMs ? setRepeat(() => {
    for (const m of members) {
      const node = m.node;
      if (!m.up || !node) continue;
      withTimeout(node.getSinkBlueScore(), connectTimeoutMs, 'HEARTBEAT')
        .catch(e => { if (m.node === node) markDown(m, 'HEARTBEAT:' + String(e?.message ?? e).slice(0, 80)); });
    }
  }, heartbeatMs) : null;
  beat?.unref?.();

  /** Run fn on the active member; on a transport error mark it down and retry once on the other member. */
  const onActive = async (name, fn) => {
    for (let pass = 0; pass < 2; pass++) {
      const m = active;
      if (!m) throw Error('NO_NODE_AVAILABLE');
      try { return await fn(m.node); }
      catch (e) {
        const msg = String(e?.message ?? e);
        if (!/WebSocket|not connected|disconnected|CONNECT_TIMEOUT/i.test(msg)) throw e;   // RPC-level errors are answers
        markDown(m, name + ':' + msg.slice(0, 80));
      }
    }
    throw Error('NO_NODE_AVAILABLE');
  };
  const both = async (what, addrs) => {
    const live = members.filter(m => m.up);
    const res = await Promise.allSettled(live.map(m => m.node[what](addrs)));
    res.forEach((r, i) => { if (r.status === 'rejected') markDown(live[i], what + ':' + String(r.reason?.message ?? r.reason).slice(0, 80)); });
    if (!res.some(r => r.status === 'fulfilled')) throw Error('NO_NODE_AVAILABLE');
  };

  const dual = {
    get identity() { return active?.node.identity ?? null; },
    get url() { return active?.url ?? null; },
    status: () => members.map(m => ({url: m.url, up: m.up, active: m === active, attempts: m.attempts, nodeId: m.node?.identity?.nodeId ?? null})),
    on(kind, fn) { handlers[kind].push(fn); },
    verify: () => onActive('verify', n => n.verify()),
    subscribeUtxosChanged: async addrs => { addrs.forEach(a => subs.add(a)); await both('subscribeUtxosChanged', addrs); },
    unsubscribeUtxosChanged: async addrs => { addrs.forEach(a => subs.delete(a)); await both('unsubscribeUtxosChanged', addrs); },
    close: async () => {
      closed = true;
      if (beat) clearRepeat(beat);
      for (const m of members) { if (m.timer) clearTimer(m.timer); m.timer = null; m.gen++; const n = m.node; m.node = null; m.up = false; if (n) { try { await n.close(); } catch {} } }
      active = null;
    },
  };
  for (const name of QUERY) dual[name] = r => onActive(name, n => n[name](r));
  return dual;
}
