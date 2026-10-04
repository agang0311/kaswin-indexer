import { type Spk } from './covenant-id.js';
import * as S from './state.js';
export declare const ACTIONS: {
    readonly BUY: 1;
    readonly CLOSE: 2;
    readonly DRAW: 3;
    readonly DRAW_AND_PAY: 4;
    readonly ACCEPT: 5;
    readonly ADVANCE_SAMPLE: 6;
    readonly ACCEPT_AND_PAY: 7;
    readonly PAY: 8;
    readonly TIMEOUT_REFUND: 9;
    readonly REFUND: 10;
};
export type Action = keyof typeof ACTIONS;
export type Operation = {
    action: Action;
    actorKey: string;
    quantity?: number;
    config?: S.Config;
    beaconSpk?: Spk;
    opening?: Uint8Array;
    accessor?: {
        blockHash: string;
        sequenceCommitment: string;
    };
};
export interface Payment {
    value: bigint;
    spk: Spk;
    role: 'WINNER' | 'CREATOR' | 'EXECUTOR' | 'BUYER_REFUND' | 'BEACON' | 'CHANGE';
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
/** Script-unit envelopes (upper bounds) for input 0, fitted 2026-10-01 on 3,446 offline VM cases
 * (rusty-kaspa cfafeb4 TxScriptEngine via references/silverscript-v1.0.0 tests/f3_2_vm.rs):
 * every purchaseCount 0..256, every REFUND cursor, 1/8 funding inputs, prices up to the VALUE_LIMIT
 * cap, and DRAW_AND_PAY winners at record 0/1/last. Units are deterministic for identical inputs.
 * The 2026-09-30 constants (CLOSE 116, TIMEOUT_REFUND 31, REFUND 24+1.1k) UNDER-budgeted
 * TIMEOUT_REFUND (pc>=29), REFUND (pc>=33) and CLOSE->REFUNDING at 256 records. */
export declare function actionUnits(action: Action, s: S.Ledger): number;
/** Consensus: allowed units = budget*10000 + 9999 free per input (consensus/core mass/units.rs).
 * BUDGET_MARGIN=3 extra units on top of the fitted envelope; each unit costs 100 grams (~0.0001 KAS at 1 sompi/gram). */
export declare const BUDGET_MARGIN = 3, GENESIS_INPUT_BUDGET = 10, FUNDING_INPUT_BUDGET = 10;
export declare function actionBudget(action: Action | 'GENESIS', s?: S.Ledger | null): number;
export declare const budgetOf: typeof actionBudget;
