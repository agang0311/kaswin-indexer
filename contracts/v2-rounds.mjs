// V2-only accepted-transition adapter. Locally pinned core/frames; never reinterpret F3 rounds.
import {wireSpk, sameSpk} from '../src/normalize.mjs';
export function createV2RoundAdapter({S, G, accepted, profile, networkGenesis, registryScope = [], registrationOf = null}) {
  if (typeof accepted?.interpretAccepted !== 'function') throw Error('V2_ACCEPTED_INTERPRETER_REQUIRED');
  const hex = b => Buffer.from(b).toString('hex');
  const eq = (ok, msg) => { if (!ok) throw Error(msg); };
  const bytes = h => { eq(typeof h === 'string' && /^(?:[0-9a-f]{2})*$/i.test(h), 'V2_HEX'); return new Uint8Array(Buffer.from(h, 'hex')); };
  const serial = x => JSON.parse(JSON.stringify(x, (_, v) => typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? hex(v) : v));
  const outpoint = (a, b) => a?.transactionId === b?.transactionId && a?.index === b?.index;
  const snap = (r, daa) => ({ledger: bytes(r.ledger), tip: r.tip, scriptPublicKey: r.spk, covenantId: r.cid, value: BigInt(r.value), utxoDaa: BigInt(r.utxoDaa), currentDaa: BigInt(daa), origin: r.origin});
  const summary = r => { const s = S.decodeLedger(bytes(r.ledger)); return {...r, state: serial({...s, directory: undefined}), purchases: S.records(s), profileId: profile.id, requiresIndependentVerification: true}; };
  const prefix = Buffer.from('KASWIN_GENESIS_V2').toString('hex') + profile.id;
  function genesis(t, b) {
    if (!t.payload?.startsWith(prefix)) return null;
    const o = t.outputs?.[0], c = o?.covenant;
    if (!c) return null;
    let s;
    try {
      s = G.verifyGenesisAnnouncement({accepted: true, payload: t.payload, authorizingOutpoint: t.inputs[0].previousOutpoint,
        outputIndex: 0, value: BigInt(o.value), spk: wireSpk(o.scriptPublicKey), covenantId: c.covenantId, authorizingInput: c.authorizingInput,
        covenantOutputIndices: t.outputs.flatMap((v, i) => v.covenant?.covenantId === c.covenantId ? [i] : [])}, profile);
    } catch { return null; }
    const id = t.verboseData.transactionId, candidate = registrationOf?.(t, registryScope, s.ownerKey) ?? null;
    // Registration is an ordinary discovery marker, not proof of Genesis or acceptance.
    // V2 builder allows 1..8 creator inputs. Missing accepted-row UTXO context is UNKNOWN, not a skipped round.
    let registration = null;
    if (candidate) {
      eq(t.inputs.length >= 1 && t.inputs.length <= 8, 'V2_GENESIS_FUNDING_COUNT');
      for (const i of t.inputs) {
        const u = i.verboseData?.utxoEntry;
        eq(u && u.amount != null && u.scriptPublicKey != null && typeof u.isCoinbase === 'boolean' && typeof i.signatureScript === 'string', 'V2_FUNDING_CONTEXT_MISSING');
      }
      const ownerSpk = {version: 0, script: `20${s.ownerKey}ac`};
      const ownFunding = t.inputs.every(i => {
        const u = i.verboseData.utxoEntry;
        return /^41[0-9a-f]{128}01$/i.test(i.signatureScript) && u.isCoinbase === false &&
          (!u.covenantId || u.covenantId === S.ZERO) && BigInt(u.amount) > 0n && sameSpk(wireSpk(u.scriptPublicKey), ownerSpk);
      });
      if (ownFunding && t.outputs.every((v, i) => i === 0 || !v.covenant) &&
          t.outputs.reduce((n, v) => n + BigInt(v.value), 0n) < t.inputs.reduce((n, i) => n + BigInt(i.verboseData.utxoEntry.amount), 0n)) registration = candidate;
    }
    const origin = t.inputs[0].previousOutpoint;
    const creation = registration ? {schema: 'KASWIN_V2', genesisTxid: id, acceptingBlock: b.hash, acceptingDaa: b.daa,
      containingBlock: t.verboseData.blockHash, profileId: profile.id, networkGenesis, cid: c.covenantId, origin,
      config: serial(s.config), registration, genesisTransaction: serial(t), verifiedV2Genesis: true} : undefined;
    return summary({id, genesisTxid: id, creation, genesisAccepting: b.hash, genesisContaining: t.verboseData.blockHash,
      genesisTransaction: serial(t), latestTxid: id, latestTransaction: serial(t), accepting: b.hash, containing: t.verboseData.blockHash,
      tip: {transactionId: id, index: 0}, origin, cid: c.covenantId, ledger: hex(S.encodeLedger(s)), spk: wireSpk(o.scriptPublicKey), value: String(o.value), utxoDaa: b.daa, terminal: null});
  }
  function advance(r, t, b) {
    eq(r.profileId === profile.id && r.tip && outpoint(t.inputs?.[0]?.previousOutpoint, r.tip), 'V2_ROUND_INPUT');
    const x = snap(r, b.daa);
    const known = t.inputs[0].verboseData?.utxoEntry;
    if (known) {
      eq(BigInt(known.amount) === x.value && sameSpk(wireSpk(known.scriptPublicKey), x.scriptPublicKey) &&
        known.covenantId === x.covenantId && (known.blockDaaScore == null || BigInt(known.blockDaaScore) === x.utxoDaa), 'V2_SPENT_CONTEXT_MISMATCH');
    }
    eq(!t.inputs.slice(1).some(i => i.verboseData?.utxoEntry?.covenantId === r.cid), 'V2_MULTIPLE_FAMILY_INPUTS');
    // Engine supplies an accepted transaction; previous verified round material is input0 context.
    // Missing extra input amounts mean unknown fee, never fee inferred from a free witness argument.
    const tx = {version: t.version, inputs: t.inputs.map(i => ({previousOutpoint: i.previousOutpoint,
      signatureScript: i.signatureScript.toLowerCase(), sequence: BigInt(i.sequence), computeBudget: i.computeBudget ?? 0})),
      outputs: t.outputs.map(o => ({value: BigInt(o.value), scriptPublicKey: wireSpk(o.scriptPublicKey), covenant: o.covenant ?? null})),
      lockTime: BigInt(t.lockTime), subnetworkId: t.subnetworkId, gas: BigInt(t.gas), payload: t.payload ?? '', storageMass: BigInt(t.storageMass ?? 0)};
    const amounts = t.inputs.map((i, index) => index === 0 ? x.value : i.verboseData?.utxoEntry?.amount == null ? null : BigInt(i.verboseData.utxoEntry.amount));
    const result = accepted.interpretAccepted(x, profile, tx, amounts.every(v => v !== null) ? amounts : undefined);
    const id = t.verboseData.transactionId;
    const next = {...r, latestTxid: id, latestTransaction: serial(t), accepting: b.hash, containing: t.verboseData.blockHash, terminal: result.terminal,
      tip: result.next ? {transactionId: id, index: 0} : null, ledger: result.next ? hex(S.encodeLedger(result.next)) : r.ledger,
      spk: result.next ? tx.outputs[0].scriptPublicKey : r.spk, value: result.next ? tx.outputs[0].value.toString() : '0', utxoDaa: b.daa,
      actualFee: result.fee?.toString() ?? null};
    if (next.tip) S.verifySnapshot(snap(next, b.daa), profile);
    return summary(next);
  }
  return {genesis, advance, summary};
}
