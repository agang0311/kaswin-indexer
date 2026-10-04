import type { Store } from './persistence.js';
export type SubmissionStatus = 'PREPARED' | 'SUBMITTING' | 'SUBMITTED' | 'UNKNOWN' | 'ACCEPTED' | 'REJECTED' | 'REORGED';
export interface Identity {
    txid: string;
    networkGenesis: string;
    profile: string;
    source: string;
}
export interface Prepared extends Identity {
    action: string;
    signedTransaction: string;
    genesis?: {
        transactionId: string;
        index: number;
    };
}
export interface Receipt extends Prepared {
    status: SubmissionStatus;
    accepted: boolean;
    revisionTime: number;
    syncPending: boolean;
    refreshError?: string;
    transportError?: string;
    persistenceError?: string;
}
export interface Evidence extends Identity {
    status: 'ACCEPTED' | 'REJECTED' | 'REORGED' | 'UNKNOWN';
}
export interface Transport {
    networkGenesis(): Promise<string>;
    submit(transaction: string, signal?: AbortSignal): Promise<{
        txid: string;
        networkGenesis: string;
    }>;
    watch(txid: string, signal?: AbortSignal): AsyncIterable<Evidence>;
    query(txid: string, signal?: AbortSignal): Promise<Evidence>;
}
export declare class SubmissionManager {
    private store;
    private clock;
    constructor(store: Store, clock?: () => number);
    private update;
    /** Never erase an observed result merely because a later local write failed. */
    private report;
    private refresh;
    private accept;
    submit(p: Prepared, t: Transport, refresh?: () => Promise<void>, signal?: AbortSignal): Promise<Receipt>;
    resume(p: Identity, t: Transport, refresh?: () => Promise<void>, signal?: AbortSignal): Promise<Receipt>;
}
