/** Read-only adapter for kaspa-ng/kaspa-rest-server e479a5da8dfdb1e3a96105a5460c773dacca4a60.
 * No submission or wallet methods. REST statements are not cryptographic consensus proofs.
 */
import { check, integer, unhex, KaswinError } from './bytes.js';
export const REST_SCHEMA_SOURCE = 'kaspa-ng/kaspa-rest-server@e479a5da8dfdb1e3a96105a5460c773dacca4a60';
/** Preserve large JSON integer tokens as decimal strings, without touching quoted text. */
export function parseLosslessJson(text) {
    let out = '', i = 0;
    while (i < text.length) {
        const c = text[i];
        if (c === '"') {
            const start = i++;
            let escaped = false, closed = false;
            while (i < text.length) {
                const x = text[i++];
                if (escaped) {
                    escaped = false;
                    continue;
                }
                if (x === '\\') {
                    escaped = true;
                    continue;
                }
                if (x === '"') {
                    closed = true;
                    break;
                }
            }
            check(closed, 'INVALID_JSON_STRING');
            out += text.slice(start, i);
            continue;
        }
        if (c === '-' || (c >= '0' && c <= '9')) {
            const m = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(i));
            check(m !== null, 'INVALID_JSON_NUMBER');
            const token = m[0];
            check(token.length <= 128, 'REST_NUMERIC_TOKEN_LIMIT');
            if (/^-?[0-9]+$/.test(token) && (BigInt(token) > BigInt(Number.MAX_SAFE_INTEGER) || BigInt(token) < BigInt(Number.MIN_SAFE_INTEGER)))
                out += JSON.stringify(token);
            else
                out += token;
            i += token.length;
            continue;
        }
        out += c;
        i++;
    }
    return JSON.parse(out);
}
function object(v) { check(v !== null && typeof v === 'object' && !Array.isArray(v), 'REST_OBJECT'); return v; }
export function decimalInteger(v) {
    if (typeof v === 'number') {
        check(Number.isSafeInteger(v) && v >= 0, 'UNSAFE_REST_NUMBER');
        return BigInt(v);
    }
    check(typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v), 'REST_INTEGER');
    return BigInt(v);
}
export function parseTransactionView(v, source) {
    const o = object(v);
    check(typeof o.transaction_id === 'string', 'REST_TXID_MISSING');
    unhex(o.transaction_id, 32);
    const accepted = o.is_accepted === true ? true : o.is_accepted === false ? false : null;
    const accepting = typeof o.accepting_block_hash === 'string' ? o.accepting_block_hash : null;
    if (accepting !== null)
        unhex(accepting, 32);
    const blocks = Array.isArray(o.block_hash) ? o.block_hash.map(x => { check(typeof x === 'string', 'REST_BLOCK_HASH'); unhex(x, 32); return x; }) : [];
    const payload = typeof o.payload === 'string' ? o.payload : null;
    if (payload !== null)
        unhex(payload);
    const inputs = Array.isArray(o.inputs) ? o.inputs : null, outputs = Array.isArray(o.outputs) ? o.outputs : null;
    const witness = inputs !== null && inputs.length > 0 && inputs.every(x => typeof object(x).signature_script === 'string');
    if (inputs)
        for (const input of inputs) {
            const script = object(input).signature_script;
            if (script !== null && script !== undefined) {
                check(typeof script === 'string', 'REST_SIGNATURE_SCRIPT');
                unhex(script);
            }
        }
    // Validate all amounts before exposing a losslessly parsed response.
    if (outputs)
        for (const output of outputs) {
            const x = object(output);
            if (x.amount !== undefined && x.amount !== null)
                decimalInteger(x.amount);
        }
    return { transactionId: o.transaction_id, reportedAccepted: accepted, acceptingBlock: accepting, blockHashes: blocks, payload, inputCount: inputs?.length ?? null, outputCount: outputs?.length ?? null, completeWitness: witness, raw: o, source };
}
export class RestReader {
    base;
    fetcher;
    timeout;
    maxBytes;
    retries;
    constructor(options) {
        const base = new URL(options.baseUrl);
        check(!base.username && !base.password && !base.search && !base.hash, 'BAD_REST_BASE');
        check(base.protocol === 'https:' || (base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)), 'INSECURE_REST_BASE');
        if (!base.pathname.endsWith('/'))
            base.pathname += '/';
        this.base = base;
        this.fetcher = options.fetcher ?? fetch;
        this.timeout = options.timeoutMs ?? 10000;
        this.maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
        this.retries = options.retries ?? 1;
        integer(this.timeout, 1, 60000);
        integer(this.maxBytes, 1, 64 * 1024 * 1024);
        integer(this.retries, 0, 2);
    }
    async get(path, params, signal) {
        const url = new URL(path, this.base);
        for (const [k, v] of Object.entries(params))
            url.searchParams.set(k, v);
        for (let attempt = 0;; attempt++) {
            const timeout = AbortSignal.timeout(this.timeout), combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
            const r = await this.fetcher(url, { method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error', signal: combined });
            if ((r.status === 429 || r.status === 503) && attempt < this.retries) {
                await r.body?.cancel();
                const delayHeader = r.headers.get('Retry-After'), delay = delayHeader && /^[0-9]+$/.test(delayHeader) ? Number(delayHeader) * 1000 : 250;
                check(delay <= 1000, 'REST_BACKOFF_REQUIRED');
                await new Promise((resolve, reject) => {
                    const fail = () => { clearTimeout(id); reject(combined.reason); };
                    const id = setTimeout(() => { combined.removeEventListener('abort', fail); resolve(); }, delay);
                    combined.addEventListener('abort', fail, { once: true });
                    if (combined.aborted)
                        fail();
                });
                continue;
            }
            if (!r.ok) {
                await r.body?.cancel();
                throw new KaswinError(r.status === 404 ? 'REST_NOT_FOUND' : r.status === 429 ? 'REST_RATE_LIMIT' : 'REST_HTTP_ERROR', `HTTP ${r.status} ${url.pathname}`);
            }
            check(r.body !== null, 'REST_EMPTY_BODY');
            const reader = r.body.getReader(), parts = [];
            let length = 0;
            try {
                while (true) {
                    const p = await reader.read();
                    if (p.done)
                        break;
                    length += p.value.length;
                    check(length <= this.maxBytes, 'REST_RESPONSE_LIMIT');
                    parts.push(p.value);
                }
            }
            catch (e) {
                await reader.cancel();
                throw e;
            }
            finally {
                reader.releaseLock();
            }
            const bytes = new Uint8Array(length);
            let at = 0;
            for (const p of parts) {
                bytes.set(p, at);
                at += p.length;
            }
            return { data: parseLosslessJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), headers: r.headers, url: url.toString() };
        }
    }
    async readTransaction(txid, signal) {
        unhex(txid, 32);
        const r = await this.get(`transactions/${txid}`, { inputs: 'true', outputs: 'true', resolve_previous_outpoints: 'full' }, signal);
        const result = parseTransactionView(r.data, r.url);
        check(result.transactionId === txid, 'REST_TXID_MISMATCH');
        return result;
    }
    async readAddressPage(address, cursor = {}, limit = 50, signal) {
        check(/^(kaspa|kaspatest|kaspadev|kaspasim):[a-z0-9]+$/.test(address), 'ADDRESS_SYNTAX');
        integer(limit, 1, 500);
        check(!(cursor.before !== undefined && cursor.after !== undefined), 'CONFLICTING_PAGE_DIRECTIONS');
        const params = { limit: String(limit), resolve_previous_outpoints: 'full' };
        if (cursor.before !== undefined) {
            check(cursor.before > 0n, 'PAGE_CURSOR');
            params.before = cursor.before.toString();
        }
        if (cursor.after !== undefined) {
            check(cursor.after > 0n, 'PAGE_CURSOR');
            params.after = cursor.after.toString();
        }
        const r = await this.get(`addresses/${encodeURIComponent(address)}/full-transactions-page`, params, signal);
        check(Array.isArray(r.data), 'REST_PAGE_NOT_ARRAY');
        const rows = r.data.map(x => parseTransactionView(x, r.url));
        const seen = new Set();
        const transactions = rows.filter(x => {
            if (seen.has(x.transactionId))
                return false;
            seen.add(x.transactionId);
            return true;
        });
        const direction = cursor.after !== undefined ? 'after' : 'before', header = r.headers.get(`X-Next-Page-${direction}`);
        let next = null;
        if (header !== null) {
            const n = decimalInteger(header);
            check(n > 0n, 'PAGE_CURSOR');
            const previous = direction === 'after' ? cursor.after : cursor.before;
            if (previous !== undefined)
                check(direction === 'after' ? n > previous : n < previous, 'PAGE_NOT_ADVANCING');
            next = direction === 'after' ? { after: n } : { before: n };
        }
        return { transactions, next, source: r.url };
    }
}
//# sourceMappingURL=rest-reader.js.map