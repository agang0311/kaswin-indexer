export declare const REST_SCHEMA_SOURCE = "kaspa-ng/kaspa-rest-server@e479a5da8dfdb1e3a96105a5460c773dacca4a60";
/** Preserve large JSON integer tokens as decimal strings, without touching quoted text. */
export declare function parseLosslessJson(text: string): unknown;
export declare function decimalInteger(v: unknown): bigint;
export interface RestTransactionView {
    transactionId: string;
    reportedAccepted: boolean | null;
    acceptingBlock: string | null;
    blockHashes: string[];
    payload: string | null;
    inputCount: number | null;
    outputCount: number | null;
    completeWitness: boolean;
    raw: Record<string, unknown>;
    source: string;
}
export declare function parseTransactionView(v: unknown, source: string): RestTransactionView;
export interface PageCursor {
    before?: bigint;
    after?: bigint;
}
export interface AddressPage {
    transactions: RestTransactionView[];
    next: PageCursor | null;
    source: string;
}
export interface RestReaderOptions {
    baseUrl: string;
    fetcher?: typeof fetch;
    timeoutMs?: number;
    maxBytes?: number;
    retries?: number;
}
export declare class RestReader {
    private base;
    private fetcher;
    private timeout;
    private maxBytes;
    private retries;
    constructor(options: RestReaderOptions);
    private get;
    readTransaction(txid: string, signal?: AbortSignal): Promise<RestTransactionView>;
    readAddressPage(address: string, cursor?: PageCursor, limit?: number, signal?: AbortSignal): Promise<AddressPage>;
}
