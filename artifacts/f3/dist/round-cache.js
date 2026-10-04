/** Concrete IndexedDB-backed round snapshot cache. Cache validity != current chain state. */
import { check, hex, unhex, stable } from './bytes.js';
import { verifySnapshot } from './state.js';
export class RoundCache {
    store;
    profile;
    constructor(store, profile) {
        this.store = store;
        this.profile = profile;
    }
    key(genesis) { unhex(genesis, 32); return `${this.profile.networkGenesis}/${this.profile.id}/rounds/${genesis}:0`; }
    async load(genesis) { const r = await this.store.get(this.key(genesis)); if (r) {
        verifySnapshot(r.value.snapshot, this.profile);
        check(r.value.genesisTxId === genesis, 'CACHE_GENESIS');
    } return r; }
    async save(genesis, snapshot, expectedRevision, source) { verifySnapshot(snapshot, this.profile); check(source.length > 0, 'CACHE_SOURCE'); return this.store.compareAndSet(this.key(genesis), expectedRevision, { schema: 1, genesisTxId: genesis, snapshot, freshness: 'LIVE', source, observedAt: Date.now() }); }
    async export(genesis) { const row = await this.load(genesis); check(row, 'ROUND_NOT_CACHED'); const x = row.value.snapshot; return JSON.stringify({ schema: 'KASWIN_F4_SNAPSHOT_1', networkGenesis: this.profile.networkGenesis, profileId: this.profile.id, genesisTxId: genesis, snapshot: { ...x, ledger: hex(x.ledger), value: x.value.toString(), utxoDaa: x.utxoDaa.toString(), currentDaa: x.currentDaa.toString() } }); }
    async import(text) {
        check(text.length <= 4 * 1024 * 1024, 'PACKAGE_LIMIT');
        const p = JSON.parse(text);
        check(p.schema === 'KASWIN_F4_SNAPSHOT_1' && p.networkGenesis === this.profile.networkGenesis && p.profileId === this.profile.id, 'PACKAGE_PROFILE');
        unhex(p.genesisTxId, 32);
        const raw = p.snapshot;
        for (const k of ['value', 'utxoDaa', 'currentDaa'])
            check(typeof raw[k] === 'string' && /^(0|[1-9][0-9]*)$/.test(raw[k]), 'PACKAGE_INTEGER');
        const snapshot = { ...raw, ledger: unhex(raw.ledger), value: BigInt(raw.value), utxoDaa: BigInt(raw.utxoDaa), currentDaa: BigInt(raw.currentDaa) };
        verifySnapshot(snapshot, this.profile);
        // Do not downgrade or overwrite a previously verified cache with imported old data.
        const key = this.key(p.genesisTxId), old = await this.store.get(key);
        if (old) {
            check(stable(old.value.snapshot) === stable(snapshot), 'IMPORT_CONFLICT_REFRESH_FIRST');
            return p.genesisTxId;
        }
        await this.store.compareAndSet(key, null, { schema: 1, genesisTxId: p.genesisTxId, snapshot, freshness: 'STALE', source: 'imported snapshot; node refresh required', observedAt: Date.now() });
        return p.genesisTxId;
    }
}
//# sourceMappingURL=round-cache.js.map