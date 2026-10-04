import { type Spk, type Outpoint } from './covenant-id.js';
import { type Transaction } from './transaction.js';
import * as S from './state.js';
import { type Operation, type Transition } from './protocol.js';
export interface Funding {
    outpoint: Outpoint;
    value: bigint;
    spk: Spk;
    daa: bigint;
    covenantId?: string | null;
}
export interface Draft {
    transaction: Transaction;
    inputUtxos: Funding[];
    authorizedInputIndices: number[];
    transition: Transition | null;
    origin: Outpoint;
    action: string;
    walletDebit: bigint;
    fee: bigint;
}
export declare function pushInt(n: bigint): Uint8Array;
export declare function witness(x: S.Snapshot, p: S.Profile, op: Operation, t: Transition, fee: bigint): string;
export declare function buildAction(x: S.Snapshot, p: S.Profile, op: Operation, fee: bigint, funds: Funding[], computeBudget?: number, payload?: string): Draft;
export declare function buildOpenGenesis(p: S.Profile, owner: string, config: S.Config, funds: Funding[], fee: bigint, registrySpk?: Spk | null): Draft;
export declare function assertDraft(d: Draft): void;
/** Receipt marker recipe: per-owner/tag address, permissionless spending to FIXED owner.
 * It is NOT an arbitrary pre-existing shared OP_TRUE registry address. */
export declare function beaconRedeem(owner: string, tag?: string): Uint8Array;
export declare function buildBeaconReclaim(outpoint: Outpoint, owner: string, tag: string, daa: bigint, budget: number): Draft;
export declare function createAnnouncement(p: S.Profile, origin: Outpoint, tag: string): string;
