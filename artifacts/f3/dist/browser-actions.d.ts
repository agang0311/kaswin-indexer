import { type Draft, type Funding } from './builders.js';
import { type Operation } from './protocol.js';
import { type Profile, type Snapshot } from './state.js';
import type { Spk } from './covenant-id.js';
import { type Store } from './persistence.js';
import { KaspaSdkAdapter } from './sdk-adapter.js';
export interface ReadServices {
    /** Existing lineage reader MUST verify input/output SPK/CID and acceptance. */
    loadRound(genesisTxId: string, signal?: AbortSignal): Promise<Snapshot>;
    isUnspent(outpoint: Snapshot['tip'], signal?: AbortSignal): Promise<boolean>;
    /** Only chain/node observations, never a hardcoded ACCEPTED response. */
    acceptance(txid: string, signal?: AbortSignal): Promise<{
        txid: string;
        networkGenesis: string;
        status: 'ACCEPTED' | 'REJECTED' | 'UNKNOWN' | 'REORGED';
        source: string;
    }>;
    discover(beacon: string, cursor: string | null, signal?: AbortSignal): Promise<{
        rounds: string[];
        nextCursor: string | null;
    }>;
}
export interface Auth {
    maxNetworkFee: bigint;
    maxWalletDebit: bigint;
}
export interface Prepared {
    id: string;
    round: string | null;
    operation: Operation | null;
    draft: Draft;
    actorKey: string;
    mass: bigint;
    auth: Auth;
    profileId: string;
}
export interface Receipt {
    txid: string;
    action: string;
    networkGenesis: string;
    profileId: string;
    status: 'SUBMITTING' | 'SUBMITTED' | 'UNKNOWN' | 'ACCEPTED' | 'REJECTED' | 'REORGED';
    accepted: boolean;
    genesisTxId: string | null;
    stateOutputIndex: 0 | null;
    syncPending: boolean;
    refreshError?: string;
    transportError?: string;
    persistenceError?: string;
}
export interface ExecutionOptions {
    signal?: AbortSignal;
    approve: (plan: Prepared) => Promise<boolean>;
    waitMs?: number;
}
export declare class KaswinActions extends EventTarget {
    readonly profile: Profile;
    private readonly sdk;
    private readonly reads;
    private readonly store;
    private locks;
    private plans;
    constructor(profile: Profile, sdk: KaspaSdkAdapter, reads: ReadServices, store: Store);
    private prefix;
    private emit;
    /** Read-only access is NOT blocked by any write-release gate. */
    refresh(round: string, signal?: AbortSignal): Promise<Snapshot>;
    discover(beacon: string, cursor?: string | null, signal?: AbortSignal): Promise<{
        rounds: string[];
        nextCursor: string | null;
    }>;
    actions(round: string, signal?: AbortSignal): Promise<("BUY" | "CLOSE" | "DRAW" | "DRAW_AND_PAY" | "ACCEPT" | "ADVANCE_SAMPLE" | "ACCEPT_AND_PAY" | "PAY" | "TIMEOUT_REFUND" | "REFUND")[]>;
    private freeze;
    private estimate;
    prepare(round: string, op: Operation, funds: Funding[], budget: number, auth: Auth, signal?: AbortSignal): Promise<Prepared>;
    prepareFromSnapshot(snap: Snapshot, op: Operation, funds: Funding[], budget: number, auth: Auth): Promise<Prepared>;
    /** Address resolution belongs to the UI/SDK; null means explicitly no registration. */
    prepareGenesis(owner: string, config: import('./state.js').Config, funds: Funding[], auth: Auth, registrySpk?: Spk | null): Promise<Prepared>;
    /** F3.1 entry: default registry; pass null to opt out, or resolve a custom TN10 address via pinned SDK. */
    prepareF31Genesis(owner: string, config: import('./state.js').Config, funds: Funding[], auth: Auth, registrySpk?: Spk | null): Promise<Prepared>;
    prepareBeaconReclaim(outpoint: Snapshot['tip'], owner: string, tag: string, daa: bigint, budget: number, auth: Auth): Promise<Prepared>;
    private saveReceipt;
    execute(plan: Prepared, options: ExecutionOptions): Promise<Receipt>;
    resume(txid: string, signal?: AbortSignal): Promise<Receipt>;
}
