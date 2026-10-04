import type { Store } from './persistence.js';
import { type Profile, type Snapshot } from './state.js';
export interface CacheEntry {
    schema: 1;
    genesisTxId: string;
    snapshot: Snapshot;
    freshness: 'LIVE' | 'STALE';
    source: string;
    observedAt: number;
}
export declare class RoundCache {
    private store;
    private profile;
    constructor(store: Store, profile: Profile);
    private key;
    load(genesis: string): Promise<import("./persistence.js").Stored<CacheEntry> | null>;
    save(genesis: string, snapshot: Snapshot, expectedRevision: number | null, source: string): Promise<import("./persistence.js").Stored<CacheEntry>>;
    export(genesis: string): Promise<string>;
    import(text: string): Promise<string>;
}
