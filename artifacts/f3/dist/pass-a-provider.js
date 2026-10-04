/** Read-only browser adapter for the F3 PASS-A provider. No wallet, Rust, shell or signer.
 * SDK Borsh RPC supplies headers/bodies/chain view; JSON-wRPC is needed only
 * for getSeqCommitLaneProof, which SDK 2.0.1 does not expose.
 */
import { check, unhex } from './bytes.js';
import { decimalInteger } from './rest-reader.js';
import { COINBASE_LANE_KEY } from './pass-a.js';
/** JSON-wRPC messages return `params`, not JSON-RPC `result`. */
export class LaneProofRpc {
    url;
    timeoutMs;
    ws = null;
    next = 0;
    pending = new Map();
    constructor(url, timeoutMs = 12000) {
        this.url = url;
        this.timeoutMs = timeoutMs;
        const u = new URL(url);
        check(u.protocol === 'wss:' && !u.username && !u.password && u.pathname === '/kaspa/testnet-10/wrpc/json', 'TN10_JSON_WSS_REQUIRED');
        check(Number.isInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 15000, 'RPC_TIMEOUT_RANGE');
    }
    async connect() {
        check(!this.ws, 'RPC_ALREADY_CONNECTED');
        const ws = new WebSocket(this.url);
        this.ws = ws;
        ws.onmessage = (event) => {
            try {
                check(typeof event.data === 'string', 'RPC_TEXT_REQUIRED');
                const msg = JSON.parse(event.data, ((_key, value, context) => {
                    if (typeof value === 'number' && !Number.isSafeInteger(value)) {
                        check(typeof context?.source === 'string' && /^-?(?:0|[1-9][0-9]*)$/.test(context.source), 'LOSSLESS_JSON_REQUIRED');
                        return context.source;
                    }
                    return value;
                }));
                if (!Number.isSafeInteger(msg.id))
                    return;
                const item = this.pending.get(msg.id);
                if (!item)
                    return;
                clearTimeout(item.timer);
                this.pending.delete(msg.id);
                if (msg.error !== null && msg.error !== undefined)
                    item.reject(Error(`RPC_ERROR:${JSON.stringify(msg.error)}`));
                else if (Object.hasOwn(msg, 'params'))
                    item.resolve(msg.params);
                else
                    item.reject(Error('RPC_PARAMS_MISSING'));
            }
            catch (e) {
                this.close(e instanceof Error ? e : Error(String(e)));
            }
        };
        ws.onclose = () => this.close(Error('RPC_DISCONNECTED'));
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => { reject(Error('RPC_CONNECT_TIMEOUT')); this.close(); }, this.timeoutMs);
            ws.onopen = () => { clearTimeout(timer); resolve(); };
            ws.onerror = () => { clearTimeout(timer); reject(Error('RPC_WEBSOCKET_ERROR')); this.close(); };
            ws.addEventListener('close', () => { clearTimeout(timer); reject(Error('RPC_CONNECT_CLOSED')); }, { once: true });
        });
        try {
            const info = await this.request('getServerInfo', {});
            check(info && typeof info === 'object' && 'networkId' in info && info.networkId === 'testnet-10' && 'isSynced' in info && info.isSynced === true, 'RPC_NETWORK_GATE');
        }
        catch (e) {
            this.close();
            throw e;
        }
    }
    request(method, params) {
        check(this.ws?.readyState === WebSocket.OPEN, 'RPC_NOT_CONNECTED');
        const ws = this.ws, id = ++this.next;
        return new Promise((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(id); reject(Error(`RPC_TIMEOUT:${method}`)); this.close(); }, this.timeoutMs); this.pending.set(id, { resolve, reject, timer }); try {
            ws.send(JSON.stringify({ id, method, params }));
        }
        catch (e) {
            clearTimeout(timer);
            this.pending.delete(id);
            reject(e instanceof Error ? e : Error(String(e)));
        } });
    }
    async getSeqCommitLaneProof(hash, laneKey = COINBASE_LANE_KEY) { unhex(hash, 32); check(laneKey === COINBASE_LANE_KEY, 'WRONG_LANE'); const result = await this.request('getSeqCommitLaneProof', { blockHash: hash, laneKey }); check(result !== null && typeof result === 'object', 'LANE_PROOF_RESPONSE'); return result; }
    close(reason = Error('RPC_CLOSED')) { const ws = this.ws; this.ws = null; if (ws) {
        ws.onclose = null;
        ws.close();
    } for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(reason);
    } this.pending.clear(); }
}
export function browserPassAProvider(services) {
    const { rest, chain, lane } = services;
    return {
        async getAcceptedClose(txid) {
            unhex(txid, 32);
            const t = await rest.readTransaction(txid);
            check(t.reportedAccepted === true && t.acceptingBlock !== null, 'CLOSE_NOT_ACCEPTED');
            const raw = t.raw, outputs = raw.outputs;
            check(Array.isArray(outputs), 'CLOSE_OUTPUTS');
            const o = outputs.find(v => v !== null && typeof v === 'object' && !Array.isArray(v) && v.index === 0);
            check(o && typeof o.script_public_key === 'string' && typeof o.covenant_id === 'string', 'SEALED_OUTPUT_REQUIRED');
            return { isAccepted: true, acceptingBlockHash: t.acceptingBlock, output0: { amount: decimalInteger(o.amount), scriptPublicKey: o.script_public_key, covenantId: o.covenant_id } };
        },
        getSinkBlueScore: () => chain.getSinkBlueScore(),
        // Low includes chainBlockHeader.hash/daaScore aligned to returned hashes;
        // it excludes the high/full transaction details used by a payout proof.
        getVirtualChainFromBlockV2: arg => chain.getVirtualChainFromBlockV2({ ...arg, dataVerbosityLevel: 'Low' }),
        getBlock: arg => chain.getBlock(arg),
        getSeqCommitLaneProof: (hash, laneKey) => lane.getSeqCommitLaneProof(hash, laneKey)
    };
}
//# sourceMappingURL=pass-a-provider.js.map