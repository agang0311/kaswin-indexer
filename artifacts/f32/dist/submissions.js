/** Durable transaction-result orchestration. Concrete Kaspa SDK/wRPC adapter is not supplied. */
import { check, unhex, abortIfNeeded } from './bytes.js';
const message = (error) => error instanceof Error ? error.message : String(error);
const rowKey = (p) => `${p.networkGenesis}/${p.profile}/submissions/${p.txid}`;
function validate(p) {
    unhex(p.txid, 32);
    unhex(p.networkGenesis, 32);
    unhex(p.profile, 32);
    check(p.source.length > 0, 'SOURCE_MISSING');
    check(p.signedTransaction.length > 0, 'EMPTY_SIGNED_TRANSACTION');
    check(p.action.length > 0, 'ACTION_MISSING');
    if (p.action === 'CREATE_ROUND')
        check(p.genesis?.transactionId === p.txid && p.genesis.index === 0, 'CREATE_LOCATOR_MISSING');
}
function match(expected, event) {
    check(event.txid === expected.txid, 'EVIDENCE_TXID_MISMATCH');
    check(event.networkGenesis === expected.networkGenesis, 'EVIDENCE_NETWORK_MISMATCH');
    check(event.profile === expected.profile, 'EVIDENCE_PROFILE_MISMATCH');
    check(event.source === expected.source, 'EVIDENCE_SOURCE_MISMATCH');
}
export class SubmissionManager {
    store;
    clock;
    constructor(store, clock = () => Date.now()) {
        this.store = store;
        this.clock = clock;
    }
    async update(row, patch) {
        return this.store.compareAndSet(rowKey(row.value), row.revision, { ...row.value, ...patch, revisionTime: this.clock() });
    }
    /** Never erase an observed result merely because a later local write failed. */
    async report(row, patch) {
        const value = { ...row.value, ...patch, revisionTime: this.clock() };
        try {
            return (await this.store.compareAndSet(rowKey(value), row.revision, value)).value;
        }
        catch (error) {
            return { ...value, persistenceError: message(error) };
        }
    }
    async refresh(row, refresh) {
        if (!refresh)
            return row.value;
        try {
            await refresh();
        }
        catch (error) {
            return this.report(row, { syncPending: true, refreshError: message(error) });
        }
        const value = { ...row.value, syncPending: false, revisionTime: this.clock() };
        delete value.refreshError;
        try {
            return (await this.store.compareAndSet(rowKey(value), row.revision, value)).value;
        }
        catch (error) {
            return { ...value, persistenceError: message(error) };
        }
    }
    async accept(row, refresh) {
        try {
            row = await this.update(row, { status: 'ACCEPTED', accepted: true });
        }
        catch (error) {
            return { ...row.value, status: 'ACCEPTED', accepted: true, syncPending: true,
                revisionTime: this.clock(), persistenceError: message(error) };
        }
        return this.refresh(row, refresh);
    }
    async submit(p, t, refresh, signal) {
        p = structuredClone(p);
        validate(p);
        abortIfNeeded(signal);
        check(await t.networkGenesis() === p.networkGenesis, 'WRONG_NETWORK');
        const existing = await this.store.get(rowKey(p));
        if (existing) {
            check(existing.value.action === p.action && existing.value.signedTransaction === p.signedTransaction, 'INTENT_CHANGED_FOR_TXID');
            return existing.value;
        } // Never implicit resubmit.
        let row = await this.store.compareAndSet(rowKey(p), null, { ...p, status: 'PREPARED', accepted: false, syncPending: true, revisionTime: this.clock() });
        abortIfNeeded(signal);
        row = await this.update(row, { status: 'SUBMITTING' }); // Durable BEFORE side effect.
        try {
            check(await t.networkGenesis() === p.networkGenesis, 'WRONG_NETWORK');
            abortIfNeeded(signal);
            const response = await t.submit(p.signedTransaction, signal);
            check(response.txid === p.txid, 'SUBMIT_TXID_MISMATCH');
            check(response.networkGenesis === p.networkGenesis, 'SUBMIT_NETWORK_MISMATCH');
            row = await this.update(row, { status: 'SUBMITTED' });
        }
        catch (e) {
            return this.report(row, { status: 'UNKNOWN', transportError: message(e) });
        }
        try {
            for await (const evidence of t.watch(p.txid, signal)) {
                match(p, evidence);
                if (evidence.status === 'ACCEPTED') {
                    return await this.accept(row, refresh);
                }
                if (evidence.status === 'REJECTED' || evidence.status === 'REORGED')
                    return this.report(row, { status: evidence.status, accepted: false });
            }
            return this.report(row, { transportError: 'ACCEPTANCE_NOT_OBSERVED' });
        }
        catch (e) {
            try {
                const current = await this.store.get(rowKey(p));
                if (current?.value.accepted)
                    return { ...current.value, transportError: message(e), syncPending: true };
                return this.report(current ?? row, { transportError: message(e) });
            }
            catch (persistenceError) {
                return { ...row.value, transportError: message(e), persistenceError: message(persistenceError) };
            }
        }
    }
    async resume(p, t, refresh, signal) {
        let row = await this.store.get(rowKey(p));
        check(row !== null, 'SUBMISSION_NOT_FOUND');
        match(row.value, p);
        check(await t.networkGenesis() === p.networkGenesis, 'WRONG_NETWORK');
        try {
            const ev = await t.query(p.txid, signal);
            match(p, ev);
            if (ev.status === 'ACCEPTED') {
                return this.accept(row, refresh);
            }
            // UNKNOWN is not a reorg proof. Preserve an earlier accepted conclusion.
            if (ev.status === 'UNKNOWN')
                return row.value;
            if (row.value.accepted && ev.status === 'REJECTED')
                return { ...row.value, transportError: 'REJECTION_IS_NOT_REORG_EVIDENCE' };
            row = await this.update(row, { status: ev.status, accepted: false, syncPending: true });
            return row.value;
        }
        catch (e) {
            return { ...row.value, transportError: message(e) };
        }
    }
}
//# sourceMappingURL=submissions.js.map