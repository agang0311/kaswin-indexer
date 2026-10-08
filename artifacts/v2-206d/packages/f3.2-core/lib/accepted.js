/** Interpretation of ALREADY ACCEPTED V2 transactions, not a VM or acceptance proof.
 * The caller establishes selected-chain acceptance and authenticates the spent UTXO.
 * Unlike transition() (our builder policy), this mirrors the pinned SIL constraints:
 * every action binds real fee; REFUND binds the executor output. Other auxiliary
 * outputs remain outside the builder's stricter change-layout policy.
 * It is scoped to canonical OPEN lineages verified by verifySnapshot(), not arbitrary
 * directly-created SEALED/REFUNDING lookalikes. Other input scripts, covenant contexts,
 * finality and the native PASS-A accessor remain the accepting node's responsibility. */
import { cat, check, fromLe, hex, integer, same, stable, unhex, uint } from './bytes.js';
import { p2pk, p2sh } from './covenant-id.js';
import { blake2b256 } from './hashes.js';
import { domainHash } from './blake3.js';
import * as S from './state.js';
import { ACTIONS, authenticateDraw, sample } from './protocol.js';
import { outpointKey, validateTransaction } from './transaction.js';
export function scriptPushes(bytes) {
    check(bytes.length <= 250000, 'WITNESS_SIZE');
    const out = [];
    let i = 0;
    while (i < bytes.length) {
        const op = bytes[i++];
        let n;
        if (op === 0) {
            out.push(new Uint8Array());
            continue;
        }
        if (op === 0x4f) {
            out.push(Uint8Array.of(0x81));
            continue;
        }
        if (op >= 0x51 && op <= 0x60) {
            out.push(Uint8Array.of(op - 0x50));
            continue;
        }
        if (op <= 75)
            n = op;
        else {
            check(op >= 0x4c && op <= 0x4e, 'NON_PUSH_WITNESS');
            const width = op === 0x4c ? 1 : op === 0x4d ? 2 : 4;
            check(i + width <= bytes.length, 'PUSH_HEADER');
            n = Number(fromLe(bytes.slice(i, i + width)));
            i += width;
        }
        check(i + n <= bytes.length, 'PUSH_TRUNCATED');
        out.push(bytes.slice(i, i + n));
        i += n;
    }
    return out;
}
/** SIL int ABI: signed ScriptNum, at most 8 bytes; fee is subsequently constrained. */
export function scriptNumber(bytes) {
    check(bytes.length <= 8, 'SCRIPT_NUMBER_LENGTH');
    if (!bytes.length)
        return 0n;
    const negative = (bytes.at(-1) & 128) !== 0, copy = bytes.slice();
    copy[copy.length - 1] = copy.at(-1) & 127;
    const n = fromLe(copy);
    return negative ? -n : n;
}
const actionName = (b) => {
    const n = scriptNumber(b), a = Object.keys(ACTIONS).find(a => BigInt(ACTIONS[a]) === n);
    check(a, 'UNSUPPORTED_ACTION');
    return a;
};
const u32 = (b) => { check(b.length === 4, 'DATA_U32'); return integer(Number(fromLe(b)), 0, 0x7fffffff); };
export function targetSeqOf(opening) {
    check(opening.length === 240, 'PASS_A_LENGTH');
    const branch = (a, b) => domainHash('SeqCommitmentMerkleBranchHash', cat(a, b));
    const seq = (base, parent) => branch(parent, branch(opening.slice(base, base + 32), branch(domainHash('SeqCommitMergesetContext', opening.slice(base + 64, base + 88)), opening.slice(base + 32, base + 64))));
    return hex(seq(32, seq(152, opening.slice(120, 152))));
}
export function decodeSpend(script, profile, contextOrigin) {
    const pushes = scriptPushes(unhex(script)), redeem = pushes.at(-1);
    check(redeem && redeem[0] === 0x6b, 'REDEEM_FORMAT');
    const module = S.MODULES.find(m => { const t = profile.frames[m].tail; return redeem.length > t.length && same(redeem.slice(-t.length), t); });
    check(module, 'UNPINNED_TEMPLATE');
    const shift = module === 'open' ? 2 : 0, frame = profile.frames[module];
    check(pushes.length === 8 + shift, 'SPEND_ABI');
    const fields = scriptPushes(redeem.slice(1, -frame.tail.length));
    check(fields.length === 1, 'LEDGER_PUSH_COUNT');
    const ledger = fields[0], spent = S.decodeLedger(ledger);
    check(module === S.phaseModule(spent.phase) && same(redeem, S.scriptOf(spent, profile)), 'REDEEM_STATE_TEMPLATE');
    const origin = module === 'open' ? { transactionId: hex(pushes[1]), index: Number(scriptNumber(pushes[2])) } : contextOrigin;
    check(origin, 'ORIGIN_REQUIRED');
    unhex(origin.transactionId, 32);
    integer(origin.index, 0, 0x7fffffff);
    if (contextOrigin)
        check(stable(origin) === stable(contextOrigin), 'ORIGIN_MISMATCH');
    check(scriptNumber(pushes[1 + shift]) === BigInt(frame.tail.length), 'TAIL_LENGTH');
    check(hex(pushes[6 + shift]) === frame.dispatchTag, 'DISPATCH_TAG');
    const actorKey = hex(pushes[4 + shift]);
    unhex(actorKey, 32);
    return { action: actionName(pushes[0]), module, spent, ledger, origin, actorKey,
        data: pushes[3 + shift], nextTail: pushes[2 + shift], witnessFee: scriptNumber(pushes[5 + shift]) };
}
export function interpretAccepted(x, p, tx, inputValues) {
    validateTransaction(tx);
    const s = S.verifySnapshot(x, p);
    check(tx.version === 1 && tx.inputs.length >= 1 && tx.inputs.length <= 9 && tx.outputs.length >= 1 && tx.outputs.length <= 34, 'TX_TOPOLOGY');
    check(outpointKey(tx.inputs[0].previousOutpoint) === outpointKey(x.tip), 'SPENT_OUTPOINT');
    check(new Set(tx.inputs.map(i => outpointKey(i.previousOutpoint))).size === tx.inputs.length, 'DUPLICATE_INPUT');
    const w = decodeSpend(tx.inputs[0].signatureScript, p, x.origin);
    check(same(w.ledger, x.ledger), 'SPENT_LEDGER');
    const allowed = w.module === 'open' ? ['BUY', 'CLOSE'] : w.module === 'sealed' ? ['DRAW_AND_PAY', 'TIMEOUT_REFUND'] : ['REFUND'];
    check(allowed.includes(w.action), 'ACTION_PHASE');
    let fee = null, external = null;
    if (inputValues) {
        check(inputValues.length === tx.inputs.length && inputValues[0] === x.value, 'INPUT_VALUES');
        inputValues.forEach(v => { uint(v, 64); check(v > 0n && v <= S.VALUE_LIMIT, 'INPUT_VALUE'); });
        external = inputValues.slice(1).reduce((a, v) => a + v, 0n);
        fee = x.value + external - tx.outputs.reduce((a, o) => a + o.value, 0n);
        check(fee >= 0n, 'NEGATIVE_FEE');
    }
    else if (tx.inputs.length === 1) {
        external = 0n;
        fee = x.value - tx.outputs.reduce((a, o) => a + o.value, 0n);
        check(fee >= 0n, 'NEGATIVE_FEE');
    }
    // New Profile no longer treats the fee witness as free data. Missing funding
    // context means incomplete evidence, not consensus invalidity or a guessed fee.
    check(fee !== null && external !== null, 'INPUT_VALUES_REQUIRED');
    check(x.value > 0n && x.value <= S.VALUE_LIMIT, 'INPUT_VALUE');
    check(tx.outputs.every(o => o.value > 0n && o.value <= S.VALUE_LIMIT), 'OUTPUT_VALUE');
    check(fee > 0n && fee <= S.MAX_PAY_FEE && fee === w.witnessFee, 'FEE_MISMATCH');
    const outputs = tx.outputs.map(o => ({ ...o, role: 'AUXILIARY', constrained: false }));
    const ordinary = (index, value, key, role) => {
        const o = outputs[index];
        check(o && value > 0n && value <= S.VALUE_LIMIT && o.value === value && stable(o.scriptPublicKey) === stable(p2pk(key)) && !o.covenant, 'PAYOUT_MISMATCH');
        o.role = role;
        o.constrained = true;
    };
    const age = (required) => {
        const seq = tx.inputs[0].sequence;
        check((seq & (1n << 63n)) === 0n && (seq & 0xffffffffn) >= required, 'SEQUENCE_REQUIREMENT');
        check(x.currentDaa >= x.utxoDaa + required, 'AGE_REQUIREMENT');
    };
    let next = null, terminal = null;
    let draw = null, winner = null;
    switch (w.action) {
        case 'BUY':
            check(tx.inputs.length >= 2 && w.nextTail.length === 0, 'BUY_TOPOLOGY');
            next = S.appendPurchase(s, u32(w.data), w.actorKey);
            break;
        case 'CLOSE':
            check(tx.inputs.length >= 2 && w.data.length === 0, 'CLOSE_TOPOLOGY');
            if (s.sold < s.config.ticketCap && s.purchaseCount < s.config.purchaseCap) {
                check(tx.lockTime >= s.config.closeEligibleDaa - 1n && tx.lockTime < S.DAA_LIMIT && tx.inputs[0].sequence !== (1n << 64n) - 1n, 'CLOSE_LOCKTIME');
                check(x.currentDaa >= s.config.closeEligibleDaa, 'CLOSE_TOO_EARLY');
            }
            if (s.sold === 0) {
                check(w.nextTail.length === 0, 'EMPTY_TAIL');
                terminal = 'EMPTY';
                ordinary(0, S.DEPOSIT, s.ownerKey, 'CREATOR');
            }
            else
                next = { ...s, phase: s.sold >= s.config.minTickets ? S.Phase.SEALED : S.Phase.REFUNDING };
            break;
        case 'DRAW_AND_PAY': {
            check(tx.inputs.length === 1 && tx.outputs.length === 3 && w.data.length === 244 && w.nextTail.length === 0, 'DRAW_TOPOLOGY');
            age(S.DRAW_DELAY);
            const opening = w.data.slice(0, 240), seq = targetSeqOf(opening), target = hex(opening.slice(0, 32));
            // The native accessor was executed by consensus; recomputing this root alone is NOT its replacement.
            const drawn = authenticateDraw(x, s, opening, { blockHash: target, sequenceCommitment: seq }), smp = sample(drawn);
            check(smp.ticket !== null, 'SAMPLE_REJECTED');
            const hint = u32(w.data.slice(240)), records = S.records(s);
            integer(hint, 0, records.length - 1);
            const r = records[hint];
            check(smp.ticket >= r.end - r.count && smp.ticket < r.end, 'WINNER_HINT');
            check(fee !== null && fee === w.witnessFee && fee <= S.MAX_PAY_FEE, 'DRAW_FEE');
            const prize = BigInt(s.sold) * s.config.ticketPrice - S.FINALIZER - fee;
            check(prize >= S.MIN_PRICE, 'WINNER_MINIMUM');
            ordinary(0, prize, r.key, 'WINNER');
            ordinary(1, S.DEPOSIT, s.ownerKey, 'CREATOR');
            ordinary(2, S.FINALIZER, w.actorKey, 'EXECUTOR');
            terminal = 'PAID';
            draw = { opening: hex(opening), target, seqCommit: seq, boundaryDaa: (x.utxoDaa + S.DRAW_DELAY).toString() };
            winner = { record: hint, ticket: smp.ticket + 1, key: r.key, ticketsInRecord: r.count, firstTicket: r.end - r.count + 1, lastTicket: r.end, prize };
            break;
        }
        case 'TIMEOUT_REFUND':
            check(w.data.length === 0 && x.utxoDaa < S.DAA_LIMIT - S.TIMEOUT_DELAY, 'TIMEOUT_DATA');
            age(S.TIMEOUT_DELAY);
            next = { ...s, phase: S.Phase.REFUNDING, anchorDaa: x.utxoDaa };
            break;
        case 'REFUND': {
            check(w.data.length === 0 && w.nextTail.length === 0, 'REFUND_DATA');
            const k = Math.min(32, s.purchaseCount - s.cursor), end = s.cursor + k, last = end === s.purchaseCount, records = S.records(s);
            check(k > 0 && tx.outputs.length === k + 2, 'REFUND_TOPOLOGY');
            for (let i = 0; i < k; i++) {
                const r = records[s.cursor + i];
                ordinary((last ? 0 : 1) + i, BigInt(r.count) * s.config.ticketPrice - S.REFUND_FEE, r.key, 'BUYER_REFUND');
            }
            if (last) {
                terminal = 'REFUNDED';
                ordinary(k, S.DEPOSIT, s.ownerKey, 'CREATOR');
            }
            else
                next = { ...s, cursor: end };
            ordinary(k + 1, external + BigInt(k) * S.REFUND_FEE - fee, w.actorKey, 'EXECUTOR');
            break;
        }
    }
    const familyOutputs = tx.outputs.flatMap((o, i) => o.covenant?.covenantId === x.covenantId ? [i] : []);
    if (next) {
        S.validateLedger(next);
        const module = S.phaseModule(next.phase);
        if (module !== w.module)
            check(same(w.nextTail, p.frames[module].tail), 'FOREIGN_TEMPLATE');
        const spk = p2sh(hex(blake2b256(S.scriptOf(next, p)))), o = outputs[0];
        check(familyOutputs.length === 1 && familyOutputs[0] === 0 && o.covenant?.authorizingInput === 0 &&
            stable(o.scriptPublicKey) === stable(spk) && o.value === S.valueOf(next), 'SUCCESSOR_MISMATCH');
        o.role = 'STATE';
        o.constrained = true;
    }
    else
        check(terminal !== null && familyOutputs.length === 0, 'TERMINAL_FAMILY');
    return { action: w.action, module: w.module, actorKey: w.actorKey, spent: s, next, terminal, witnessFee: w.witnessFee, fee, external,
        outputs, constrainedOutputs: outputs.filter(o => o.constrained).length, draw, winner };
}
//# sourceMappingURL=accepted.js.map