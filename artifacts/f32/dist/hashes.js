/**
 * Dependency-free hashes. BLAKE2b keyed mode added for the KIP-20 preimage.
 * New code is differential-tested against Python hashlib; not a cryptographic audit.
 * BLAKE2b has digest-size=32 in its parameter block (NOT truncated BLAKE2b-512).
 * BLAKE3 here deliberately supports keyed inputs <=64 bytes ONLY, sufficient for
 * the KIP-21 opening nodes used below. It is not a general BLAKE3/ABI implementation.
 * Use independently audited hashes/official SDK in a released runtime.
 */
import { check, fromLe, le, cat } from './bytes.js';
const MASK = (1n << 64n) - 1n;
const IV = [0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
    0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n];
const SIGMA = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
    [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4], [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
    [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13], [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
    [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11], [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
    [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5], [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0]
];
const r64 = (n, b) => ((n >> b) | (n << (64n - b))) & MASK;
export function blake2b256(data, key = new Uint8Array(0)) {
    check(key.length <= 64, 'BLAKE2_KEY_SIZE');
    const keyBlock = new Uint8Array(key.length ? 128 : 0);
    keyBlock.set(key);
    const input = key.length ? cat(keyBlock, data) : data;
    const h = IV.slice();
    h[0] = h[0] ^ (0x01010020n | BigInt(key.length) << 8n);
    const blocks = Math.max(1, Math.ceil(input.length / 128));
    for (let block = 0; block < blocks; block++) {
        const part = input.slice(block * 128, (block + 1) * 128), buf = new Uint8Array(128);
        buf.set(part);
        const m = Array.from({ length: 16 }, (_, i) => fromLe(buf.slice(i * 8, i * 8 + 8)));
        const v = [...h, ...IV];
        v[12] = v[12] ^ BigInt(Math.min(input.length, (block + 1) * 128));
        if (block === blocks - 1)
            v[14] = v[14] ^ MASK;
        const g = (a, b, c, d, x, y) => {
            v[a] = (v[a] + v[b] + x) & MASK;
            v[d] = r64(v[d] ^ v[a], 32n);
            v[c] = (v[c] + v[d]) & MASK;
            v[b] = r64(v[b] ^ v[c], 24n);
            v[a] = (v[a] + v[b] + y) & MASK;
            v[d] = r64(v[d] ^ v[a], 16n);
            v[c] = (v[c] + v[d]) & MASK;
            v[b] = r64(v[b] ^ v[c], 63n);
        };
        for (let r = 0; r < 12; r++) {
            const s = SIGMA[r % 10];
            g(0, 4, 8, 12, m[s[0]], m[s[1]]);
            g(1, 5, 9, 13, m[s[2]], m[s[3]]);
            g(2, 6, 10, 14, m[s[4]], m[s[5]]);
            g(3, 7, 11, 15, m[s[6]], m[s[7]]);
            g(0, 5, 10, 15, m[s[8]], m[s[9]]);
            g(1, 6, 11, 12, m[s[10]], m[s[11]]);
            g(2, 7, 8, 13, m[s[12]], m[s[13]]);
            g(3, 4, 9, 14, m[s[14]], m[s[15]]);
        }
        for (let i = 0; i < 8; i++)
            h[i] = h[i] ^ v[i] ^ v[i + 8];
    }
    return cat(...h.slice(0, 4).map(n => le(n, 8)));
}
const IV32 = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
const PERM = [2, 6, 3, 10, 7, 0, 4, 13, 1, 11, 12, 5, 9, 14, 15, 8];
const rr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0;
export function blake3KeyedNode(data, key) {
    check(key.length === 32 && data.length <= 64, 'BLAKE3_NODE_SIZE');
    const keyView = new DataView(key.buffer, key.byteOffset, key.byteLength);
    const kw = Array.from({ length: 8 }, (_, i) => keyView.getUint32(i * 4, true));
    const buf = new Uint8Array(64);
    buf.set(data);
    const view = new DataView(buf.buffer);
    let m = Array.from({ length: 16 }, (_, i) => view.getUint32(i * 4, true));
    // CHUNK_START | CHUNK_END | ROOT | KEYED_HASH; counter=0.
    const v = [...kw, ...IV32.slice(0, 4), 0, 0, data.length, 1 | 2 | 8 | 16];
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
    const out = new Uint8Array(32), ov = new DataView(out.buffer);
    for (let i = 0; i < 8; i++)
        ov.setUint32(i * 4, (v[i] ^ v[i + 8]) >>> 0, true);
    return out;
}
//# sourceMappingURL=hashes.js.map