// Bounded accepted-chain window walk (2026-10-10). Pure page loop shared by the in-process path (tests, small walks) and
// the worker-thread runner (production). Walks the selected chain from `from` in windows of <= windowBlue blue score
// using getVirtualChainFromBlockV2 High (minConfirmationCount trims each page), keeping one page in memory.
//
// Why a worker in production: measured on the 2.0.1 WASM SDK (2026-10-10, TN10 under load), a multi-hour walk in one
// process grows RSS by ~200 MB outside the JS heap (heap stays ~16 MB) and that memory is not returned; the service
// limit is MemoryMax=320 MB. A terminated worker returns it (main RSS back to ~105 MB). Each chunk is a fresh worker
// with a page cap, so one walk can never hold more than one chunk's high-water.
import {canonical, txidOf} from './normalize.mjs';


/** Same rule as engine spendsLoose: some input spends exactly `tip`. Kept here so a worker can apply it without code. */
export function spendsOutpoint(tx, tip) {
  return Array.isArray(tx?.inputs) && tx.inputs.some(i => i?.previousOutpoint &&
    String(i.previousOutpoint.transactionId).toLowerCase() === tip.transactionId && Number(i.previousOutpoint.index) === Number(tip.index));
}

/**
 * @returns {found: {acc, tx, containing}} | {done: true} (scanned up to sinkBlue) | {cursor: {from, fromBlue}} (page cap or
 * time budget reached; resume from cursor). Throws WINDOW_START_NOT_CHAIN if `from` left the selected chain.
 */
// Page sizing (measured 2026-10-10 on TN10): the node trims by distance to its CURRENT sink, which advances ~10 blue/s,
// so minConfirmationCount is recomputed from a fresh sink blue score before every page (a value fixed at walk start made
// pages grow without bound: +600 blue after one minute). Density varies by >100x (spam bursts reached ~600 accepted
// tx per chain block, ~60 MB of decoded objects per 50-block page), so the window adapts to a per-page tx target.
export const PAGE_TX_TARGET = Number(process.env.WINDOW_TX_TARGET) > 0 ? Number(process.env.WINDOW_TX_TARGET) : 4000;
export async function scanWindow(node, {match, from, fromBlue, sinkBlue, windowBlue, maxPages = Infinity, until = Infinity, now = () => Date.now(),
  txTarget = PAGE_TX_TARGET, w = null}) {
  // Start small and grow (a first page at the full window inside a spam burst is the largest allocation of the walk);
  // the adapted window is returned in the cursor so the next chunk continues with it.
  const maxWindow = windowBlue;
  w = w != null && w > 0n ? (w < maxWindow ? w : maxWindow) : (maxWindow < 8n ? maxWindow : 8n);
  for (let page = 0; page < maxPages; page++) {
    if (now() > until) return {cursor: {from, fromBlue, w}, budget: true};
    const current = BigInt((await node.getSinkBlueScore()).blueScore);
    const want = fromBlue + w, min = current > want ? current - want : 0n;
    const r = await node.getVirtualChainFromBlockV2({startHash: from, dataVerbosityLevel: 'High', minConfirmationCount: Number(min)});
    if ((r.removedChainBlockHashes ?? []).length) throw Error('WINDOW_START_NOT_CHAIN');
    const added = (r.addedChainBlockHashes ?? []).map(String), rows = r.chainBlockAcceptedTransactions ?? [];
    if (rows.length !== added.length) throw Error('VC_ROWS_NOT_ALIGNED');
    for (let i = 0; i < rows.length; i++) {
      const h = rows[i].chainBlockHeader;
      if (String(h?.hash) !== added[i]) throw Error('VC_HEADER_MISMATCH');
      for (const t of rows[i].acceptedTransactions ?? []) {
        if (!match(t)) continue;
        if (h.daaScore == null || h.blueScore == null) throw Error('VC_HEADER_FIELDS_MISSING');
        const tx = canonical(t), containing = tx.verboseData?.blockHash ? String(tx.verboseData.blockHash) : null;
        if (!txidOf(tx) || !containing) throw Error('VC_HIGH_ROW_INCOMPLETE');
        return {found: {acc: {hash: added[i], daa: BigInt(h.daaScore), blueScore: BigInt(h.blueScore), isChain: true,
          selectedParent: i ? added[i - 1] : String(from)}, tx, containing}};
      }
    }
    if (!added.length) {
      // Page fully trimmed (next chain block is more than w blue away, or near the sink): widen and retry.
      if (fromBlue >= sinkBlue || current - fromBlue <= w) return {done: true};
      w = w * 2n; continue;
    }
    let txs = 0;
    for (const row of rows) txs += (row.acceptedTransactions ?? []).length;
    if (w > maxWindow) w = maxWindow;                       // a widened (sparse) window never carries into dense pages
    if (txs > txTarget && w > 1n) w = w / 2n > 0n ? w / 2n : 1n;
    else if (txs * 4 < txTarget && w < maxWindow) w = w * 2n < maxWindow ? w * 2n : maxWindow;
    const last = rows.at(-1).chainBlockHeader?.blueScore;
    if (last == null) throw Error('VC_HEADER_FIELDS_MISSING');
    const top = BigInt(last);
    if (top >= sinkBlue) return {done: true};
    from = added.at(-1); fromBlue = top;
  }
  return {cursor: {from, fromBlue, w}};
}
