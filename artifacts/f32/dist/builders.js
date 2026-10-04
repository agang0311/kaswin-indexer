/** Exact F4-1 transaction DTOs and ABI witness. Native SDK finalization/mass is separate. */
import { ascii, cat, check, hex, integer, le, unhex, stable } from './bytes.js';
import { blake2b256 } from './hashes.js';
import { p2pk, p2sh, spkBytes } from './covenant-id.js';
import { validateTransaction, outpointKey } from './transaction.js';
import * as S from './state.js';
import { ACTIONS, transition, actionBudget } from './protocol.js';
import { REGISTRATION_SOMPI, checkRegistrySpk } from './registry.js';
export function pushInt(n) {
    check(n >= 0n && n < 1n << 63n, 'SCRIPT_NUMBER');
    if (n === 0n)
        return new Uint8Array([0]);
    if (n <= 16n)
        return new Uint8Array([0x50 + Number(n)]);
    const a = [];
    while (n) {
        a.push(Number(n & 255n));
        n >>= 8n;
    }
    if (a[a.length - 1] & 128)
        a.push(0);
    return S.pushBytes(new Uint8Array(a));
}
export function witness(x, p, op, t, fee) {
    const s = S.decodeLedger(x.ledger), m = S.phaseModule(s.phase), f = p.frames[m];
    const bytes = cat(pushInt(BigInt(ACTIONS[op.action])), S.pushBytes(unhex(x.origin.transactionId, 32)), pushInt(BigInt(x.origin.index)), pushInt(BigInt(f.tail.length)), S.pushBytes(m === 'open' ? new Uint8Array() : p.frames.open.tail), S.pushBytes(t.foreignTail), S.pushBytes(t.data), S.pushBytes(unhex(op.actorKey, 32)), pushInt(fee), S.pushBytes(unhex(f.dispatchTag, 4)), S.pushBytes(S.scriptOf(s, p)));
    check(bytes.length <= 250000, 'SIGNATURE_SCRIPT_LIMIT');
    return hex(bytes);
}
function fundingInputs(funds, key) {
    integer(funds.length, 0, 8);
    const seen = new Set();
    for (const f of funds) {
        check(f.value > 0n && f.value < S.VALUE_LIMIT, 'FUNDING_VALUE');
        check(f.covenantId === undefined || f.covenantId === null || f.covenantId === S.ZERO, 'FUNDING_COVENANT');
        check(stable(f.spk) === stable(p2pk(key)), 'FUNDING_OWNER');
        const id = outpointKey(f.outpoint);
        check(!seen.has(id), 'DUPLICATE_INPUT');
        seen.add(id);
    }
}
const txBase = () => ({ version: 1, inputs: [], outputs: [], lockTime: 0n, subnetworkId: '00'.repeat(20), gas: 0n, payload: '', storageMass: 0n });
export function buildAction(x, p, op, fee, funds, computeBudget, payload = '') {
    const s = S.verifySnapshot(x, p);
    const budget = integer(computeBudget ?? actionBudget(op.action, s), 0, 65535);
    fundingInputs(funds, op.actorKey);
    const total = funds.reduce((v, f) => v + f.value, 0n), t = transition(x, p, op, fee, total);
    check(!funds.some(f => outpointKey(f.outpoint) === outpointKey(x.tip)), 'DUPLICATE_INPUT');
    const tx = txBase();
    tx.lockTime = t.lockTime;
    tx.payload = payload;
    tx.inputs.push({ previousOutpoint: x.tip, signatureScript: witness(x, p, op, t, fee), sequence: t.sequence, computeBudget: budget });
    tx.inputs.push(...funds.map(f => ({ previousOutpoint: f.outpoint, signatureScript: '', sequence: 0n, computeBudget: 0 })));
    if (t.next)
        tx.outputs.push({ value: S.valueOf(t.next), scriptPublicKey: p2sh(hex(blake2b256(S.scriptOf(t.next, p)))), covenant: { covenantId: x.covenantId, authorizingInput: 0 } });
    tx.outputs.push(...t.payments.map(v => ({ value: v.value, scriptPublicKey: v.spk, covenant: null })));
    const input0 = { outpoint: x.tip, value: x.value, spk: { ...x.scriptPublicKey }, daa: x.utxoDaa, covenantId: x.covenantId };
    const draft = { transaction: tx, inputUtxos: [input0, ...funds], authorizedInputIndices: funds.map((_, i) => i + 1), transition: t, origin: x.origin, action: op.action, walletDebit: 0n, fee };
    // An executor return includes its own sponsor principal; only net debit is authorized.
    const change = t.payments.filter(v => v.role === 'CHANGE' || (op.action === 'REFUND' && v.role === 'EXECUTOR')).reduce((a, v) => a + v.value, 0n);
    draft.walletDebit = total > change ? total - change : 0n;
    assertDraft(draft);
    return draft;
}
export function buildOpenGenesis(p, owner, config, funds, fee, registrySpk) {
    check(funds.length >= 1, 'FUNDING_REQUIRED');
    fundingInputs(funds, owner);
    const total = funds.reduce((a, f) => a + f.value, 0n), registration = registrySpk ? REGISTRATION_SOMPI : 0n;
    check(fee > 0n && total >= S.DEPOSIT + registration + fee, 'GENESIS_FUNDS');
    const routes = Object.fromEntries(S.MODULES.map(m => [m, p.frames[m].templateHash]));
    const s = S.newOpen(owner, p.networkGenesis, routes, config);
    S.validateLedger(s);
    const script = S.scriptOf(s, p), origin = funds[0].outpoint, cid = S.rootId(origin, script);
    const tx = txBase();
    tx.payload = hex(cat(ascii('KASWIN_F3_GENESIS'), unhex(p.id, 32), S.encodeLedger(s)));
    tx.inputs = funds.map(f => ({ previousOutpoint: f.outpoint, signatureScript: '', sequence: 0n, computeBudget: 0 }));
    tx.outputs = [{ value: S.DEPOSIT, scriptPublicKey: p2sh(hex(blake2b256(script))), covenant: { covenantId: cid, authorizingInput: 0 } }];
    if (registrySpk)
        tx.outputs.push({ value: REGISTRATION_SOMPI, scriptPublicKey: checkRegistrySpk(registrySpk), covenant: null });
    if (total > S.DEPOSIT + registration + fee)
        tx.outputs.push({ value: total - S.DEPOSIT - registration - fee, scriptPublicKey: p2pk(owner), covenant: null });
    const d = { transaction: tx, inputUtxos: [...funds], authorizedInputIndices: funds.map((_, i) => i), transition: null, origin, action: 'CREATE_ROUND', walletDebit: S.DEPOSIT + registration + fee, fee };
    assertDraft(d);
    return d;
}
export function assertDraft(d) {
    validateTransaction(d.transaction);
    check(d.inputUtxos.length === d.transaction.inputs.length, 'INPUT_MATERIAL');
    check(new Set(d.transaction.inputs.map(i => outpointKey(i.previousOutpoint))).size === d.transaction.inputs.length, 'DUPLICATE_INPUT');
    for (let i = 0; i < d.inputUtxos.length; i++)
        check(outpointKey(d.inputUtxos[i].outpoint) === outpointKey(d.transaction.inputs[i].previousOutpoint), 'UTXO_MISMATCH');
    const input = d.inputUtxos.reduce((a, v) => a + v.value, 0n), output = d.transaction.outputs.reduce((a, v) => a + v.value, 0n);
    check(input - output === d.fee && d.fee > 0n, 'FEE_MISMATCH');
    check(d.transaction.outputs.every(v => v.value > 0n), 'NONPOSITIVE_OUTPUT');
}
/** Receipt marker recipe: per-owner/tag address, permissionless spending to FIXED owner.
 * It is NOT an arbitrary pre-existing shared OP_TRUE registry address. */
export function beaconRedeem(owner, tag = 'KASWIN_BEACON_F4') {
    const b = ascii(tag);
    check(b.length <= 64, 'BEACON_TAG');
    unhex(owner, 32);
    return cat(S.pushBytes(b), unhex('75b35188b4518800be'), pushInt(S.DEPOSIT), unhex('8800cf'), S.pushBytes(unhex(S.ZERO)), unhex('8800c2'), pushInt(19800000n), unhex('8800d5'), S.pushBytes(unhex(S.ZERO)), unhex('8800c3'), S.pushBytes(spkBytes(p2pk(owner))), unhex('87'));
}
export function buildBeaconReclaim(outpoint, owner, tag, daa, budget) {
    const redeem = beaconRedeem(owner, tag), spk = p2sh(hex(blake2b256(redeem)));
    const tx = txBase();
    tx.inputs = [{ previousOutpoint: outpoint, signatureScript: hex(S.pushBytes(redeem)), sequence: 0n, computeBudget: integer(budget, 0, 65535) }];
    tx.outputs = [{ value: 19800000n, scriptPublicKey: p2pk(owner), covenant: null }];
    const d = { transaction: tx, inputUtxos: [{ outpoint, value: S.DEPOSIT, spk, daa, covenantId: null }], authorizedInputIndices: [], transition: null, origin: outpoint, action: 'BEACON_RECLAIM', walletDebit: 0n, fee: 200000n };
    assertDraft(d);
    return d;
}
export function createAnnouncement(p, origin, tag) {
    // B's own txid is NOT embedded. The announcement points to output 0 locally.
    const t = ascii(tag);
    check(t.length <= 64, 'BEACON_TAG');
    return hex(cat(ascii('KASWIN_F4_CREATE'), unhex(p.id, 32), unhex(p.networkGenesis, 32), unhex(origin.transactionId, 32), le(BigInt(origin.index), 4), le(0n, 4), le(BigInt(t.length), 1), t));
}
//# sourceMappingURL=builders.js.map