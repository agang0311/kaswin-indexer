// Child-process chunk of the bounded window walk (see window-scan.mjs and Engine.windowChunk for the memory rationale).
// Receives one job over IPC, opens its own read-only SDK connection to the given node URL, scans at most maxPages pages,
// replies once and exits; process exit returns all WASM/native memory to the OS. No keys, no submit.
import {loadSdk} from './sdk.mjs';
import {scanWindow, spendsOutpoint} from './window-scan.mjs';

// Never outlive the parent: if the IPC channel closes (parent exited/killed), stop at once.
process.on('disconnect', () => process.exit(0));
process.once('message', async job => {
  let rpc, reply;
  try {
    const {url, network, tip, from, maxPages, budgetMs} = job;
    const fromBlue = BigInt(job.fromBlue), sinkBlue = BigInt(job.sinkBlue), windowBlue = BigInt(job.windowBlue), w = job.w ? BigInt(job.w) : null;
    const sdk = loadSdk();
    rpc = new sdk.RpcClient({url, networkId: network, encoding: sdk.Encoding.Borsh});
    await rpc.connect({blockAsyncConnect: true, strategy: sdk.ConnectStrategy.Fallback, timeoutDuration: 8000});
    const info = await rpc.getServerInfo();
    if (info.networkId !== network || info.isSynced !== true) throw Error('WORKER_NODE_NOT_USABLE');
    const r = await scanWindow(rpc, {match: t => spendsOutpoint(t, tip), from, fromBlue, sinkBlue, windowBlue, maxPages, w, until: Date.now() + budgetMs});
    reply = {ok: true, r: JSON.parse(JSON.stringify(r, (k, v) => typeof v === 'bigint' ? String(v) : v))};
  } catch (e) {
    reply = {ok: false, message: String(e?.message ?? e).slice(0, 200)};
  }
  try { await rpc?.disconnect(); } catch {}
  process.send(reply, () => process.exit(0));
});
