import type { Outpoint, Spk } from './covenant-id.js';
export interface Binding {
    covenantId: string;
    authorizingInput: number;
}
export interface Input {
    previousOutpoint: Outpoint;
    signatureScript: string;
    sequence: bigint;
    computeBudget?: number;
    sigOpCount?: number;
}
export interface Output {
    value: bigint;
    scriptPublicKey: Spk;
    covenant?: Binding | null;
}
export interface Transaction {
    version: number;
    inputs: Input[];
    outputs: Output[];
    lockTime: bigint;
    subnetworkId: string;
    gas: bigint;
    payload: string;
    storageMass: bigint;
}
export declare function validateTransaction(t: Transaction): void;
/** Signature scripts, sigop counts, budgets and mass are excluded by consensus txid hashing. */
export declare function transactionIdPreimage(t: Transaction, emptyPayload: boolean): Uint8Array;
export declare function referenceTxId(t: Transaction): string;
/** Do not compare txids alone: txids intentionally exclude some protected signing fields. */
export declare function assertOnlyAuthorizedSignaturesChanged(before: Transaction, after: Transaction, authorized: readonly number[]): void;
export declare function outpointKey(o: Outpoint): string;
