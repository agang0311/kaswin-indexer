/** KIP-20 bytes; no signature, no RPC attestation, no fabricated Factory hash. */
import { ascii, cat, check, hex, integer, le, unhex, uint } from './bytes.js';
import { blake2b256 } from './hashes.js';
export function p2sh(scriptHash, version = 0) {
    unhex(scriptHash, 32);
    integer(version, 0, 65535);
    return { version, script: 'aa20' + scriptHash + '87' };
}
export function p2pk(publicKey) {
    unhex(publicKey, 32);
    return { version: 0, script: '20' + publicKey + 'ac' };
}
export function spkBytes(spk) {
    integer(spk.version, 0, 65535);
    return cat(le(BigInt(spk.version), 2), unhex(spk.script));
}
export function covenantPreimage(origin, outputs) {
    const txid = unhex(origin.transactionId, 32);
    integer(origin.index, 0, 0xffffffff);
    check(outputs.length > 0 && outputs.length <= 65536, 'AUTH_COUNT');
    const parts = [txid, le(BigInt(origin.index), 4), le(BigInt(outputs.length), 8)];
    let previous = -1;
    for (const output of outputs) {
        integer(output.index, 0, 0xffffffff);
        check(output.index > previous, 'AUTH_ORDER');
        previous = output.index;
        uint(output.value, 64);
        integer(output.spk.version, 0, 65535);
        const script = unhex(output.spk.script);
        check(script.length <= 1000000, 'SPK_LIMIT');
        parts.push(le(BigInt(output.index), 4), le(output.value, 8), le(BigInt(output.spk.version), 2), le(BigInt(script.length), 8), script);
    }
    return cat(...parts);
}
export function covenantId(origin, outputs) {
    return hex(blake2b256(covenantPreimage(origin, outputs), ascii('CovenantID')));
}
//# sourceMappingURL=covenant-id.js.map