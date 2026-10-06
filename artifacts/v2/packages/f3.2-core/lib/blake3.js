/** Portable BLAKE3-256 reference. Tested against upstream vectors; not a crypto audit. */
import { check, ascii } from './bytes.js';
const IV = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
const PERM = [2, 6, 3, 10, 7, 0, 4, 13, 1, 11, 12, 5, 9, 14, 15, 8];
const START = 1, END = 2, PARENT = 4, ROOT = 8, KEYED = 16;
const rr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0;
function words(bytes, size) {
    const b = new Uint8Array(size * 4);
    b.set(bytes);
    const v = new DataView(b.buffer);
    return Array.from({ length: size }, (_, i) => v.getUint32(i * 4, true));
}
function compress(cv, message, counter, len, flags) {
    const v = [...cv, ...IV.slice(0, 4), counter >>> 0, Math.floor(counter / 4294967296) >>> 0, len, flags];
    let m = [...message];
    const g = (a, b, c, d, x, y) => {
        v[a] = (v[a] + v[b] + x) >>> 0;
        v[d] = rr(v[d] ^ v[a], 16);
        v[c] = (v[c] + v[d]) >>> 0;
        v[b] = rr(v[b] ^ v[c], 12);
        v[a] = (v[a] + v[b] + y) >>> 0;
        v[d] = rr(v[d] ^ v[a], 8);
        v[c] = (v[c] + v[d]) >>> 0;
        v[b] = rr(v[b] ^ v[c], 7);
    };
    for (let r = 0; r < 7; r++) {
        g(0, 4, 8, 12, m[0], m[1]);
        g(1, 5, 9, 13, m[2], m[3]);
        g(2, 6, 10, 14, m[4], m[5]);
        g(3, 7, 11, 15, m[6], m[7]);
        g(0, 5, 10, 15, m[8], m[9]);
        g(1, 6, 11, 12, m[10], m[11]);
        g(2, 7, 8, 13, m[12], m[13]);
        g(3, 4, 9, 14, m[14], m[15]);
        m = PERM.map(i => m[i]);
    }
    return [...Array.from({ length: 8 }, (_, i) => (v[i] ^ v[i + 8]) >>> 0), ...Array.from({ length: 8 }, (_, i) => (v[i + 8] ^ cv[i]) >>> 0)];
}
const chain = (o) => compress(o.cv, o.message, o.counter, o.len, o.flags).slice(0, 8);
function chunk(bytes, counter, key, flags) {
    let cv = [...key];
    const blocks = Math.max(1, Math.ceil(bytes.length / 64));
    for (let i = 0; i < blocks; i++) {
        const part = bytes.subarray(i * 64, (i + 1) * 64), f = flags | (i === 0 ? START : 0) | (i === blocks - 1 ? END : 0);
        const output = { cv, message: words(part, 16), counter, len: part.length, flags: f };
        if (i === blocks - 1)
            return output;
        cv = chain(output);
    }
    throw new Error('unreachable chunk');
}
function tree(data, start, count, key, flags) {
    if (count === 1)
        return chunk(data.subarray(start * 1024, (start + 1) * 1024), start, key, flags);
    let left = 1;
    while (left * 2 < count)
        left *= 2;
    const a = chain(tree(data, start, left, key, flags)), b = chain(tree(data, start + left, count - left, key, flags));
    return { cv: key, message: [...a, ...b], counter: 0, len: 64, flags: flags | PARENT };
}
export function blake3(data, key) {
    check(data.length <= 64 * 1024 * 1024, 'HASH_INPUT_LIMIT');
    if (key !== undefined)
        check(key.length === 32, 'BLAKE3_KEY_SIZE');
    const kw = key === undefined ? IV : words(key, 8), out = tree(data, 0, Math.max(1, Math.ceil(data.length / 1024)), kw, key === undefined ? 0 : KEYED);
    const v = compress(out.cv, out.message, 0, out.len, out.flags | ROOT), result = new Uint8Array(32), dv = new DataView(result.buffer);
    for (let i = 0; i < 8; i++)
        dv.setUint32(i * 4, v[i], true);
    return result;
}
export function domainHash(tag, data) {
    const bytes = ascii(tag);
    check(bytes.length <= 32, 'BLAKE3_DOMAIN_LENGTH');
    const key = new Uint8Array(32);
    key.set(bytes);
    return blake3(data, key);
}
//# sourceMappingURL=blake3.js.map