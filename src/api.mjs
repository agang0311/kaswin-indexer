// Read-only cache API. No RPC, wallet, or transaction submission endpoints.
import http from 'node:http';
const HASH = /^[0-9a-f]{64}$/;
/** Reorg recheck depth (project policy, same as the Kaswin page; NOT consensus finality). Read-only VSPC monitor:
 * deepest observed selected-chain removal 83 DAA (mainnet 24 h, run incomplete), 75 DAA (TN10 5.3 h). */
export const REORG_RECHECK_DAA = 100n;
/**
 * Confidence of the round's CURRENT state from the transition that produced it:
 *  CONFIRMING: accepting block < 100 DAA below the latest checkpointed virtual DAA (a short reorg can still undo it),
 *  ACCEPTED:   deeper, not yet FINAL by the indexer's blue-score policy,
 *  FINAL:      the indexer's finality policy (blue score) reached; UNKNOWN: no checkpoint or no transition.
 * The checkpoint is at most a few seconds old, so depth is a lower bound; consumers must still verify on their node.
 */
export function acceptanceOf(t, virtualDaa) {
  if (!t) return {acceptance: 'UNKNOWN', acceptingDaa: null, depthDaa: null};
  const acceptingDaa = BigInt(t.acceptingDaa);
  if (virtualDaa == null) return {acceptance: t.status === 'FINAL' ? 'FINAL' : 'UNKNOWN', acceptingDaa: String(acceptingDaa), depthDaa: null};
  const v = BigInt(virtualDaa), depth = v > acceptingDaa ? v - acceptingDaa : 0n;
  const acceptance = t.status === 'FINAL' ? 'FINAL' : depth >= REORG_RECHECK_DAA ? 'ACCEPTED' : 'CONFIRMING';
  return {acceptance, acceptingDaa: String(acceptingDaa), depthDaa: String(depth)};
}
export function categoryOf(r) {
  const v2 = r.contract?.startsWith('kaswin-v2@');
  if (r.status === 'STALE' || (!v2 && !r.contract?.startsWith('kaswin-f3@'))) return 'unknown';
  if (r.status === 'TERMINAL') return 'close';
  const p = r.data.state?.phase;
  return p === 1 ? 'open' : (v2 ? p === 2 : [2, 3, 4].includes(p)) ? 'sealed' : p === 5 ? 'close' : 'unknown';
}
function view(r, detail = false, store = null, virtualDaa = null) {
  const d = r.data;
  const acc = store ? acceptanceOf(store.latestActive(r.id), virtualDaa) : null;
  // The node already showed the indexed tip as spent; the successor is still being resolved: this state is OUT OF DATE.
  const spentAt = store && r.status === 'LIVE' ? store.tipSpent(r.id, d.tip) : null;
  return {cid: d.cid, genesisTxid: r.id, contract: r.contract, status: categoryOf(r), phase: d.state?.phase ?? null,
    terminal: d.terminal ?? null, indexStatus: r.status, tip: d.tip, address: r.address, value: String(d.value),
    latestTxid: d.latestTxid ?? null, accepting: d.accepting ?? null, utxoDaa: d.utxoDaa == null ? null : String(d.utxoDaa),
    updatedAt: r.updatedAt, liveSeenAt: r.liveSeenAt, ...(acc ?? {}), ...(store ? {tipSpentSeenAt: spentAt} : {}),
    ...(detail ? {state: d.state, purchases: d.purchases, origin: d.origin, scriptPublicKey: d.spk} : {})};
}
export function createApi({store, corsOrigin = '*'}) {
  const isNone = corsOrigin === false || corsOrigin === null || corsOrigin === 'none';
  if (!isNone && corsOrigin !== '*' && !/^https?:\/\/[^/]+$/.test(corsOrigin)) throw Error('INVALID_CORS_ORIGIN');
  const server = http.createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'});
      res.end(JSON.stringify(body, (_, v) => typeof v === 'bigint' ? v.toString() : v));
    };
    if (!isNone) {
      if (corsOrigin === '*') {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      } else if (req.headers.origin === corsOrigin) {
        res.setHeader('Access-Control-Allow-Origin', corsOrigin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      }
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (req.method !== 'GET') { res.setHeader('Allow', 'GET, OPTIONS'); send(405, {detail: 'METHOD_NOT_ALLOWED'}); return; }
    try {
      const url = new URL(req.url, 'http://localhost');
      const cp = store.checkpointsBefore(Date.now() + 1, 1)[0] ?? null, virtualDaa = cp?.virtualDaa ?? null;
      const meta = {network: 'testnet-10', coverage: 'tracked-rounds-only', requiresIndependentVerification: true,
        lastCheckpointAt: cp?.at ?? null, virtualDaa: virtualDaa == null ? null : String(virtualDaa), reorgRecheckDaa: String(REORG_RECHECK_DAA),
        discoveryCoverage: 'notification-or-manual-only', discoveryScan: {enabled: false}, discoveryPending: store.db.prepare("SELECT COUNT(*) n FROM discoveries WHERE status='PENDING'").get().n};
      const match = /^\/v1\/rounds\/([^/]+)$/.exec(url.pathname);
      if (match) {
        if (!HASH.test(match[1]) || url.search) return send(400, {detail: 'INVALID_CID_OR_QUERY'});
        const rows = store.byCid(match[1]);
        if (!rows.length) return send(404, {detail: 'NOT_INDEXED', ...meta});
        if (rows.length > 1) return send(409, {detail: 'CID_CONFLICT'});
        return send(200, {item: view(rows[0], true, store, virtualDaa), ...meta});
      }
      if (url.pathname !== '/v1/rounds') return send(404, {detail: 'NOT_FOUND'});
      for (const key of url.searchParams.keys()) if (!['status', 'limit', 'cursor'].includes(key) || url.searchParams.getAll(key).length !== 1)
        return send(400, {detail: 'INVALID_QUERY'});
      const status = url.searchParams.get('status'), cursor = url.searchParams.get('cursor') ?? '', rawLimit = url.searchParams.get('limit') ?? '50';
      if ((status !== null && !['open', 'sealed', 'close', 'unknown'].includes(status)) ||
          (cursor && !HASH.test(cursor)) || !/^[1-9][0-9]{0,2}$/.test(rawLimit) || Number(rawLimit) > 200)
        return send(400, {detail: 'INVALID_QUERY'});
      const limit = Number(rawLimit), rows = store.cidPage(cursor, limit + 1, status), page = rows.slice(0, limit);
      if (page.some(r => store.byCid(r.data.cid).length > 1)) return send(409, {detail: 'CID_CONFLICT'});
      return send(200, {items: page.map(r => view(r, false, store, virtualDaa)), nextCursor: rows.length > limit ? page.at(-1).data.cid : null, ...meta});
    } catch { send(500, {detail: 'INTERNAL_ERROR'}); }
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000;
  return server;
}
