/** Fixed-revision Kaspa txid reference codec. Not an SDK/mass/signature implementation. */
import { check, integer, uint, cat, le, unhex, hex, ascii, stable } from './bytes.js';
import { blake2b256 } from './hashes.js';
import { domainHash } from './blake3.js';
export function validateTransaction(t) {
    integer(t.version, 0, 1);
    integer(t.inputs.length, 0, 65535);
    integer(t.outputs.length, 0, 65535);
    for (const i of t.inputs) {
        unhex(i.previousOutpoint.transactionId, 32);
        integer(i.previousOutpoint.index, 0, 0xffffffff);
        unhex(i.signatureScript);
        uint(i.sequence, 64);
        if (i.computeBudget !== undefined)
            integer(i.computeBudget, 0, 65535);
        if (i.sigOpCount !== undefined)
            integer(i.sigOpCount, 0, 255);
    }
    for (const o of t.outputs) {
        uint(o.value, 64);
        integer(o.scriptPublicKey.version, 0, 65535);
        unhex(o.scriptPublicKey.script);
        if (o.covenant) {
            check(t.version === 1, 'V0_COVENANT');
            unhex(o.covenant.covenantId, 32);
            integer(o.covenant.authorizingInput, 0, t.inputs.length - 1);
        }
    }
    uint(t.lockTime, 64);
    unhex(t.subnetworkId, 20);
    uint(t.gas, 64);
    uint(t.storageMass, 64);
    check(unhex(t.payload).length <= 16 * 1024 * 1024, 'PAYLOAD_LIMIT');
}
/** Signature scripts, sigop counts, budgets and mass are excluded by consensus txid hashing. */
export function transactionIdPreimage(t, emptyPayload) {
    validateTransaction(t);
    const parts = [le(BigInt(t.version), 2), le(BigInt(t.inputs.length), 8)];
    for (const i of t.inputs)
        parts.push(unhex(i.previousOutpoint.transactionId, 32), le(BigInt(i.previousOutpoint.index), 4), le(0n, 8), le(i.sequence, 8));
    parts.push(le(BigInt(t.outputs.length), 8));
    for (const o of t.outputs) {
        const script = unhex(o.scriptPublicKey.script);
        parts.push(le(o.value, 8), le(BigInt(o.scriptPublicKey.version), 2), le(BigInt(script.length), 8), script);
        if (t.version === 1) {
            parts.push(new Uint8Array([o.covenant ? 1 : 0]));
            if (o.covenant)
                parts.push(le(BigInt(o.covenant.authorizingInput), 2), unhex(o.covenant.covenantId, 32));
        }
    }
    const payload = emptyPayload ? new Uint8Array() : unhex(t.payload);
    parts.push(le(t.lockTime, 8), unhex(t.subnetworkId, 20), le(t.gas, 8), le(BigInt(payload.length), 8), payload);
    return cat(...parts);
}
export function referenceTxId(t) {
    if (t.version === 0)
        return hex(blake2b256(transactionIdPreimage(t, false), ascii('TransactionID')));
    check(t.version === 1, 'TX_VERSION');
    const payload = domainHash('PayloadDigest', unhex(t.payload)), rest = domainHash('TransactionRest', transactionIdPreimage(t, true));
    return hex(domainHash('TransactionV1Id', cat(payload, rest)));
}
/** Do not compare txids alone: txids intentionally exclude some protected signing fields. */
export function assertOnlyAuthorizedSignaturesChanged(before, after, authorized) {
    validateTransaction(before);
    validateTransaction(after);
    const seen = new Set();
    for (const i of authorized) {
        integer(i, 0, before.inputs.length - 1);
        check(!seen.has(i), 'DUPLICATE_SIGN_INDEX');
        seen.add(i);
    }
    const scrub = (tx) => ({ ...tx, inputs: tx.inputs.map((i, n) => ({ ...i, signatureScript: seen.has(n) ? '' : i.signatureScript })) });
    check(stable(scrub(before)) === stable(scrub(after)), 'WALLET_MUTATED_TRANSACTION');
    for (const i of authorized) {
        const sig = unhex(after.inputs[i].signatureScript);
        check(sig.length === 66 && sig[0] === 0x41 && sig[65] === 1, 'ORDINARY_SIGNATURE_FORMAT');
    }
}
export function outpointKey(o) { unhex(o.transactionId, 32); integer(o.index, 0, 0xffffffff); return `${o.transactionId}:${o.index}`; }
//# sourceMappingURL=transaction.js.map