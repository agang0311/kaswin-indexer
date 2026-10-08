/** Binary helpers. Application data are not Kaspa wire transactions. */
export class KaswinError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'KaswinError';
    }
}
export function check(ok, code, message = code) {
    if (!ok)
        throw new KaswinError(code, message);
}
export function uint(value, bits = 63) {
    check(typeof value === 'bigint' && value >= 0n && value < (1n << BigInt(bits)), 'INTEGER_RANGE');
    return value;
}
export function integer(n, min, max) {
    check(Number.isSafeInteger(n) && n >= min && n <= max, 'INTEGER_RANGE');
    return n;
}
export function hex(bytes) { return [...bytes].map(x => x.toString(16).padStart(2, '0')).join(''); }
export function unhex(value, length) {
    check(typeof value === 'string' && /^(?:[0-9a-f]{2})*$/.test(value), 'NONCANONICAL_HEX');
    const out = Uint8Array.from(value.match(/../g) ?? [], x => parseInt(x, 16));
    if (length !== undefined)
        check(out.length === length, 'BYTE_LENGTH');
    return out;
}
export function key(value) { unhex(value, 32); return value; }
export function cat(...parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const p of parts) {
        out.set(p, offset);
        offset += p.length;
    }
    return out;
}
export const ascii = (s) => new TextEncoder().encode(s);
export function le(n, width) {
    uint(n, width * 8);
    const b = new Uint8Array(width);
    for (let i = 0; i < width; i++) {
        b[i] = Number(n & 255n);
        n >>= 8n;
    }
    return b;
}
export function fromLe(b) {
    let n = 0n;
    for (let i = b.length - 1; i >= 0; i--)
        n = (n << 8n) | BigInt(b[i]);
    return n;
}
export function same(a, b) {
    if (a.length !== b.length)
        return false;
    let d = 0;
    for (let i = 0; i < a.length; i++)
        d |= a[i] ^ b[i];
    return d === 0;
}
/** Exact decimal KAS parser. Never rounds a floating point amount. */
export function kasToSompi(s) {
    check(/^(0|[1-9][0-9]*)(\.[0-9]{1,8})?$/.test(s), 'BAD_KAS_AMOUNT');
    const [a, b = ''] = s.split('.');
    return BigInt(a) * 100000000n + BigInt(b.padEnd(8, '0'));
}
export function sompiToKas(n) {
    uint(n);
    return `${n / 100000000n}.${(n % 100000000n).toString().padStart(8, '0')}`;
}
export function abortIfNeeded(signal) { signal?.throwIfAborted(); }
/** Unambiguous typed snapshot for mutation checks, NOT a consensus serializer. */
export function stable(value) {
    if (value === null)
        return '["null"]';
    if (value === undefined)
        return '["undefined"]';
    if (typeof value === 'bigint')
        return '["bigint",' + JSON.stringify(value.toString()) + ']';
    if (typeof value === 'string')
        return '["string",' + JSON.stringify(value) + ']';
    if (typeof value === 'boolean')
        return '["boolean",' + JSON.stringify(value) + ']';
    if (typeof value === 'number') {
        check(Number.isFinite(value), 'NONFINITE_NUMBER');
        return '["number",' + (Object.is(value, -0) ? '"-0"' : String(value)) + ']';
    }
    if (value instanceof Uint8Array)
        return '["bytes",' + JSON.stringify(hex(value)) + ']';
    if (Array.isArray(value))
        return '["array",[' + value.map(stable).join(',') + ']]';
    check(typeof value === 'object', 'NON_DATA_VALUE');
    check(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null, 'NON_PLAIN_DTO');
    const o = value;
    return '["object",[' + Object.keys(o).sort().map(k => '[' + JSON.stringify(k) + ',' + stable(o[k]) + ']').join(',') + ']]';
}
//# sourceMappingURL=bytes.js.map