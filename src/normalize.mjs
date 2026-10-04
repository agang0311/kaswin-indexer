// Transaction / UTXO helpers shared by the event indexer. No SDK or network access here.
export function canonical(x) {
  if (typeof x === 'bigint') return x.toString();
  if (Array.isArray(x)) return x.map(canonical);
  if (x !== null && typeof x === 'object') {
    const out = {};
    for (const k of Object.keys(x).sort()) {
      if (x[k] !== undefined) out[k] = canonical(x[k]);
    }
    return out;
  }
  return x;
}
export const ZERO_HASH = '0'.repeat(64);
export const outpointKey = o => `${o.transactionId}:${o.index}`;
export const txidOf = tx => tx?.verboseData?.transactionId ?? null;

/** Accept both wire string `vvvv<script>` (little-endian version) and {version, script}. */
export function wireSpk(x) {
  if (typeof x === 'string') {
    if (!/^[0-9a-f]{4}([0-9a-f]{2})*$/i.test(x)) throw Error('SPK_FORMAT');
    return {version: parseInt(x.slice(2, 4) + x.slice(0, 2), 16), script: x.slice(4).toLowerCase()};
  }
  if (!x || !Number.isInteger(x.version) || typeof x.script !== 'string') throw Error('SPK_FORMAT');
  return {version: x.version, script: x.script.toLowerCase()};
}
export const sameSpk = (a, b) => !!a && !!b && a.version === b.version && a.script.toLowerCase() === b.script.toLowerCase();

export function spends(tx, outpoint) {
  return Array.isArray(tx?.inputs) && tx.inputs.some(i =>
    i?.previousOutpoint?.transactionId === outpoint.transactionId && i.previousOutpoint.index === outpoint.index);
}

/** Cheap routing only: no witness/payload decoding, copying, bigint conversion or trust decision.
 * Always retain a known tip spend, even when CID context is absent or inconsistent (including termination).
 */
export function relatedTransaction(tx, tip, cid = null) {
  if (tip && spends(tx, tip)) return true;
  if (!cid) return false;
  return (tx?.outputs ?? []).some(o => o?.covenant?.covenantId === cid) ||
    (tx?.inputs ?? []).some(i => i?.verboseData?.utxoEntry?.covenantId === cid);
}

/** The pinned F3 adapter needs consensus fields that V2 Low/High omit (see 2026-09-27 incident). */
export function isFullTransaction(tx) {
  return !!txidOf(tx) && tx.version !== undefined && tx.lockTime !== undefined &&
    Array.isArray(tx.inputs) && Array.isArray(tx.outputs) && tx.inputs.every(i => typeof i.signatureScript === 'string');
}

/** Canonicalize (bigint -> decimal string) and record which block included it, if known. */
export function prepareTransaction(tx, containingBlock = null) {
  const t = canonical(tx);
  t.verboseData = {...(t.verboseData ?? {})};
  const hash = t.verboseData.blockHash;
  if (!hash || hash === ZERO_HASH) t.verboseData.blockHash = containingBlock ?? null;
  return t;
}

/** Normalized live UTXO row: {outpoint, amount:bigint, spk, blockDaaScore:bigint, covenantId|null, address|null}. */
export function normalizeUtxo(e) {
  const entry = e?.entry ?? e?.utxoEntry ?? {};
  const outpoint = e?.outpoint ?? entry.outpoint;
  const cid = entry.covenantId ?? e?.covenantId;
  return {
    outpoint: {transactionId: String(outpoint.transactionId).toLowerCase(), index: Number(outpoint.index)},
    amount: BigInt(e?.amount ?? entry.amount),
    spk: wireSpk(normalizeSpkObject(e?.scriptPublicKey ?? entry.scriptPublicKey)),
    blockDaaScore: BigInt(e?.blockDaaScore ?? entry.blockDaaScore),
    covenantId: cid === undefined || cid === null ? null : String(cid).toLowerCase(),
    address: e?.address ? String(e.address) : null,
  };
}
function normalizeSpkObject(s) {
  if (typeof s === 'string') return s;
  return {version: Number(s.version), script: String(s.script)};
}
