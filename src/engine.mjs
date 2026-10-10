// Event-driven covenant-lineage follower core (contract rules come from plugins, see contracts.mjs). RPC-agnostic (a `node` object is injected) so it is testable offline.
// Truth = selected-chain acceptance + covenant rules. This cache never decides entitlement.
import {checkRound} from './contracts.mjs';
import {scanWindow, spendsOutpoint} from './window-scan.mjs';
import {canonical, outpointKey, spends, relatedTransaction, isFullTransaction, prepareTransaction, normalizeUtxo, sameSpk, wireSpk, txidOf} from './normalize.mjs';

export const DEFAULTS = Object.freeze({
  network: 'testnet-10',
  checkpointKeep: 720,            // ~36 min at 3 s
  checkpointsPerSearch: 3,
  // No fixed page cap: measured ~200 blocks/s getBlocks (~20x TN10 production) and ~1,900 chain blocks/s v1 VC,
  // so a scan always converges to the sink. Only a wall-clock budget stops it (then PENDING and retry).
  scanBudgetMs: 600000,
  finalityBlueScore: 600n,        // project policy, NOT a consensus finality rule
  genesisLookbackMs: 30000,
  nearCheckpointMs: 15000,
  // Fast path: one V2 Full page from a checkpoint shortly before the event gives spender, accepting header and the
  // accepted full transaction in one RPC. Any miss/error falls back to the slow path below. Measured 2026-09-30
  // (TN10, vector-10/muon-10): ~0.8-2.4 s for 40-150 chain blocks; RTT ~0.3 s per call.
  fastLookbackMs: 10000,
  fastMaxAgeMs: 30000,            // older start -> page too large for the 192 MB heap (VPS); use slow path
  fastMaxPages: 2,
  // Bounded fallback (2026-10-10): accepted-transaction pages of at most this many blue score, one page in memory at a
  // time (measured TN10 under load: ~100 blue = 60 chain blocks, ~1.7 MB JSON, ~30 ms). Replaces the getBlocks body scan
  // whose 6+ MB pages (plus cache) exhausted the 192 MB VPS heap when started hours back (2026-10-09 incident).
  windowBlue: 100n,
  windowSliceMs: 20000,           // max time one resolveSpend holds the serial queue in the window walk
  windowWorkerHeapMb: 96,        // child process heap cap; measured adaptive-page heap peak ~54 MB in a spam burst
  windowWorkerPages: 200,        // pages per child process (one process = one memory high-water, then returned)
  pendingMaxMs: 15 * 60 * 1000,
});

export {actionOf} from '../contracts/kaswin-f3.mjs';   // compatibility re-export

export class Engine {
  constructor({store, contracts, node, addressOf, config = {}, now = () => Date.now(), log = () => {}}) {
    Object.assign(this, {store, contracts, node, addressOf, now, log});
    this.config = {...DEFAULTS, ...config};
    this.subs = new Map();          // address -> refcount
    this.queue = Promise.resolve();
    this.scheduled = new Set();
    this.pending = new Map();       // key -> {since, kind, id, hint}
    this.errors = 0;
  }

  // ---------- lifecycle ----------
  async start() {
    // Every stored round must still have its own contract plugin loaded; never re-interpret it with another one.
    for (const r of this.store.rounds()) if (r.status === 'LIVE' && !this.contracts.has(r.contract)) throw Error('LIVE_ROUND_CONTRACT_NOT_LOADED ' + r.id + ' ' + r.contract);
    for (const a of this.contracts.watchAddresses()) await this.subscribe(a);
    for (const r of this.store.rounds({liveOnly: true})) await this.subscribe(r.address);
    await this.initializeDiscoveryScan();
    await this.checkpoint();
    await this.reconcile();
    this.retryPending();
  }
  /** After reconnect (resolver may pick another node): server-side subscriptions are gone. */
  async resubscribeAll() {
    const addrs = [...this.subs.keys()];
    if (addrs.length) await this.node.subscribeUtxosChanged(addrs);
    if (this.chainSubscribed && this.node.subscribeVirtualChainChanged) { try { await this.node.subscribeVirtualChainChanged(); } catch {} }
    await this.reconcile();
    await this.checkFinality();   // reorgs that happened while disconnected
  }
  run(key, fn) {
    if (this.scheduled.has(key)) return this.queue;
    this.scheduled.add(key);
    this.queue = this.queue.then(async () => {
      this.scheduled.delete(key);
      try { await fn(); } catch (e) {
        this.errors++;
        this.store.log('ERROR', {key, message: String(e?.message ?? e)}, this.now());
        this.log('ERROR', key, e?.message ?? e);
      }
    });
    return this.queue;
  }
  idle() { return this.queue; }

  // ---------- subscriptions ----------
  async subscribe(address) {
    if (!address) return;
    const n = this.subs.get(address) ?? 0;
    if (n === 0) await this.node.subscribeUtxosChanged([address]);
    this.subs.set(address, n + 1);
  }
  async unsubscribe(address) {
    const n = this.subs.get(address) ?? 0;
    if (n <= 1) { this.subs.delete(address); if (n === 1) await this.node.unsubscribeUtxosChanged([address]); }
    else this.subs.set(address, n - 1);
  }

  // ---------- events ----------
  onUtxosChanged(data) {
    const at = this.now();
    const tips = new Map(this.store.rounds({liveOnly: true}).map(r => [outpointKey(r.data.tip), r.id]));
    for (const raw of data?.removed ?? []) {
      const u = normalizeUtxo(raw), id = tips.get(outpointKey(u.outpoint));
      if (id) { this.store.log('SPENT_EVENT', {round: id, outpoint: u.outpoint}, at); this.store.markTipSpent(id, u.outpoint, at); this.run('spend:' + id, () => this.resolveSpend(id, at)); }
    }
    for (const raw of data?.added ?? []) {
      const u = normalizeUtxo(raw);
      for (const p of this.contracts.forGenesis()) {
        const txid = p.discover(u);
        if (!txid || this.store.round(txid)) continue;
        this.store.log('DISCOVERY_MARKER', {contract: p.key, txid, daa: String(u.blockDaaScore)}, at);
        const task = this.store.discoverTask(txid, {eventAt: at, daa: String(u.blockDaaScore)}, at);
        if (task.status === 'PENDING') this.run('genesis:' + txid, () => this.discoverGenesis(txid));
      }
    }
  }

  async initializeDiscoveryScan() {
    if (this.store.getMeta('discoveryScan')) return;
    const oldest = this.store.db.prepare('SELECT sink FROM checkpoints ORDER BY at LIMIT 1').get()?.sink;
    const cursor = oldest ?? String((await this.node.getBlockDagInfo()).sink);
    this.store.setMeta('discoveryScan', {cursor, anchor: cursor, status: 'READY', at: this.now(), error: null});
  }
  async scanDiscoveries() {
    await this.initializeDiscoveryScan();
    const state = this.store.getMeta('discoveryScan');
    try {
      const r = await this.node.getVirtualChainFromBlockV2({startHash: state.cursor, dataVerbosityLevel: 'High', minConfirmationCount: 0});
      const added = (r.addedChainBlockHashes ?? []).map(String), rows = r.chainBlockAcceptedTransactions ?? [];
      if (rows.length !== added.length) throw Error('DISCOVERY_ROWS_NOT_ALIGNED');
      const removed = new Set((r.removedChainBlockHashes ?? []).map(String));
      const undo = this.store.db.prepare("SELECT round_id,MIN(seq) seq FROM transitions WHERE status!='ROLLED_BACK' GROUP BY round_id").all();
      for (const x of undo) {
        const first = this.store.transitions(x.round_id).find(t => t.status !== 'ROLLED_BACK' && removed.has(t.accepting));
        if (first) await this.rollback(first);
      }
      const candidates = [];
      for (let i = 0; i < rows.length; i++) {
        if (String(rows[i].chainBlockHeader?.hash) !== added[i]) throw Error('DISCOVERY_HEADER_MISMATCH');
        for (const tx of rows[i].acceptedTransactions ?? []) {
          if (!this.contracts.forGenesis().some(p => p.candidateGenesis?.(tx))) continue;
          const id = txidOf(tx);
          if (!/^[0-9a-f]{64}$/.test(id ?? '')) throw Error('DISCOVERY_TXID_MISSING');
          candidates.push({id, starts: [i ? added[i - 1] : state.cursor]});
        }
      }
      // A removal-only response needs a valid common-ancestor cursor, never silently keep a removed tip.
      if (removed.size && !added.length) throw Error('DISCOVERY_REMOVAL_WITHOUT_NEW_CURSOR');
      this.store.tx(() => {
        for (const c of candidates) {
          this.store.discoverTask(c.id, {starts: c.starts, eventAt: this.now()}, this.now());
          if (this.store.round(c.id)?.status === 'ROLLED_BACK' || this.store.discovery(c.id)?.status === 'IGNORED')
            this.store.discoveryResult(c.id, 'PENDING', this.now());
        }
        this.store.setMeta('discoveryScan', {...state, cursor: added.at(-1) ?? state.cursor, status: 'SCANNING', at: this.now(), error: null});
      });
      this.retryPending();
    } catch (e) {
      this.store.setMeta('discoveryScan', {...state, status: 'GAP', at: this.now(), error: String(e?.message ?? e)});
      throw e;
    }
  }

  // ---------- checkpoints ----------
  async checkpoint() {
    const d = await this.node.getBlockDagInfo();
    const c = {at: this.now(), sink: String(d.sink), virtualDaa: BigInt(d.virtualDaaScore)};
    this.store.addCheckpoint(c, this.config.checkpointKeep);
    return c;
  }
  /** Candidate start hashes: checkpoints recorded while the tip was known live, then the round's own accepting block. */
  startsFor(rec, eventAt = null) {
    // Fast path: a checkpoint shortly before the event (spend inclusion precedes the notification by seconds).
    // Safe fallbacks: checkpoint while the tip was known live, then the round's own accepting block.
    const near = eventAt ? this.store.checkpointsBefore(eventAt - this.config.nearCheckpointMs, 1).map(c => c.sink) : [];
    const before = rec.liveSeenAt ?? 0;
    const cps = before ? this.store.checkpointsBefore(before + 1, 1).map(c => c.sink) : [];
    return [...new Set([...near, ...cps, rec.data.accepting].filter(Boolean))];
  }

  // ---------- fast path (V2 Full) ----------
  /** Newest checkpoint recorded before `eventAt - fastLookbackMs`, if recent enough for a small page. */
  fastStart(eventAt) {
    const cp = this.store.checkpointsBefore(eventAt - this.config.fastLookbackMs, 1)[0];
    // Age is checked against NOW as well: a deferred spend is retried every 5 s with its original eventAt, and the Full
    // page from that fixed checkpoint grows ~10 chain blocks/s (measured 2026-10-10: 400 blocks = +134 MB RSS; retries
    // pushed the VPS-limit replay to 340 MB). Retries past the window use the bounded window walk instead.
    return cp && eventAt - cp.at <= this.config.fastMaxAgeMs && this.now() - cp.at <= this.config.fastMaxAgeMs ? cp.sink : null;
  }
  /**
   * Walk the virtual selected chain from `start` with V2 Full and return the first accepted transaction matching `match`.
   * Returns null when the chain up to the sink observed at call time has been scanned without a hit (caller falls back).
   * Termination is by blue score, never by a captured sink hash (that block can be reorged off the chain at 10 BPS).
   */
  async fastFind(match, start) {
    const sinkBlue = BigInt((await this.node.getSinkBlueScore()).blueScore);
    let from = start;
    for (let page = 0; page < this.config.fastMaxPages; page++) {
      const r = await this.node.getVirtualChainFromBlockV2({startHash: from, dataVerbosityLevel: 'Full', minConfirmationCount: 0});
      const added = (r.addedChainBlockHashes ?? []).map(String), rows = r.chainBlockAcceptedTransactions ?? [];
      const removed = (r.removedChainBlockHashes ?? []).length > 0;
      if (rows.length !== added.length) throw Error('VC_ROWS_NOT_ALIGNED');
      for (let i = 0; i < rows.length; i++) {
        const h = rows[i].chainBlockHeader;
        if (String(h?.hash) !== added[i]) throw Error('VC_HEADER_MISMATCH');
        for (const t of rows[i].acceptedTransactions ?? []) {
          if (!match(t)) continue;
          if (h.daaScore == null || h.blueScore == null) throw Error('VC_HEADER_FIELDS_MISSING');
          const tx = canonical(t);
          const containing = tx.verboseData?.blockHash ? String(tx.verboseData.blockHash) : null;
          if (!txidOf(tx) || !containing) throw Error('VC_FULL_ROW_INCOMPLETE');
          return {acc: {hash: added[i], daa: BigInt(h.daaScore), blueScore: BigInt(h.blueScore), isChain: true,
            selectedParent: i ? added[i - 1] : removed ? null : String(from)}, tx, containing};
        }
      }
      const top = rows.length && rows.at(-1).chainBlockHeader?.blueScore != null ? BigInt(rows.at(-1).chainBlockHeader.blueScore) : null;
      if (!added.length || top === null || top >= sinkBlue) return null;
      from = added.at(-1);
    }
    return null;
  }
  /**
   * Bounded fallback: find the accepted spender of `tip` on the selected chain after `start`, in windows of <= windowBlue
   * blue score (V2 High; version/lockTime are hydrated from the containing block afterwards). Returns {acc, tx, containing}
   * or null when scanned up to the sink observed at call time. Runs at most windowSliceMs per call so the serial engine
   * queue (events, reorg rollbacks, other rounds) is never held for long: then it saves a durable per-start cursor under
   * `resumeKey` and throws WINDOW_SCAN_CONTINUES; the caller defers and the 5 s retry resumes from the cursor. Throws
   * WINDOW_START_NOT_CHAIN if `start` left the selected chain. Nothing is guessed.
   * With a URL-addressable node the walk runs in short-lived child processes of at most windowWorkerPages pages each
   * (memory returned on exit, see window-scan.mjs); otherwise in-process (tests, resolver mode).
   */
  async windowFind(tip, start, resumeKey = null) {
    const sinkBlue = BigInt((await this.node.getSinkBlueScore()).blueScore), until = this.now() + this.config.windowSliceMs;
    // Resume an earlier slice: cursors are kept per start; used only if still a selected-chain block, else start over.
    // A cursor is a position hint only, never evidence.
    const saved = resumeKey ? this.store.getMeta(resumeKey)?.[start] : null;
    let cur = {from: start, fromBlue: (await this.header(start)).blueScore};
    if (typeof saved?.from === 'string') {
      try { const h = await this.header(saved.from); if (h.isChain) cur = {from: saved.from, fromBlue: h.blueScore, w: saved.w ? BigInt(saved.w) : null}; } catch {}
    }
    const save = v => {
      if (!resumeKey) return;
      const all = {...(this.store.getMeta(resumeKey) ?? {})};
      if (v) all[start] = v; else delete all[start];
      this.store.setMeta(resumeKey, Object.keys(all).length ? all : null);
    };
    const mark = () => save({from: cur.from, w: cur.w != null ? String(cur.w) : null, at: this.now()});
    for (;;) {
      if (this.now() > until) { mark(); throw Error('WINDOW_SCAN_CONTINUES'); }
      const args = {tip, ...cur, sinkBlue, windowBlue: this.config.windowBlue};
      let r;
      try {
        r = this.node.url && this.config.windowWorkerPages
          ? await this.windowChunk({...args, url: this.node.url, network: this.config.network, maxPages: this.config.windowWorkerPages, budgetMs: Math.max(1, until - this.now())})
          : await scanWindow(this.node, {match: t => spendsOutpoint(t, tip), ...cur, sinkBlue, windowBlue: this.config.windowBlue, until, now: this.now});
      } catch (e) {
        if (/WINDOW_START_NOT_CHAIN/.test(String(e?.message))) save(null); else mark();
        throw e;
      }
      if (r.found) return r.found;
      if (r.done) { save(null); return null; }
      cur = r.cursor; mark();
    }
  }
  /**
   * One chunk in a short-lived child process (bigint fields cross as strings). A process, not a worker thread: measured
   * 2026-10-10, repeated worker threads left the parent at 391 MB RSS (freed native memory not returned to the OS),
   * above the unit's MemoryMax=320M; a child process returns everything on exit. Rejects with the child's error.
   */
  async windowChunk(a) {
    const {fork} = await import('node:child_process');
    const child = fork(new URL('./window-worker.mjs', import.meta.url), [], {
      execArgv: [`--max-old-space-size=${this.config.windowWorkerHeapMb}`], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: {...process.env, NODE_NO_WARNINGS: '1'}, serialization: 'json'});
    let stderr = '';
    child.stderr.on('data', d => { if (stderr.length < 400) stderr += d; });
    let settle;
    const done = new Promise((resolve, reject) => { settle = {resolve, reject}; });
    // Permanent listeners: an error/exit after settling must never become unhandled.
    const timer = setTimeout(() => settle.reject(Error('WINDOW_WORKER_TIMEOUT')), a.budgetMs + 30_000);
    child.on('message', x => settle.resolve(x));
    child.on('error', e => settle.reject(Error('WINDOW_WORKER_' + (e?.code ?? 'ERROR'))));
    child.on('exit', (code, sig) => settle.reject(Error(`WINDOW_WORKER_EXIT_${code ?? sig}${/heap out of memory/i.test(stderr) ? '_OOM' : ''}`)));
    try {
      child.send({...a, fromBlue: String(a.fromBlue), sinkBlue: String(a.sinkBlue), windowBlue: String(a.windowBlue), w: a.w != null ? String(a.w) : null});
      const m = await done;
      if (!m.ok) throw Error(m.message);
      return reviveWindow(m.r);
    } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
  }
  async tryFast(label, match, start) {
    if (!start) return null;
    try { return await this.fastFind(match, start); }
    catch (e) { this.store.log('FAST_PATH_FAILED', {label, start, message: String(e?.message ?? e)}, this.now()); return null; }
  }

  // ---------- spend discovery ----------
  async fromMempool(address, tip, cid = null) {
    let res;
    try { res = await this.node.getMempoolEntriesByAddresses({addresses: [address], includeOrphanPool: false, filterTransactionPool: false}); }
    catch (e) { this.store.log('MEMPOOL_QUERY_FAILED', {message: String(e?.message ?? e)}, this.now()); return []; }
    // Fixed rusty-kaspa returns [{address, sending[], receiving[]}]; the SDK .d.ts shows a flat list. Accept both.
    const entries = (res?.entries ?? []).flatMap(e => e?.transaction ? [e] : [...(e?.sending ?? []), ...(e?.receiving ?? [])]);
    const out = new Map();
    for (const e of entries) {
      if (e.isOrphan) continue;
      if (!relatedTransaction(e.transaction, tip, cid) || !spends(e.transaction, tip) || !txidOf(e.transaction)) continue;
      const tx = prepareTransaction(e.transaction);
      if (txidOf(tx)) out.set(txidOf(tx), {txid: txidOf(tx), tx, containing: null, source: 'mempool'});
    }
    return [...out.values()];
  }
  async header(hash) {
    const b = (await this.node.getBlock({hash, includeTransactions: false})).block;
    return {hash, daa: BigInt(b.header.daaScore), blueScore: BigInt(b.header.blueScore), isChain: b.verboseData?.isChainBlock === true,
      selectedParent: b.verboseData?.selectedParentHash ? String(b.verboseData.selectedParentHash) : null};
  }
  /** Selected-chain acceptance of txid, searched forward from a hash known to precede the spend. */
  async acceptance(txid, starts) {
    // Bound the scan to the sink observed now; otherwise at 10 BPS each round-trip adds blocks and we chase the tip.
    // Stop on the captured sink hash OR on blue score: the captured sink may be reorged off the chain, then only the
    // blue-score bound terminates (2026-09-30 fix; the old short-page rule stopped after one page and gave false negatives).
    const sink = String((await this.node.getBlockDagInfo()).sink);
    const sinkBlue = BigInt((await this.node.getSinkBlueScore()).blueScore);
    let scanned = false;
    for (const start of starts) {
      let from = start;
      try {
        const until = this.now() + this.config.scanBudgetMs;
        for (;;) {
          if (this.now() > until) throw Error('VC_SCAN_BUDGET_EXCEEDED');
          const r = await this.node.getVirtualChainFromBlock({startHash: from, includeAcceptedTransactionIds: true});
          const added = r.addedChainBlockHashes ?? [], ids = r.acceptedTransactionIds ?? [];
          if (ids.length !== added.length) throw Error('VC_ROWS_NOT_ALIGNED');
          for (const row of ids) if ((row.acceptedTransactionIds ?? []).includes(txid)) {
            const h = await this.header(String(row.acceptingBlockHash));
            if (!h.isChain) throw Error('ACCEPTING_NOT_CHAIN');
            return h;
          }
          if (!added.length || added.map(String).includes(sink) || start === sink) break;
          if ((await this.header(String(added.at(-1)))).blueScore >= sinkBlue) break;
          from = String(added.at(-1));
        }
        scanned = true;        // scanned to sink from this start: not accepted after it; try an older start
      } catch (e) { this.store.log('VC_QUERY_FAILED', {start, message: String(e?.message ?? e)}, this.now()); }
    }
    if (scanned) return null;
    throw Error('ACCEPTANCE_UNKNOWN_ALL_STARTS_FAILED');
  }
  async liveUtxo(address, outpoint) {
    const r = await this.node.getUtxosByAddresses({addresses: [address]});
    const hit = (r.entries ?? []).map(normalizeUtxo).find(u => outpointKey(u.outpoint) === outpointKey(outpoint));
    return hit ?? null;
  }

  /** The latest ROLLED_BACK transition that spent the current live tip: after a selected-chain reorg its spender is the
   * prime candidate on the new chain. Durable (read from the DB), so it survives a restart. */
  rolledBackSpend(rec) {
    const tip = outpointKey(rec.data.tip);
    return this.store.transitions(rec.id).filter(t => t.status === 'ROLLED_BACK' && t.previous?.tip && outpointKey(t.previous.tip) === tip &&
      t.next?.latestTransaction && t.next.latestTxid === t.txid).at(-1) ?? null;
  }
  /** First selected-chain block at or above `hash` by selected parents (bounded). Null if not found within the bound. */
  async chainAncestor(hash, limit = 256) {
    for (let i = 0; i < limit && hash; i++) {
      const h = await this.header(hash);
      if (h.isChain) return hash;
      hash = h.selectedParent;
    }
    return null;
  }
  /**
   * Re-resolution after a rollback. The rolled-back spender was accepted in a block whose selected-chain ancestor `start`
   * is still on the chain, and the tip was unspent at `start`; so every spender on the current chain comes after `start`.
   * Check the known spender with the light v1 acceptance scan (ids only) from `start`; never fall back to a getBlocks scan
   * from the round's own (possibly hours old) accepting block, which exhausts the VPS heap under load (2026-10-09 incident).
   */
  async replayRolledBack(rec, hint) {
    const start = await this.chainAncestor(hint.accepting);
    if (!start) return {start: null};
    const acc = await this.acceptance(hint.txid, [start]);
    if (!acc) return {start};
    const tx = prepareTransaction(hint.next.latestTransaction);
    if (txidOf(tx) !== hint.txid || !isFullTransaction(tx) || !spends(tx, rec.data.tip)) throw Error('ROLLED_BACK_SPENDER_INVALID');
    this.store.log('ROLLBACK_REPLAY', {round: rec.id, txid: hint.txid, from: start, accepting: acc.hash}, this.now());
    const chosen = await this.bindAccepted({txid: hint.txid, tx, containing: null, source: 'rolled-back-replay'}, acc);
    return {start, applied: await this.applySpend(rec, chosen, acc)};
  }

  async resolveSpend(roundId, eventAt = this.now()) {
    const rec = this.store.round(roundId);
    if (!rec || rec.status !== 'LIVE') return 'NOT_LIVE';
    const tip = rec.data.tip;
    let replayStart = null;
    const hint = this.rolledBackSpend(rec);
    if (hint) {
      const r = await this.replayRolledBack(rec, hint);
      if (r.applied) { this.pending.delete('spend:' + roundId); return r.applied; }
      replayStart = r.start;
    }
    const fast = await this.tryFast('spend:' + roundId, t => spendsLoose(t, tip), this.fastStart(eventAt));
    if (fast) {
      this.pending.delete('spend:' + roundId);
      const tx = {...fast.tx, verboseData: {...fast.tx.verboseData, blockHash: fast.containing}};
      if (!isFullTransaction(tx)) throw Error('CANDIDATE_MISSING_CONSENSUS_FIELDS');
      return this.applySpend(rec, {txid: txidOf(tx), tx, containing: fast.containing, source: 'vc-full'}, fast.acc);
    }
    const starts = replayStart ? [replayStart] : this.startsFor(rec, eventAt);
    let candidates = await this.fromMempool(rec.address, tip, rec.data.cid);
    if (!candidates.length) {
      // Bounded accepted-chain walk (replaces the getBlocks body scan): newest start first, older starts only if needed.
      let failed = 0;
      for (const hint of starts) {
        let w;
        // A start that left the selected chain (reorged checkpoint) is replaced by its selected-chain ancestor: that block
        // is in its past, so it still precedes the spend and the scan from it is a superset.
        const start = await this.chainAncestor(hint).catch(() => null);
        if (!start) { failed++; this.store.log('WINDOW_SCAN_FAILED', {start: hint, message: 'NO_CHAIN_ANCESTOR'}, this.now()); continue; }
        try { w = await this.windowFind(tip, start, `window:${roundId}`); }
        catch (e) {
          const message = String(e?.message ?? e);
          // A slice ended with progress saved: yield the queue now and resume this same start on the next retry.
          if (message === 'WINDOW_SCAN_CONTINUES') return this.defer('spend:' + roundId, {kind: 'spend', id: roundId}, 'WINDOW_SCAN_CONTINUES');
          failed++; this.store.log('WINDOW_SCAN_FAILED', {start, message}, this.now()); continue;
        }
        if (!w) continue;
        this.pending.delete('spend:' + roundId); this.store.setMeta(`window:${roundId}`, null);   // all starts' cursors
        let tx = {...w.tx, verboseData: {...w.tx.verboseData, blockHash: w.containing}}, source = 'vc-window';
        if (!isFullTransaction(tx)) { tx = await this.hydrate(tx); source += '+block'; }
        const chosen = await this.bindAccepted({txid: txidOf(tx), tx, containing: w.containing, source}, w.acc);
        return this.applySpend(rec, chosen, w.acc);
      }
      if (failed === starts.length) return this.defer('spend:' + roundId, {kind: 'spend', id: roundId}, 'WINDOW_SCAN_FAILED');
    }
    if (!candidates.length) {
      const live = await this.liveUtxo(rec.address, tip);
      if (live) { this.store.markLiveSeen(roundId, this.now()); this.pending.delete('spend:' + roundId); return 'STILL_LIVE'; }
      return this.defer('spend:' + roundId, {kind: 'spend', id: roundId}, 'SPENDER_NOT_FOUND');
    }
    let chosen = null, acc = null;
    for (const c of candidates) { acc = await this.acceptance(c.txid, c.start ? [c.start] : starts); if (acc) { chosen = c; break; } }
    if (!chosen) return this.defer('spend:' + roundId, {kind: 'spend', id: roundId}, 'NOT_YET_ACCEPTED', candidates.map(c => c.txid));
    this.pending.delete('spend:' + roundId);
    if (!isFullTransaction(chosen.tx)) throw Error('CANDIDATE_MISSING_CONSENSUS_FIELDS');
    chosen = await this.bindAccepted(chosen, acc);
    return this.applySpend(rec, chosen, acc);
  }

  async applySpend(rec, chosen, acc) {
    const plugin = this.contracts.get(rec.contract);           // the rules this round was created under
    let next;
    try { next = checkRound(plugin.advance(rec.data, chosen.tx, {hash: acc.hash, daa: String(acc.daa)}), plugin.key); }
    catch (e) { const r = this.markStale(rec, chosen, acc, e); await this.unsubscribe(rec.address); return r; }
    if (next.id !== rec.id) { const r = this.markStale(rec, chosen, acc, Error('PLUGIN_CHANGED_ROUND_ID')); await this.unsubscribe(rec.address); return r; }
    // Consumers must still see which block actually included the transaction when known.
    next = {...next, containing: chosen.containing};
    return this.commit(rec, next, chosen, acc, safeKind(plugin, chosen.tx), plugin.key);
  }

  async commit(rec, next, chosen, acc, kind, contract) {
    const nextAddress = next.tip ? this.addressOf(next.spk) : null;
    if (nextAddress) await this.subscribe(nextAddress);           // subscribe first: no notification gap
    let utxoCheck;
    if (next.tip) {
      const u = await this.liveUtxo(nextAddress, next.tip);
      if (u) {
        const ok = u.amount === BigInt(next.value) && sameSpk(u.spk, wireSpk(next.spk)) && u.covenantId === next.cid && u.blockDaaScore === acc.daa;
        if (!ok) { await this.unsubscribe(nextAddress); throw Error('SUCCESSOR_UTXO_MISMATCH'); }
        utxoCheck = 'SUCCESSOR_LIVE_MATCHES';
      } else utxoCheck = 'SUCCESSOR_NOT_LIVE_(ALREADY_SPENT_OR_INDEX_LAG)';
    } else {
      if (rec && await this.liveUtxo(rec.address, rec.data.tip)) throw Error('TERMINAL_BUT_TIP_STILL_LIVE');
      utxoCheck = 'TERMINAL_OLD_TIP_GONE';
    }
    const now = this.now();
    let seq = null;
    const transition = {txid: chosen.txid, roundId: next.id, contract, seq, kind, status: 'ACCEPTED', accepting: acc.hash, acceptingDaa: acc.daa,
      acceptingBlueScore: acc.blueScore, containing: chosen.containing, previous: rec?.data ?? null, next,
      evidence: {source: chosen.source, utxoCheck, witnessSource: chosen.source === 'mempool' ? 'MEMPOOL_COPY_TXID_MATCH' : 'BLOCK_BODY'}, observedAt: now};
    // Idempotent: a txid already applied to this round (e.g. a concurrent discovery of the same Genesis) is not re-applied.
    let duplicate = null;
    this.store.tx(() => {
      duplicate = this.store.activeTransition(next.id, chosen.txid);
      if (duplicate) return;
      transition.seq = seq = this.store.lastSeq(next.id) + 1;      // allocated inside the write transaction
      this.store.putRound(next, nextAddress, now, contract);
      if (utxoCheck === 'SUCCESSOR_LIVE_MATCHES') this.store.markLiveSeen(next.id, now);
      this.store.addTransition(transition);
      if (kind === 'GENESIS') this.store.discoveryResult(next.id, 'APPLIED', now);
      this.store.enqueue(this.relayPayload('transition', transition, nextAddress), now);
    });
    if (duplicate) {
      if (nextAddress) await this.unsubscribe(nextAddress);          // balance the subscribe above
      this.store.log('DUPLICATE_SKIPPED', {round: next.id, txid: chosen.txid, existingSeq: duplicate.seq}, now);
      return 'KNOWN';
    }
    if (rec?.address && rec.status === 'LIVE') await this.unsubscribe(rec.address);
    this.store.log('APPLIED', {round: next.id, seq, kind, txid: chosen.txid, accepting: acc.hash, utxoCheck}, now);
    if (next.tip && utxoCheck !== 'SUCCESSOR_LIVE_MATCHES') this.run('spend:' + next.id, () => this.resolveSpend(next.id));
    return 'APPLIED';
  }

  markStale(rec, chosen, acc, error) {
    const now = this.now(), message = String(error?.message ?? error);
    this.store.tx(() => {
      this.store.db.prepare("UPDATE rounds SET status='STALE', updated_at=? WHERE id=?").run(now, rec.id);
      this.store.enqueue({schema: 'kaswin-event-indexer/1', type: 'stale', network: this.config.network, roundId: rec.id,
        contract: rec.contract, txid: chosen.txid, accepting: acc.hash, error: message, note: 'Accepted spend did not match the pinned contract plugin rules; state NOT advanced'}, now);
      this.store.log('STALE', {round: rec.id, txid: chosen.txid, message}, now);
    });
    return 'STALE';
  }

  defer(key, info, reason, candidates = []) {
    if (info.kind === 'genesis') {
      this.store.discoveryResult(info.id, 'PENDING', this.now(), reason);
      return 'PENDING';
    }
    const p = this.pending.get(key) ?? {...info, since: this.now()};
    p.reason = reason; p.candidates = candidates; this.pending.set(key, p);
    if (this.now() - p.since > this.config.pendingMaxMs) {
      this.pending.delete(key);
      this.store.log('PENDING_EXPIRED', {key, reason, candidates}, this.now());
      return 'EXPIRED';
    }
    return 'PENDING';
  }
  retryPending() {
    for (const p of this.store.pendingDiscoveries()) this.run('genesis:' + p.id, () => this.discoverGenesis(p.id));
    for (const [key, p] of this.pending) {
      if (p.kind === 'spend') this.run(key, () => this.resolveSpend(p.id, p.since));
      else this.run(key, () => this.discoverGenesis(p.id, p.hint));
    }
  }

  // ---------- genesis discovery (registry marker event or manual track) ----------
  async discoverGenesis(txid, hint = {}) {
    const task = this.store.discoverTask(txid, hint, this.now());
    try {
      const result = await this.discoverGenesisAttempt(txid, task.hint);
      const newerHint = JSON.stringify(this.store.discovery(txid)?.hint) !== JSON.stringify(task.hint);
      this.store.discoveryResult(txid, result === 'KNOWN' || result === 'APPLIED' ? 'APPLIED' : result === 'IGNORED' && !newerHint ? 'IGNORED' : 'PENDING', this.now());
      return result;
    } catch (e) {
      this.store.discoveryResult(txid, 'PENDING', this.now(), String(e?.message ?? e));
      throw e;
    }
  }
  async discoverGenesisAttempt(txid, {eventAt = this.now(), daa = null, starts = null, contract = null} = {}) {
    const existing = this.store.round(txid);
    if (existing && existing.status !== 'ROLLED_BACK') return 'KNOWN';
    // Fast path only for event-driven discovery (no explicit starts): V2 Full row already carries the full accepted tx.
    const fastFrom = starts ? null : this.fastStart(eventAt);
    let found = await this.tryFast('genesis:' + txid, t => t?.verboseData?.transactionId === txid, fastFrom);
    if (found) {
      if (daa != null && BigInt(daa) !== found.acc.daa) {
        const again = await this.tryFast('genesis-recheck:' + txid, t => t?.verboseData?.transactionId === txid, fastFrom);
        this.store.log('REGISTRY_EVENT_DAA_DIFFERENCE', {txid, notificationDaa: String(daa), acceptingDaa: String(found.acc.daa), accepting: found.acc.hash, path: 'fast'}, this.now());
        if (!again || again.acc.hash !== found.acc.hash || again.acc.daa !== found.acc.daa) return 'PENDING';
      }
      if (!isFullTransaction(found.tx)) found = null;          // never guess consensus fields: slow path hydrates
      else { this.pending.delete('genesis:' + txid); return this.applyGenesis(txid, found, contract, found.tx, 'vc-full'); }
    }
    const from = starts ?? this.store.checkpointsBefore(eventAt - this.config.genesisLookbackMs, this.config.checkpointsPerSearch).map(c => c.sink);
    if (!from.length && this.store.getMeta('discoveryScan')?.anchor) from.push(this.store.getMeta('discoveryScan').anchor);
    if (!from.length) return this.defer('genesis:' + txid, {kind: 'genesis', id: txid, hint: {eventAt, daa, starts, contract}}, 'NO_CHECKPOINT');
    const acc = await this.acceptance(txid, from);
    found = acc ? await this.acceptedHigh(txid, acc) : null;
    if (!found) return this.defer('genesis:' + txid, {kind: 'genesis', id: txid, hint: {eventAt, daa, starts, contract}}, 'GENESIS_NOT_FOUND');
    this.pending.delete('genesis:' + txid);
    if (daa != null && BigInt(daa) !== found.acc.daa) {
      const rechecked = await this.acceptance(txid, from);
      this.store.log('REGISTRY_EVENT_DAA_DIFFERENCE', {txid, notificationDaa: String(daa), acceptingDaa: String(found.acc.daa), accepting: found.acc.hash}, this.now());
      if (!rechecked || rechecked.hash !== found.acc.hash || rechecked.daa !== found.acc.daa)
        return 'PENDING';
    }
    return this.applyGenesis(txid, found, contract, null, 'vc-high+block');
  }
  async applyGenesis(txid, found, contract, fullTx, source) {
    const rejected = [];
    const plugins = this.contracts.forGenesis(contract).filter(p => {
      const result = p.inspectGenesis ? p.inspectGenesis(found.tx) : {match: !p.matchesGenesis || p.matchesGenesis(found.tx), reason: 'NO_TEMPLATE_MATCH'};
      if (!result.match) rejected.push({contract: p.key, reason: result.reason});
      return result.match;
    });
    if (!plugins.length) {
      this.store.log('GENESIS_IGNORED', {txid, reason: 'no pinned creation template matched', rejected}, this.now());
      return 'IGNORED';
    }
    const tx = fullTx ?? await this.hydrate(found.tx);
    // Exactly one active plugin may claim a Genesis. Ambiguity is a configuration error, not a choice to make here.
    const b = {hash: found.acc.hash, daa: String(found.acc.daa)}, claims = [];
    for (const p of plugins) { const r = p.genesis(structuredClone(tx), b); if (r) claims.push([p, checkRound(r, p.key)]); }
    if (!claims.length) { this.store.log('GENESIS_IGNORED', {txid, tried: this.contracts.forGenesis(contract).map(p => p.key), reason: 'no loaded contract plugin authenticated this Genesis'}, this.now()); return 'IGNORED'; }
    if (claims.length > 1) throw Error('GENESIS_CLAIMED_BY_MULTIPLE_CONTRACTS ' + claims.map(([p]) => p.key).join(','));
    const [plugin, round] = claims[0];
    if (round.id !== txid) throw Error('PLUGIN_GENESIS_ID_MISMATCH');
    return this.commit(null, round, {txid, tx, containing: found.containing, source}, found.acc, 'GENESIS', plugin.key);
  }
  /**
   * V2 High for exactly one accepting chain block: start at its selected parent and strip the head with
   * minConfirmationCount so the page ends at (or just after) the accepting block. High carries the input UTXO
   * context required by the F3.1 registration check, but not version/lockTime (hydrated separately).
   */
  async acceptedHigh(txid, acc) {
    if (!acc.selectedParent) throw Error('SELECTED_PARENT_MISSING');
    const sink = BigInt((await this.node.getSinkBlueScore()).blueScore), distance = sink - acc.blueScore;
    const minConfirmationCount = distance > 1n ? Number(distance - 1n) : 0;
    const r = await this.node.getVirtualChainFromBlockV2({startHash: acc.selectedParent, dataVerbosityLevel: 'High', minConfirmationCount});
    const added = (r.addedChainBlockHashes ?? []).map(String), rows = r.chainBlockAcceptedTransactions ?? [];
    if (rows.length !== added.length) throw Error('VC_ROWS_NOT_ALIGNED');
    const i = added.indexOf(acc.hash);
    if (i < 0) return null;
    const t = (rows[i].acceptedTransactions ?? []).find(x => x?.verboseData?.transactionId === txid);
    if (!t) throw Error('ACCEPTED_ID_WITHOUT_HIGH_ROW');
    return {acc, tx: canonical(t), containing: t.verboseData.blockHash};
  }
  /**
   * signatureScript is excluded from the v1 txid, so a mempool/block copy with the same txid may carry a different
   * witness than the accepted instance. Bind the candidate to the accepted instance (V2 High row) before parsing.
   */
  async bindAccepted(candidate, acc) {
    const high = await this.acceptedHigh(candidate.txid, acc);
    if (!high) throw Error('ACCEPTED_ROW_NOT_FOUND');
    const strip = rows => rows.map(({verboseData, ...rest}) => rest);
    const same = k => JSON.stringify(k === 'inputs' ? strip(high.tx[k]) : high.tx[k]) === JSON.stringify(k === 'inputs' ? strip(candidate.tx[k]) : candidate.tx[k]);
    let tx = candidate.tx, source = candidate.source;
    if (!['inputs', 'outputs', 'payload'].every(same)) { tx = await this.hydrate(high.tx); source += '+accepted-witness'; }
    tx = {...tx, verboseData: {...tx.verboseData, blockHash: high.containing}};
    tx.inputs = tx.inputs.map((i, n) => high.tx.inputs[n]?.verboseData ? {...i, verboseData: high.tx.inputs[n].verboseData} : i);
    return {...candidate, tx, containing: high.containing, source};
  }
  /** Add version/lockTime from the containing block body after exact comparison of all shared consensus fields. */
  async hydrate(high) {
    const block = (await this.node.getBlock({hash: high.verboseData.blockHash, includeTransactions: true})).block;
    const raw = (block.transactions ?? []).find(t => txidOf(t) === high.verboseData.transactionId);
    if (!raw) throw Error('CONTAINING_TX_MISSING');
    const full = canonical(raw);
    const strip = rows => rows.map(({verboseData, ...rest}) => rest);
    for (const k of Object.keys(high)) {
      if (k === 'verboseData') continue;
      const a = k === 'inputs' ? strip(high[k]) : high[k], b = k === 'inputs' ? strip(full[k]) : full[k];
      if (JSON.stringify(a) !== JSON.stringify(b)) throw Error('HIGH_FULL_MISMATCH_' + k);
    }
    if (full.version === undefined || full.lockTime === undefined) throw Error('FULL_TRANSACTION_FIELDS');
    const merged = {...full, verboseData: high.verboseData};
    merged.inputs = full.inputs.map((i, n) => high.inputs[n]?.verboseData ? {...i, verboseData: high.inputs[n].verboseData} : i);
    return merged;
  }

  // ---------- acceptance maintenance ----------
  async checkFinality() {
    const open = this.store.unfinalized();
    if (!open.length) return;
    const sink = BigInt((await this.node.getSinkBlueScore()).blueScore);
    const rolled = new Set();
    for (const t of open) {
      if (rolled.has(t.roundId)) continue;
      const h = await this.header(t.accepting);
      if (!h.isChain) { await this.rollback(t); rolled.add(t.roundId); continue; }
      if (sink - BigInt(t.acceptingBlueScore) >= this.config.finalityBlueScore) {
        const now = this.now();
        this.store.tx(() => {
          this.store.setTransitionStatus(t.roundId, t.seq, 'FINAL');
          this.store.enqueue(this.relayPayload('final', {...t, status: 'FINAL'}, null), now);
        });
      }
    }
  }
  /** Accepting block left the selected chain: undo this and later transitions, then re-resolve from the chain. */
  async rollback(t) {
    const undo = this.store.activeAfter(t.roundId, t.seq), now = this.now();
    if (!undo.length) return;
    const current = this.store.round(t.roundId), prev = t.previous;
    const prevAddress = prev?.tip ? this.addressOf(prev.spk) : null;
    this.store.tx(() => {
      for (const u of undo) {
        this.store.setTransitionStatus(u.roundId, u.seq, 'ROLLED_BACK');
        this.store.enqueue(this.relayPayload('rollback', {...u, status: 'ROLLED_BACK'}, null), now);
      }
      if (prev) this.store.putRound(prev, prevAddress, now, t.contract ?? current?.contract);
      else {
        this.store.db.prepare("UPDATE rounds SET status='ROLLED_BACK', address=NULL, updated_at=? WHERE id=?").run(now, t.roundId);
        this.store.discoveryResult(t.roundId, 'PENDING', now, 'GENESIS_ROLLED_BACK');
      }
      this.store.log('ROLLBACK', {round: t.roundId, fromSeq: t.seq, txids: undo.map(u => u.txid)}, now);
    });
    if (current?.status === 'LIVE' && current.address) await this.unsubscribe(current.address);
    if (prevAddress) { await this.subscribe(prevAddress); this.run('spend:' + t.roundId, () => this.resolveSpend(t.roundId)); }
    else this.run('genesis:' + t.roundId, () => this.discoverGenesis(t.roundId, {starts: this.store.checkpointsBefore(t.observedAt, this.config.checkpointsPerSearch).map(c => c.sink)}));
  }

  /**
   * Reorg fast path (2026-10-10): the node reported selected-chain blocks removed. Roll back, at once, every non-final
   * transition whose accepting block is among them (the periodic checkFinality would find it within 60 s). The removed
   * hash list is all that is used: no block bodies are fetched. Each rollback re-resolves through resolveSpend, which
   * replays the rolled-back spender from its still-chain ancestor first (see replayRolledBack).
   */
  onChainChanged(removed) {
    if (!Array.isArray(removed) || !removed.length) return;
    // TN10 delivers ~1.5 events/s with removed blocks (measured 2026-10-10: 88 of 550 events in 60 s, max 5 removed).
    // Match against an in-memory set of non-final accepting hashes (refreshed on change); no DB/RPC unless one matches.
    const watched = this.watchedAccepting();
    const gone = new Set(removed.map(String).filter(h => watched.has(h)));
    if (!gone.size) return;
    const hit = this.store.unfinalized().filter(t => gone.has(t.accepting));
    if (!hit.length) return;
    this.store.log('REORG_EVENT', {removed: removed.length, transitions: hit.map(t => ({round: t.roundId, seq: t.seq, txid: t.txid}))}, this.now());
    this.run('reorg:' + removed[0], async () => {
      const rolled = new Set();
      for (const t of this.store.unfinalized().filter(x => gone.has(x.accepting))) {
        if (rolled.has(t.roundId)) continue;
        const h = await this.header(t.accepting);              // confirm on the node, never trust the event alone
        if (!h.isChain) { await this.rollback(t); rolled.add(t.roundId); }
      }
    });
  }

  /** Accepting hashes of non-final transitions, cached until the transitions table changes (commit/rollback/finality). */
  watchedAccepting() {
    const v = this.store.db.prepare("SELECT COUNT(*) n, MAX(rowid) m, SUM(status='ACCEPTED') a FROM transitions").get(), key = `${v.n}:${v.m}:${v.a}`;
    if (this.watchKey !== key) { this.watchKey = key; this.watchSet = new Set(this.store.unfinalized().map(t => t.accepting)); }
    return this.watchSet;
  }

  /** Missed-notification safety net: one batched UTXO query for every live round. */
  async reconcile() {
    const live = this.store.rounds({liveOnly: true});
    if (!live.length) return;
    const r = await this.node.getUtxosByAddresses({addresses: [...new Set(live.map(x => x.address))]});
    const present = new Set((r.entries ?? []).map(normalizeUtxo).map(u => outpointKey(u.outpoint)));
    const now = this.now();
    for (const x of live) {
      if (present.has(outpointKey(x.data.tip))) this.store.markLiveSeen(x.id, now);
      else { this.store.markTipSpent(x.id, x.data.tip, now); this.run('spend:' + x.id, () => this.resolveSpend(x.id)); }
    }
  }

  relayPayload(type, t, address) {
    const n = t.next ?? {};
    const {latestTransaction, genesisTransaction, ...summary} = n;
    const plugin = this.contracts.has(t.contract) ? this.contracts.get(t.contract) : null;
    return {schema: 'kaswin-event-indexer/1', type, network: this.config.network, contract: t.contract ?? null, profileId: plugin?.profileId ?? null,
      roundId: t.roundId, seq: t.seq, txid: t.txid, kind: t.kind, status: t.status,
      accepting: {hash: t.accepting, daa: String(t.acceptingDaa), blueScore: String(t.acceptingBlueScore)}, containing: t.containing ?? null,
      address, round: type === 'transition' ? canonical(summary) : undefined,
      trust: 'Observed by this indexer via one RPC node; consumers must verify acceptance/UTXO on their own node before value decisions'};
  }
}

/** Tip-spend match on raw RPC rows (index may arrive as number or bigint; hash case normalized). */
/** Worker results come back via structured clone with bigint fields as strings (the worker keeps them as bigint here). */
function reviveWindow(r) {
  if (r.found) r.found.acc = {...r.found.acc, daa: BigInt(r.found.acc.daa), blueScore: BigInt(r.found.acc.blueScore)};
  if (r.cursor) r.cursor = {from: String(r.cursor.from), fromBlue: BigInt(r.cursor.fromBlue), w: r.cursor.w != null ? BigInt(r.cursor.w) : null};
  return r;
}
function spendsLoose(tx, tip) {
  return Array.isArray(tx?.inputs) && tx.inputs.some(i => i?.previousOutpoint &&
    String(i.previousOutpoint.transactionId).toLowerCase() === tip.transactionId && Number(i.previousOutpoint.index) === Number(tip.index));
}

function safeKind(plugin, tx) { try { return String(plugin.kindOf(tx)).slice(0, 32) || 'UNKNOWN'; } catch { return 'UNKNOWN'; } }
