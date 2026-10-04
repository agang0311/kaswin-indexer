export interface Stored<T> {
    revision: number;
    value: T;
}
export interface Store {
    get<T>(key: string): Promise<Stored<T> | null>;
    compareAndSet<T>(key: string, expectedRevision: number | null, value: T): Promise<Stored<T>>;
    remove(key: string, expectedRevision: number): Promise<void>;
    list<T>(prefix: string): Promise<Array<{
        key: string;
        record: Stored<T>;
    }>>;
}
export declare function namespace(networkGenesis: string, profile: string, genesisTxId?: string): string;
export declare class IndexedStore implements Store {
    private db;
    private constructor();
    static open(name?: string, factory?: IDBFactory): Promise<IndexedStore>;
    close(): void;
    get<T>(key: string): Promise<Stored<T> | null>;
    compareAndSet<T>(key: string, expectedRevision: number | null, value: T): Promise<Stored<T>>;
    remove(key: string, expectedRevision: number): Promise<void>;
    list<T>(prefix: string): Promise<Array<{
        key: string;
        record: Stored<T>;
    }>>;
}
