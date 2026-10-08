export interface Stored<T> {
    revision: number;
    value: T;
}
export interface StoreRow<T = unknown> {
    key: string;
    record: Stored<T>;
}
export interface Store {
    get<T>(key: string): Promise<Stored<T> | null>;
    /** Synchronous check and insert share ONE readwrite transaction. No async callback. */
    insertIfAbsentWithCheck<T>(key: string, value: T, prefix: string, inspect: (rows: StoreRow[]) => void): Promise<Stored<T>>;
    compareAndSet<T>(key: string, expectedRevision: number | null, value: T): Promise<Stored<T>>;
    remove(key: string, expectedRevision: number): Promise<void>;
    list<T>(prefix: string): Promise<Array<{
        key: string;
        record: Stored<T>;
    }>>;
}
export declare function namespace(profile: string, genesisTxId?: string): string;
export declare class IndexedStore implements Store {
    private db;
    private constructor();
    static open(name?: string, factory?: IDBFactory): Promise<IndexedStore>;
    close(): void;
    get<T>(key: string): Promise<Stored<T> | null>;
    compareAndSet<T>(key: string, expectedRevision: number | null, value: T): Promise<Stored<T>>;
    /** Atomically reserve inputs by validating the journal snapshot and inserting the intent.
     * All same-object-store readwrite transactions serialize across tabs. Existing records
     * remain the source of reservations: no migration, duplicated lock table or TTL release. */
    insertIfAbsentWithCheck<T>(key: string, value: T, prefix: string, inspect: (rows: StoreRow[]) => void): Promise<Stored<T>>;
    remove(key: string, expectedRevision: number): Promise<void>;
    list<T>(prefix: string): Promise<Array<{
        key: string;
        record: Stored<T>;
    }>>;
}
