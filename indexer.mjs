#!/usr/bin/env node
// Covenant event indexer daemon (contract rules from contracts/*.json plugins). Read-only: connects via kaspa-resolver, never signs or submits.
//   node workers/kaswin-event-indexer/indexer.mjs run   [--contracts contracts/default.json] [--db PATH] [--url wss://..|--urls PRIMARY,STANDBY|--resolver URL,..] [--relay URL] [--relay-file PATH]
//   --urls: two node connections kept open (hot standby, both subscribed); queries fail over at once, the dropped one reconnects.
//   --pool: same, but the two members are chosen at start from seed + kaspa-resolver answers (healthy, different backends by
//           p2pId, lowest RTT); a member that keeps failing is replaced from a fresh probe. --pool-urls adds extra candidates.
//   node workers/kaswin-event-indexer/indexer.mjs track GENESIS_TXID START_CHAIN_HASH [--contract KEY_OR_ID] [--db PATH] ...
//   node workers/kaswin-event-indexer/indexer.mjs contracts [--contracts FILE]     (load + print, no network)
//   node workers/kaswin-event-indexer/indexer.mjs status [--db PATH]
import {parseArgs} from 'node:util';
import {loadSdk} from './src/sdk.mjs';
import {Store} from './src/store.mjs';
import {Engine} from './src/engine.mjs';
import {loadContracts} from './src/contracts.mjs';
import {openNode, addressOfFactory} from './src/node.mjs';
import {openDualNode} from './src/dual-node.mjs';
import {TN10_SEED, RESOLVER_HOSTS, probePool, choosePair, chooseReplacement, discoverFromResolvers} from './src/node-pool.mjs';
import {makeRelay, flushOutbox} from './src/relay.mjs';
import {createApi} from './src/api.mjs';
import {runtimeOptions} from './src/config.mjs';

const {values: cli, positionals: [cmd = 'run', ...rest]} = parseArgs({allowPositionals: true, options: {
  db: {type: 'string', default: 'kaswin-events.sqlite'}, url: {type: 'string'}, urls: {type: 'string'}, resolver: {type: 'string'},
  pool: {type: 'boolean', default: false}, 'pool-urls': {type: 'string'},
  relay: {type: 'string'}, 'relay-file': {type: 'string'},
  contracts: {type: 'string', default: new URL('./contracts/default.json', import.meta.url).pathname}, contract: {type: 'string'},
  'legacy-contract': {type: 'string'}, 'registry-addresses': {type: 'string'},
  'api-port': {type: 'string'}, 'api-host': {type: 'string', default: '127.0.0.1'}, 'cors-origin': {type: 'string', default: '*'},
  'checkpoint-ms': {type: 'string', default: '3000'}, 'reconcile-ms': {type: 'string', default: '60000'},
  'finality-blue-score': {type: 'string', default: '600'},
}});
const o = runtimeOptions(cli);
const log = (kind, ...a) => console.log(JSON.stringify({at: new Date().toISOString(), kind, detail: a.length === 1 ? a[0] : a}, (_, v) => typeof v === 'bigint' ? v.toString() : v));
if (o['api-port'] && (!/^[0-9]+$/.test(o['api-port']) || Number(o['api-port']) < 1 || Number(o['api-port']) > 65535)) throw Error('INVALID_API_PORT');
const store = new Store(o.db, {defaultContract: o['legacy-contract'] ?? null});

if (cmd === 'status') {
  const safe = x => JSON.parse(JSON.stringify(x, (_, v) => typeof v === 'bigint' ? v.toString() : v));
  console.log(JSON.stringify(safe({rounds: store.rounds().map(r => ({id: r.id, contract: r.contract, status: r.status, address: r.address, tip: r.data.tip, terminal: r.data.terminal,
    phase: r.data.state?.phase, sold: r.data.state?.sold, transitions: store.transitions(r.id).map(t => ({seq: t.seq, kind: t.kind, txid: t.txid, status: t.status}))})),
    outboxPending: store.pending(1000).length, journal: store.journal(15)}), null, 1));
  process.exit(0);
}

const sdk = loadSdk(), network = 'testnet-10';
const contracts = await loadContracts(o.contracts, {sdk, network, registryAddresses: o.registryAddresses});
if (cmd === 'contracts') { console.log(JSON.stringify({config: o.contracts, contracts: contracts.describe(), watch: contracts.watchAddresses()}, null, 1)); process.exit(0); }
if ([o.url, o.urls, o.resolver, o.pool].filter(Boolean).length > 1) throw Error('USE_ONE_OF_URL_URLS_RESOLVER_POOL');
const openMember = url => openNode(sdk, {network, url, strategy: 'fallback', timeoutMs: 6000, connectDeadlineMs: 8000});
const probe = async url => {
  const n = await openMember(url);
  try {
    const rtt = [];
    let blue = 0n;
    for (let i = 0; i < 3; i++) { const t = performance.now(); blue = BigInt((await n.getSinkBlueScore()).blueScore); rtt.push(performance.now() - t); }
    return {p2pId: n.identity.p2pId, blueScore: blue, rttMs: Math.round(rtt.sort((a, b) => a - b)[1])};
  } finally { try { await n.close(); } catch {} }
};
const candidates = async () => {
  const extra = o['pool-urls'] ? o['pool-urls'].split(',').map(s => s.trim()) : [];
  const found = await discoverFromResolvers(RESOLVER_HOSTS, {rounds: 2});
  return [...new Set([...extra, ...TN10_SEED, ...found])];
};
let node;
if (o.pool) {
  const pool = await probePool(await candidates(), probe);
  log('POOL_PROBED', {healthy: pool.healthy.map(c => ({url: c.url, p2pId: c.p2pId, rttMs: c.rttMs, lag: String(c.lag)})), rejected: pool.rejected});
  const pair = choosePair(pool.healthy);
  if (pair.length < 2) log('POOL_ONE_BACKEND_ONLY', {chosen: pair.map(c => c.url)});
  if (!pair.length) throw Error('POOL_NO_HEALTHY_NODE');
  const urls = pair.length === 2 ? pair.map(c => c.url) : [pair[0].url, pool.healthy.find(c => c.url !== pair[0].url)?.url ?? TN10_SEED.find(u => u !== pair[0].url)];
  log('POOL_CHOSEN', {urls});
  node = await openDualNode({urls, log, open: openMember, pickReplacement: async ({avoidP2pIds, avoidUrls}) => {
    const again = await probePool((await candidates()).filter(u => !avoidUrls.includes(u)), probe);
    const next = chooseReplacement(again.healthy, avoidP2pIds);
    log('POOL_REPROBED', {chosen: next?.url ?? null, healthy: again.healthy.length, rejected: again.rejected.length});
    return next?.url ?? null;
  }});
} else if (o.urls) node = await openDualNode({urls: o.urls.split(',').map(s => s.trim()), log, open: openMember});
else node = await openNode(sdk, {network, url: o.url ?? null, resolverUrls: o.resolver ? o.resolver.split(',') : null, log});
const engine = new Engine({store, contracts, node, addressOf: addressOfFactory(sdk, network), log,
  config: {network, finalityBlueScore: BigInt(o['finality-blue-score'])}});
node.on('utxos', data => engine.onUtxosChanged(data));
node.on('chain', removed => engine.onChainChanged(removed));

if (cmd === 'track') {
  const [txid, start] = rest;
  if (!/^[0-9a-f]{64}$/.test(txid ?? '') || !/^[0-9a-f]{64}$/.test(start ?? '')) throw Error('usage: track GENESIS_TXID START_CHAIN_HASH');
  await engine.start();
  // Serialize with retryPending()/event work queued by start(): never call engine work outside Engine.run.
  let result = 'NOT_RUN', failure = null;
  await engine.run('track:' + txid, async () => {
    try { result = await engine.discoverGenesis(txid, {starts: [start], contract: o.contract ?? null}); } catch (e) { failure = e; throw e; }
  });
  await engine.idle();
  log('TRACK', failure ? 'FAILED ' + String(failure?.message ?? failure) : result);
  if (failure) { await node.close(); store.close(); process.exit(1); }
  await node.close(); store.close(); process.exit(0);
}

const relay = makeRelay({url: o.relay ?? null, token: process.env.KASWIN_RELAY_TOKEN ?? null, file: o['relay-file'] ?? null});
let stopping = false, degraded = false;
node.on('disconnect', () => { degraded = true; log('DISCONNECTED', node.identity); });
node.on('connect', () => engine.run('reconnect', async () => {
  if (!degraded) return;
  await node.verify();                       // resolver may have handed us a different node
  await engine.resubscribeAll();
  degraded = false; log('RESUBSCRIBED', node.identity);
}));
// Dual mode: the standby was already subscribed; only close the gap of the switch moment (missed events -> reconcile).
node.on('failover', info => { log('FAILOVER_RECONCILE', info); engine.run('reconcile', () => engine.reconcile()); engine.retryPending(); });
await engine.start();
// Reorg fast path: removed selected-chain blocks roll back affected transitions at once (periodic check stays as backstop).
if (node.subscribeVirtualChainChanged) { try { await node.subscribeVirtualChainChanged(); engine.chainSubscribed = true; log('CHAIN_SUBSCRIBED', null); } catch (e) { log('CHAIN_SUBSCRIBE_FAILED', String(e?.message ?? e)); } }
log('STARTED', {node: node.identity, live: store.rounds({liveOnly: true}).length, contracts: contracts.describe()});
let api = null;
if (o['api-port']) {
  api = createApi({store, corsOrigin: o['cors-origin'] ?? '*'});
  await new Promise((resolve, reject) => { api.once('error', reject); api.listen(Number(o['api-port']), o['api-host'], resolve); });
  log('API_LISTENING', api.address());
}

const every = (ms, fn) => { const t = setInterval(() => { if (!stopping && !degraded) fn(); }, ms); t.unref?.(); return t; };
const timers = [
  every(Number(o['checkpoint-ms']), () => engine.run('checkpoint', () => engine.checkpoint())),
  every(Number(o['reconcile-ms']), () => { engine.run('reconcile', () => engine.reconcile()); engine.run('finality', () => engine.checkFinality()); }),
  every(5000, () => engine.retryPending()),
  every(2000, () => flushOutbox(store, relay).catch(e => log('RELAY_RETRY', String(e.message)))),
];
const stop = async () => { stopping = true; timers.forEach(clearInterval); if (api) await new Promise(resolve => api.close(resolve)); await engine.idle(); try { await node.close(); } catch {} store.close(); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
await new Promise(() => {});
