/** Deterministic action preparation (V2, on-chain actions only; no networkGenesis). */
import { ascii, cat, check, fromLe, hex, integer, le, unhex } from './bytes.js';
import { blake2b256 } from './hashes.js';
import { domainHash } from './blake3.js';
import { p2pk } from './covenant-id.js';
import * as S from './state.js';
export const ACTIONS = { BUY: 1, CLOSE: 2, DRAW_AND_PAY: 4, TIMEOUT_REFUND: 9, REFUND: 10 };
const Z = new Uint8Array();
function openingNumber(proof, offset) { const n = fromLe(proof.slice(offset, offset + 8)); check(n < 1n << 63n, 'PASS_A_INTEGER'); return n; }
function openSeq(proof, base, parent) { const ctx = domainHash('SeqCommitMergesetContext', proof.slice(base + 64, base + 88)); const pc = domainHash('SeqCommitmentMerkleBranchHash', cat(ctx, proof.slice(base + 32, base + 64))); const root = domainHash('SeqCommitmentMerkleBranchHash', cat(proof.slice(base, base + 32), pc)); return domainHash('SeqCommitmentMerkleBranchHash', cat(parent, root)); }
export function authenticateDraw(x, s, proof, accessor) {
    check(s.phase === S.Phase.SEALED, 'NOT_SEALED');
    check(proof.length === 240, 'PASS_A_LENGTH');
    check(x.utxoDaa >= 0n && x.utxoDaa < S.DAA_LIMIT - S.TIMEOUT_DELAY, 'ANCHOR_DAA');
    const boundary = x.utxoDaa + S.DRAW_DELAY;
    check(x.currentDaa >= boundary, 'DRAW_TOO_EARLY');
    const pd = openingNumber(proof, 224), td = openingNumber(proof, 104);
    check(pd < boundary && td >= boundary && td < S.DAA_LIMIT, 'PASS_A_FIRST_CROSSING');
    check(openingNumber(proof, 112) > openingNumber(proof, 232), 'PASS_A_BLUE_ORDER');
    openingNumber(proof, 96);
    openingNumber(proof, 216);
    check(hex(proof.slice(0, 32)) === accessor.blockHash, 'PASS_A_TARGET_HASH');
    const p = openSeq(proof, 152, proof.slice(120, 152)), t = openSeq(proof, 32, p);
    check(hex(t) === accessor.sequenceCommitment, 'PASS_A_COMMITMENT');
    const raw = S.encodeLedger(s), frozen = blake2b256(cat(raw.slice(8, 44), s.directory));
    const seed = hex(blake2b256(cat(ascii('KASWIN_V2_DRAW'), unhex(x.covenantId, 32), unhex(x.tip.transactionId, 32), le(BigInt(x.tip.index), 4), frozen, le(boundary, 8), proof.slice(0, 32), t)));
    return { ...s, phase: S.Phase.DRAW_READY, anchorDaa: x.utxoDaa, anchorTxId: x.tip.transactionId, anchorIndex: x.tip.index, seed, targetHash: hex(proof.slice(0, 32)), targetSeq: hex(t) };
}
export function sample(s) {
    integer(s.sold, 3, S.MAX_TICKETS);
    integer(s.counter, 0, 0x7fffffff);
    const digest = blake2b256(cat(ascii('KASWIN_V2_SAMPLE'), unhex(s.seed, 32), le(BigInt(s.counter), 8)));
    const value = fromLe(digest.slice(0, 7)), space = 1n << 56n, limit = space - space % BigInt(s.sold);
    return { value, limit, ticket: value < limit ? Number(value % BigInt(s.sold)) : null };
}
function acceptState(s) { check(s.phase === S.Phase.DRAW_READY, 'NOT_DRAW_READY'); const t = sample(s).ticket; check(t !== null, 'SAMPLE_REJECTED'); return { ...s, phase: S.Phase.WINNER_READY, winnerPlusOne: t + 1 }; }
export function winnerRecord(s) { const t = s.winnerPlusOne - 1; integer(t, 0, s.sold - 1); const r = S.records(s); const i = r.findIndex(p => t < p.end); check(i >= 0, 'WINNER_NOT_FOUND'); return i; }
export function timeoutDaa(x, s) { const d = s.phase === S.Phase.SEALED ? x.utxoDaa : s.anchorDaa; check(d >= 0n && d < S.DAA_LIMIT - S.TIMEOUT_DELAY, 'ANCHOR_DAA'); return d + S.TIMEOUT_DELAY; }
export function availableActions(x, p) {
    const s = S.verifySnapshot(x, p);
    if (s.phase === 1) {
        const a = [];
        if (s.sold < s.config.ticketCap && s.purchaseCount < s.config.purchaseCap)
            a.push('BUY');
        if (s.sold === s.config.ticketCap || s.purchaseCount === s.config.purchaseCap || x.currentDaa >= s.config.closeEligibleDaa)
            a.push('CLOSE');
        return a;
    }
    if (s.phase === 5)
        return ['REFUND'];
    const a = [];
    if (s.phase === 2) {
        if (x.currentDaa >= x.utxoDaa + S.DRAW_DELAY)
            a.push('DRAW_AND_PAY');
        if (x.currentDaa >= timeoutDaa(x, s))
            a.push('TIMEOUT_REFUND');
    }
    return a;
}
/** The supplied network fee must later equal actual input-output difference. */
export function transition(x, p, op, fee, external = 0n) {
    const s = S.verifySnapshot(x, p);
    unhex(op.actorKey, 32);
    check(fee > 0n && fee <= S.MAX_PAY_FEE, 'NETWORK_FEE');
    check(external >= 0n && external < S.VALUE_LIMIT, 'EXTERNAL_VALUE');
    check(availableActions(x, p).includes(op.action), 'ACTION_NOT_AVAILABLE');
    let next = null, terminal = null, lockTime = 0n, sequence = 0n, data = Z, foreignTail = Z, requiredExternal = fee;
    const payments = [];
    const pay = (value, key, role) => { check(value > 0n && value <= S.VALUE_LIMIT, 'PAYMENT_VALUE'); payments.push({ value, spk: p2pk(key), role }); };
    const payout = (state) => { check(external === 0n, 'PAY_HAS_EXTERNAL_INPUT'); check(fee <= S.MAX_PAY_FEE, 'PAY_FEE_CAP'); const i = winnerRecord(state), r = S.records(state)[i]; const prize = BigInt(state.sold) * state.config.ticketPrice - S.FINALIZER - fee; check(prize >= S.MIN_PRICE, 'WINNER_MINIMUM'); pay(prize, r.key, 'WINNER'); pay(S.DEPOSIT, state.ownerKey, 'CREATOR'); pay(S.FINALIZER, op.actorKey, 'EXECUTOR'); data = le(BigInt(i), 4); terminal = 'PAID'; requiredExternal = 0n; };
    switch (op.action) {
        case 'BUY': {
            check(op.quantity !== undefined, 'QUANTITY_MISSING');
            next = S.appendPurchase(s, op.quantity, op.actorKey);
            data = le(BigInt(op.quantity), 4);
            requiredExternal = BigInt(op.quantity) * s.config.ticketPrice + fee;
            break;
        }
        case 'CLOSE': {
            if (s.sold < s.config.ticketCap && s.purchaseCount < s.config.purchaseCap)
                lockTime = s.config.closeEligibleDaa - 1n;
            if (s.sold === 0) {
                terminal = 'EMPTY';
                pay(S.DEPOSIT, s.ownerKey, 'CREATOR');
            }
            else {
                next = { ...s, phase: s.sold >= s.config.minTickets ? S.Phase.SEALED : S.Phase.REFUNDING };
                foreignTail = p.frames[S.phaseModule(next.phase)].tail;
            }
            break;
        }
        case 'DRAW_AND_PAY': {
            check(op.opening && op.accessor, 'DRAW_PROOF_MISSING');
            const drawn = authenticateDraw(x, s, op.opening, op.accessor);
            sequence = S.DRAW_DELAY;
            payout(acceptState(drawn));
            data = cat(op.opening, data);
            break;
        }
        case 'TIMEOUT_REFUND': {
            const deadline = timeoutDaa(x, s);
            check(x.currentDaa >= deadline, 'TIMEOUT_EARLY');
            sequence = S.TIMEOUT_DELAY;
            next = { ...s, phase: S.Phase.REFUNDING, anchorDaa: deadline - S.TIMEOUT_DELAY };
            foreignTail = p.frames.refunding.tail;
            break;
        }
        case 'REFUND': {
            const remaining = s.purchaseCount - s.cursor, k = Math.min(32, remaining), end = s.cursor + k, r = S.records(s), last = end === s.purchaseCount;
            check(k > 0, 'NO_REFUND_RECORDS');
            for (let i = s.cursor; i < end; i++) {
                const q = r[i];
                pay(BigInt(q.count) * s.config.ticketPrice - S.REFUND_FEE, q.key, 'BUYER_REFUND');
            }
            if (last) {
                terminal = 'REFUNDED';
                pay(S.DEPOSIT, s.ownerKey, 'CREATOR');
            }
            else
                next = { ...s, cursor: end };
            const pool = BigInt(k) * S.REFUND_FEE;
            check(external + pool > fee, 'REFUND_FEE_POOL');
            pay(external + pool - fee, op.actorKey, 'EXECUTOR');
            requiredExternal = fee >= pool ? fee - pool + 1n : 0n;
            break;
        }
    }
    const paidAction = op.action === 'DRAW_AND_PAY';
    if (!paidAction && op.action !== 'REFUND') {
        check(external >= requiredExternal, 'INSUFFICIENT_FUNDING');
        if (external > requiredExternal)
            pay(external - requiredExternal, op.actorKey, 'CHANGE');
    }
    if (next)
        S.validateLedger(next);
    return { next, terminal, payments, data, lockTime, sequence, requiredExternal, foreignTail };
}
/** Provisional sizing envelope only. V2 VM calibration is pending; the web build must
 * bind a new budgetProfileId before release. Old measurements are NOT V2 evidence. */
export function actionUnits(action, s) {
    const pc = s.purchaseCount;
    switch (action) {
        case 'BUY': return 201600 + 4000 * pc;
        case 'CLOSE': return pc === 0 ? 142100 : s.sold >= s.config.minTickets ? 226400 + 3700 * pc : 275100 + 3700 * pc;
        case 'DRAW_AND_PAY': return 230000 + 7000 * pc;
        case 'TIMEOUT_REFUND': return 290800 + 2850 * pc;
        case 'REFUND': {
            const k = Math.min(32, pc - s.cursor), last = s.cursor + k === pc;
            return s.cursor === 0 ? (last ? 221200 + 3420 * k + 71 * k * k : 371100 + 5330 * pc) : (last ? 230100 + 3240 * pc + 950 * k + 72 * pc * k : 379500 + 6120 * pc);
        }
        default:
            check(false, 'NO_CALIBRATED_BUDGET');
            return 0;
    }
}
export const BUDGET_MARGIN = 3, GENESIS_INPUT_BUDGET = 10, FUNDING_INPUT_BUDGET = 10;
export function actionBudget(action, s) {
    if (action === 'GENESIS')
        return GENESIS_INPUT_BUDGET;
    check(s !== undefined && s !== null, 'LEDGER_REQUIRED_FOR_BUDGET');
    const units = actionUnits(action, s);
    return Math.max(0, Math.ceil((units - 9999) / 10000)) + BUDGET_MARGIN;
}
export const budgetOf = actionBudget;
//# sourceMappingURL=protocol.js.map