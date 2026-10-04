/** Concrete binding to a preloaded Kaspa WASM SDK and the project's selective-input wallet.
 * No server-side signing, guessed private keys, or synthetic broadcast implementation.
 * SDK source/API lineage: sources/EXTERNAL.md. Real version compatibility NOT tested here.
 */
import { check, stable, unhex } from './bytes.js';
import { parseLosslessJson } from './rest-reader.js';
import { assertDraft } from './builders.js';
function dto(d, quoteOnly = false) {
    const t = d.transaction;
    return { ...t, storageMass: t.storageMass, inputs: t.inputs.map((i, n) => ({ ...i, sigOpCount: i.sigOpCount ?? 0, computeBudget: i.computeBudget ?? 0, signatureScript: quoteOnly && d.authorizedInputIndices.includes(n) ? '41' + '00'.repeat(64) + '01' : i.signatureScript, utxo: { outpoint: d.inputUtxos[n].outpoint, amount: d.inputUtxos[n].value, scriptPublicKey: d.inputUtxos[n].spk, blockDaaScore: d.inputUtxos[n].daa, isCoinbase: false, ...(d.inputUtxos[n].covenantId ? { covenantId: d.inputUtxos[n].covenantId } : {}) } })), outputs: t.outputs.map(o => ({ ...o, covenant: o.covenant ?? undefined })) };
}
function obj(x) { check(x !== null && typeof x === 'object' && !Array.isArray(x), 'SDK_JSON_OBJECT'); return x; }
/** Compare the WHOLE SDK serialization, not only fields known to our DTO codec. */
export function inspectNativeMutation(before, after, indices) {
    const a = obj(parseLosslessJson(before)), b = obj(parseLosslessJson(after));
    check(Array.isArray(a.inputs) && Array.isArray(b.inputs) && a.inputs.length === b.inputs.length, 'SDK_INPUT_COUNT');
    const allowed = new Set(indices);
    check(allowed.size === indices.length, 'DUPLICATE_SIGN_INDEX');
    for (let i = 0; i < a.inputs.length; i++) {
        const x = obj(a.inputs[i]), y = obj(b.inputs[i]);
        if (allowed.has(i)) {
            const sig = y.signatureScript;
            check(typeof sig === 'string' && /^41[0-9a-f]{128}01$/i.test(sig), 'SDK_SIGNATURE_FORMAT');
            x.signatureScript = '';
            y.signatureScript = '';
        }
    }
    check(stable(a) === stable(b), 'WALLET_MUTATED_TRANSACTION');
}
export class KaspaSdkAdapter {
    sdk;
    rpc;
    networkId;
    wallet;
    massQuote;
    constructor(sdk, rpc, networkId, wallet, massQuote) {
        this.sdk = sdk;
        this.rpc = rpc;
        this.networkId = networkId;
        this.wallet = wallet;
        this.massQuote = massQuote;
        check(networkId === 'testnet-10', 'TN10_ONLY_DEFAULT');
    }
    async assertNetwork() { const r = await this.rpc.getServerInfo(); check((r.networkId ?? r.network) === this.networkId, 'WRONG_NETWORK'); }
    async quote(d, forSize) {
        check(this.massQuote, 'CONSENSUS_MASS_QUOTE_REQUIRED');
        const q = await this.massQuote.quote(d, forSize);
        for (const value of [q.storageMass, q.computeMass, q.normalizedTransientMass, q.relayFeeFloor])
            check(typeof value === 'bigint' && value >= 0n, 'BAD_CONSENSUS_MASS_QUOTE');
        check(q.relayFeeFloor > 0n && q.storageMass <= 0xffffffffffffffffn, 'BAD_CONSENSUS_MASS_QUOTE');
        return q;
    }
    async native(d) { assertDraft(d); const q = await this.quote(d, true); check(d.fee >= q.relayFeeFloor, 'FEE_BELOW_RELAY_FLOOR'); const tx = new this.sdk.Transaction(dto(d)); tx.storageMass = q.storageMass; return tx; }
    async measure(d) {
        assertDraft(d);
        const q = await this.quote(d, true);
        // Consensus dimensions, not the wallet SDK's 100000 mass helper admission cap.
        return { feeFloor: q.relayFeeFloor, mass: q.computeMass > q.normalizedTransientMass ? q.computeMass : q.normalizedTransientMass };
    }
    async sign(d, actorKey) {
        await this.assertNetwork();
        const tx = await this.native(d);
        unhex(tx.id, 32);
        const before = tx.serializeToSafeJSON(), id = tx.id;
        if (d.authorizedInputIndices.length) {
            const w = this.wallet();
            check(w && w.network === this.networkId && w.publicKey.toLowerCase() === actorKey, 'WALLET_ACCOUNT');
            await w.signTransaction(tx, [...d.authorizedInputIndices]);
            check(this.wallet()?.network === this.networkId && this.wallet()?.publicKey.toLowerCase() === actorKey, 'WALLET_CHANGED');
        }
        const after = tx.serializeToSafeJSON();
        inspectNativeMutation(before, after, d.authorizedInputIndices);
        check(tx.id === id, 'SDK_TXID_CHANGED');
        await this.assertNetwork();
        const floor = await this.quote(d, true);
        check(tx.storageMass === floor.storageMass && floor.relayFeeFloor <= d.fee, 'SIGNED_MASS_OR_FEE_CHANGED');
        return { native: tx, safeJson: after, txid: id };
    }
    async submitSigned(tx) { await this.assertNetwork(); const r = await this.rpc.submitTransaction({ transaction: tx, allowOrphan: false }); unhex(r.transactionId, 32); check(r.transactionId === tx.id, 'SUBMIT_TXID_MISMATCH'); return r.transactionId; }
}
//# sourceMappingURL=sdk-adapter.js.map