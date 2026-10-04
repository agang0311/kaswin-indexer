/** Browser action orchestration for FOUR SIL contracts (not a simulation runtime).
 * Application reads/proof supply remain explicit dependencies. SDK construction,
 * fee convergence, selective signing, result durability and ABI routing are implemented.
 */
import { abortIfNeeded, check, hex, stable, unhex } from './bytes.js';
import { blake2b256 } from './hashes.js';
import { buildAction, buildOpenGenesis, buildBeaconReclaim } from './builders.js';
import { availableActions } from './protocol.js';
import { verifySnapshot } from './state.js';
import { DEFAULT_REGISTRY_SPK } from './registry.js';
const message = (e) => e instanceof Error ? e.message : String(e);
export class KaswinActions extends EventTarget {
    profile;
    sdk;
    reads;
    store;
    locks = new Set();
    plans = new Map();
    constructor(profile, sdk, reads, store) {
        super();
        this.profile = profile;
        this.sdk = sdk;
        this.reads = reads;
        this.store = store;
    }
    prefix() { return `${this.profile.networkGenesis}/${this.profile.id}/`; }
    emit(kind, detail) { this.dispatchEvent(new CustomEvent(kind, { detail })); }
    /** Read-only access is NOT blocked by any write-release gate. */
    async refresh(round, signal) { unhex(round, 32); abortIfNeeded(signal); const s = await this.reads.loadRound(round, signal); verifySnapshot(s, this.profile); return s; }
    async discover(beacon, cursor = null, signal) { abortIfNeeded(signal); return this.reads.discover(beacon, cursor, signal); }
    async actions(round, signal) { return availableActions(await this.refresh(round, signal), this.profile); }
    freeze(round, op, draft, actorKey, mass, auth) {
        check(draft.fee <= auth.maxNetworkFee && draft.walletDebit <= auth.maxWalletDebit, 'SPENDING_AUTHORIZATION');
        const fields = { round, operation: op, draft, actorKey, mass, auth, profileId: this.profile.id };
        const id = hex(blake2b256(new TextEncoder().encode(stable(fields))));
        const p = { id, ...fields };
        this.plans.set(id, structuredClone(p));
        return structuredClone(p);
    }
    async estimate(make, auth) {
        check(auth.maxNetworkFee > 0n && auth.maxWalletDebit >= 0n, 'BAD_AUTH');
        let fee = 1n;
        for (let i = 0; i < 16; i++) {
            check(fee <= auth.maxNetworkFee, 'FEE_AUTHORIZATION');
            const d = make(fee), m = await this.sdk.measure(d);
            if (m.feeFloor <= fee)
                return { draft: d, mass: m.mass };
            fee = m.feeFloor;
        }
        throw new Error('FEE_DID_NOT_CONVERGE');
    }
    async prepare(round, op, funds, budget, auth, signal) {
        const snap = await this.refresh(round, signal);
        const r = await this.estimate(fee => buildAction(snap, this.profile, op, fee, funds, budget), auth);
        return this.freeze(round, op, r.draft, op.actorKey, r.mass, auth);
    }
    async prepareFromSnapshot(snap, op, funds, budget, auth) {
        verifySnapshot(snap, this.profile);
        const r = await this.estimate(fee => buildAction(snap, this.profile, op, fee, funds, budget), auth);
        return this.freeze(null, op, r.draft, op.actorKey, r.mass, auth);
    }
    /** Address resolution belongs to the UI/SDK; null means explicitly no registration. */
    async prepareGenesis(owner, config, funds, auth, registrySpk) { const r = await this.estimate(fee => buildOpenGenesis(this.profile, owner, config, funds, fee, registrySpk), auth); return this.freeze(null, null, r.draft, owner, r.mass, auth); }
    /** F3.1 entry: default registry; pass null to opt out, or resolve a custom TN10 address via pinned SDK. */
    async prepareF31Genesis(owner, config, funds, auth, registrySpk = DEFAULT_REGISTRY_SPK) { return this.prepareGenesis(owner, config, funds, auth, registrySpk); }
    async prepareBeaconReclaim(outpoint, owner, tag, daa, budget, auth) {
        const d = buildBeaconReclaim(outpoint, owner, tag, daa, budget), m = await this.sdk.measure(d);
        check(m.feeFloor <= 200000n, 'BEACON_RECLAIM_FEE_TOO_HIGH');
        return this.freeze(null, null, d, owner, m.mass, auth);
    }
    async saveReceipt(receipt) {
        try {
            const k = this.prefix() + 'receipts/' + receipt.txid, old = await this.store.get(k);
            await this.store.compareAndSet(k, old?.revision ?? null, receipt);
            return receipt;
        }
        catch (e) {
            return { ...receipt, persistenceError: message(e) };
        }
    }
    async execute(plan, options) {
        const saved = this.plans.get(plan.id);
        check(saved && stable(saved) === stable(plan), 'PLAN_CHANGED');
        const p = structuredClone(saved), lock = p.round ?? p.actorKey;
        check(!this.locks.has(lock), 'ACTION_IN_PROGRESS');
        this.locks.add(lock);
        this.plans.delete(p.id);
        let receipt = null;
        try {
            abortIfNeeded(options.signal);
            check(await options.approve(structuredClone(p)), 'USER_REJECTED');
            abortIfNeeded(options.signal);
            await this.sdk.assertNetwork();
            // Every input, including Factory and ordinary funds, is rechecked after approval.
            for (const i of p.draft.transaction.inputs)
                check(await this.reads.isUnspent(i.previousOutpoint, options.signal), 'STALE_INPUT');
            const signed = await this.sdk.sign(p.draft, p.actorKey);
            abortIfNeeded(options.signal);
            for (const i of p.draft.transaction.inputs)
                check(await this.reads.isUnspent(i.previousOutpoint, options.signal), 'STALE_INPUT');
            const k = this.prefix() + 'submitted/' + signed.txid;
            check(!(await this.store.get(k)), 'ALREADY_SUBMITTED_USE_RESUME');
            receipt = { txid: signed.txid, action: p.draft.action, networkGenesis: this.profile.networkGenesis, profileId: this.profile.id, status: 'SUBMITTING', accepted: false, genesisTxId: p.draft.action === 'CREATE_ROUND' ? signed.txid : null, stateOutputIndex: p.draft.action === 'CREATE_ROUND' ? 0 : null, syncPending: true };
            // Durable record BEFORE RPC side effect, also covers a lost submit response.
            await this.store.compareAndSet(k, null, { receipt, signedTransaction: signed.safeJson, round: p.round });
            try {
                await this.sdk.submitSigned(signed.native);
                receipt.status = 'SUBMITTED';
            }
            catch (e) {
                receipt.status = 'UNKNOWN';
                receipt.transportError = message(e);
                return await this.saveReceipt(receipt);
            }
            receipt = await this.saveReceipt(receipt);
            this.emit('progress', receipt);
            const until = Date.now() + (options.waitMs ?? 30000);
            do {
                try {
                    abortIfNeeded(options.signal);
                    const ev = await this.reads.acceptance(signed.txid, options.signal);
                    check(ev.txid === signed.txid && ev.networkGenesis === this.profile.networkGenesis && ev.source.length > 0, 'EVIDENCE_IDENTITY');
                    if (ev.status === 'ACCEPTED') {
                        receipt.status = 'ACCEPTED';
                        receipt.accepted = true;
                        receipt = await this.saveReceipt(receipt);
                        const round = receipt.genesisTxId ?? p.round;
                        if (round) {
                            try {
                                await this.refresh(round, options.signal);
                                receipt.syncPending = false;
                            }
                            catch (e) {
                                receipt.refreshError = message(e);
                            }
                        }
                        return await this.saveReceipt(receipt);
                    }
                    if (ev.status === 'REJECTED' || ev.status === 'REORGED') {
                        receipt.status = ev.status;
                        return await this.saveReceipt(receipt);
                    }
                    if (Date.now() >= until)
                        break;
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
                catch (e) {
                    receipt.transportError = message(e);
                    break;
                }
            } while (Date.now() < until);
            return await this.saveReceipt(receipt);
        }
        finally {
            this.locks.delete(lock);
        }
    }
    async resume(txid, signal) {
        unhex(txid, 32);
        const saved = await this.store.get(this.prefix() + 'submitted/' + txid);
        check(saved, 'SUBMISSION_NOT_FOUND');
        let r = (await this.store.get(this.prefix() + 'receipts/' + txid))?.value ?? saved.value.receipt;
        try {
            const e = await this.reads.acceptance(txid, signal);
            check(e.txid === txid && e.networkGenesis === this.profile.networkGenesis && e.source.length > 0, 'EVIDENCE_IDENTITY');
            if (e.status === 'UNKNOWN')
                return r;
            if (r.accepted && e.status === 'REJECTED')
                return { ...r, transportError: 'REJECTION_IS_NOT_REORG' };
            r = { ...r, status: e.status, accepted: e.status === 'ACCEPTED', syncPending: true };
            return await this.saveReceipt(r);
        }
        catch (e) {
            return { ...r, transportError: message(e) };
        }
    }
}
//# sourceMappingURL=browser-actions.js.map