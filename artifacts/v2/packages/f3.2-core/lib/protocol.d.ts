import { type Spk } from './covenant-id.js';
import * as S from './state.js';
export declare const ACTIONS: {
    readonly BUY: 1;
    readonly CLOSE: 2;
    readonly DRAW_AND_PAY: 4;
    readonly TIMEOUT_REFUND: 9;
    readonly REFUND: 10;
};
export type Action = keyof typeof ACTIONS;
export type Operation = {
    action: Action;
    actorKey: string;
    quantity?: number;
    opening?: Uint8Array;
    accessor?: {
        blockHash: string;
        sequenceCommitment: string;
    };
};
export interface Payment {
    value: bigint;
    spk: Spk;
    role: 'WINNER' | 'CREATOR' | 'EXECUTOR' | 'BUYER_REFUND' | 'CHANGE';
}
export interface Transition {
    next: S.Ledger | null;
    terminal: 'PAID' | 'EMPTY' | 'REFUNDED' | null;
    payments: Payment[];
    data: Uint8Array;
    lockTime: bigint;
    sequence: bigint;
    requiredExternal: bigint;
    foreignTail: Uint8Array;
}
export declare function authenticateDraw(x: S.Snapshot, s: S.Ledger, proof: Uint8Array, accessor: {
    blockHash: string;
    sequenceCommitment: string;
}): S.Ledger;
export declare function sample(s: S.Ledger): {
    value: bigint;
    limit: bigint;
    ticket: number | null;
};
export declare function winnerRecord(s: S.Ledger): number;
export declare function timeoutDaa(x: S.Snapshot, s: S.Ledger): bigint;
export declare function availableActions(x: S.Snapshot, p: S.Profile): Action[];
/** The supplied network fee must later equal actual input-output difference. */
export declare function transition(x: S.Snapshot, p: S.Profile, op: Operation, fee: bigint, external?: bigint): Transition;
/** Provisional sizing envelope only. V2 VM calibration is pending; the web build must
 * bind a new budgetProfileId before release. Old measurements are NOT V2 evidence. */
export declare function actionUnits(action: Action, s: S.Ledger): number;
export declare const BUDGET_MARGIN = 3, GENESIS_INPUT_BUDGET = 10, FUNDING_INPUT_BUDGET = 10;
export declare function actionBudget(action: Action | 'GENESIS', s?: S.Ledger | null): number;
export declare const budgetOf: typeof actionBudget;
