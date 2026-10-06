// V2-only accepted-transition adapter. Locally pinned core/frames; never reinterpret F3 rounds.
import {wireSpk, sameSpk} from '../src/normalize.mjs';
export function createV2RoundAdapter({S, P, G, B, H, builders, profile, networkGenesis, registryScope = [], registrationOf = null}) {
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
  function pushes(script) {
    const data = bytes(script), result = []; let p = 0;
    eq(data.length <= 250000, 'V2_WITNESS_SIZE');
    while (p < data.length) {
      const op = data[p++]; let n;
      if (op === 0) { result.push(new Uint8Array()); continue; }
      if (op >= 81 && op <= 96) { result.push(Uint8Array.of(op - 80)); continue; }
      if (op <= 75) n = op;
      else if (op >= 76 && op <= 78) {
        const width = op === 76 ? 1 : op === 77 ? 2 : 4;
        eq(p + width <= data.length, 'V2_PUSH_HEADER'); n = 0;
        for (let j = 0; j < width; j++) n += data[p++] * 2 ** (8 * j);
      } else throw Error('V2_NON_PUSH_WITNESS');
      eq(p + n <= data.length, 'V2_PUSH_SIZE'); result.push(data.slice(p, p + n)); p += n;
    }
    return result;
  }
  function integer(data) {
    eq(data.length <= 8 && (!data.length || !(data.at(-1) & 128)), 'V2_SCRIPT_INT');
    let n = 0n; for (let i = data.length - 1; i >= 0; i--) n = (n << 8n) + BigInt(data[i]); return n;
  }
  function advance(r, t, b) {
    eq(r.profileId === profile.id && r.tip && outpoint(t.inputs?.[0]?.previousOutpoint, r.tip), 'V2_ROUND_INPUT');
    const x = snap(r, b.daa), s = S.verifySnapshot(x, profile), module = S.phaseModule(s.phase), w = pushes(t.inputs[0].signatureScript);
    eq(w.length === (module === 'open' ? 10 : 8), 'V2_WITNESS_ABI');
    const action = Object.keys(P.ACTIONS).find(k => BigInt(P.ACTIONS[k]) === integer(w[0])); eq(action, 'V2_UNKNOWN_ACTION');
    if (module === 'open') eq(hex(w[1]) === r.origin.transactionId && integer(w[2]) === BigInt(r.origin.index), 'V2_ORIGIN_CHANGED');
    const shift = module === 'open' ? 2 : 0, data = w[3 + shift], fee = integer(w[5 + shift]);
    const op = {action, actorKey: hex(w[4 + shift])};
    if (action === 'BUY') { eq(data.length === 4, 'V2_BUY_DATA'); op.quantity = new DataView(data.buffer, data.byteOffset, 4).getUint32(0, true); }
    if (action === 'DRAW_AND_PAY') {
      eq(data.length === 244, 'V2_DRAW_DATA'); const opening = data.slice(0, 240);
      // Node acceptance establishes selected-chain membership; this recomputation alone does not.
      const branch = (a, c) => B.domainHash('SeqCommitmentMerkleBranchHash', new Uint8Array([...a, ...c]));
      const seq = (base, parent) => branch(parent, branch(opening.slice(base, base + 32), branch(B.domainHash('SeqCommitMergesetContext', opening.slice(base + 64, base + 88)), opening.slice(base + 32, base + 64))));
      op.opening = opening; op.accessor = {blockHash: hex(opening.slice(0, 32)), sequenceCommitment: hex(seq(32, seq(152, opening.slice(120, 152))))};
    }
    const external = t.outputs.reduce((n, o) => n + BigInt(o.value), 0n) + fee - x.value;
    const nextState = P.transition(x, profile, op, fee, external);
    eq(builders.witness(x, profile, op, nextState, fee) === t.inputs[0].signatureScript.toLowerCase(), 'V2_WITNESS_POLICY');
    eq(BigInt(t.lockTime) === nextState.lockTime && BigInt(t.inputs[0].sequence) === nextState.sequence, 'V2_TIME_FIELDS');
    const expected = [];
    if (nextState.next) expected.push({value: S.valueOf(nextState.next), spk: {version: 0, script: 'aa20' + hex(H.blake2b256(S.scriptOf(nextState.next, profile))) + '87'}, cid: r.cid});
    for (const payment of nextState.payments) expected.push({value: payment.value, spk: payment.spk, cid: null});
    eq(t.outputs.length === expected.length, 'V2_OUTPUT_COUNT');
    t.outputs.forEach((o, i) => { const e = expected[i]; eq(BigInt(o.value) === e.value && sameSpk(wireSpk(o.scriptPublicKey), e.spk) &&
      (e.cid ? o.covenant?.covenantId === e.cid && o.covenant.authorizingInput === 0 : !o.covenant), 'V2_OUTPUT_MISMATCH'); });
    const id = t.verboseData.transactionId;
    const next = {...r, latestTxid: id, latestTransaction: serial(t), accepting: b.hash, containing: t.verboseData.blockHash, terminal: nextState.terminal,
      tip: nextState.next ? {transactionId: id, index: 0} : null, ledger: nextState.next ? hex(S.encodeLedger(nextState.next)) : r.ledger,
      spk: nextState.next ? expected[0].spk : r.spk, value: nextState.next ? expected[0].value.toString() : '0', utxoDaa: b.daa};
    if (next.tip) S.verifySnapshot(snap(next, b.daa), profile);
    return summary(next);
  }
  return {genesis, advance, summary};
}
