import { type Outpoint, type Spk } from './covenant-id.js';
export declare const HEADER = 356, BUSINESS_HEADER = 196, DEPOSIT = 20000000n, MIN_PRICE = 100000000n;
export declare const FINALIZER = 100000000n, MAX_PAY_FEE = 50000000n, REFUND_FEE = 1000000n;
export declare const DRAW_DELAY = 100n, TIMEOUT_DELAY = 300n, DAA_LIMIT = 500000000000n;
export declare const MAX_PURCHASES = 256, MAX_TICKETS = 100000, VALUE_LIMIT = 9000000000000000n;
export declare const ZERO: string, MODULES: readonly ["open", "sealed", "refunding"];
export type Module = typeof MODULES[number];
export declare enum Phase {
    OPEN = 1,
    SEALED = 2,
    DRAW_READY = 3,
    WINNER_READY = 4,
    REFUNDING = 5
}
export interface Routes {
    open: string;
    sealed: string;
    refunding: string;
}
export interface Config {
    ticketPrice: bigint;
    ticketCap: number;
    purchaseCap: number;
    minTickets: number;
    closeEligibleDaa: bigint;
}
export interface Ledger {
    phase: Phase;
    ownerKey: string;
    networkGenesis: string;
    routes: Routes;
    config: Config;
    sold: number;
    purchaseCount: number;
    cursor: number;
    anchorDaa: bigint;
    anchorTxId: string;
    anchorIndex: number;
    seed: string;
    counter: number;
    winnerPlusOne: number;
    targetHash: string;
    targetSeq: string;
    directory: Uint8Array;
}
export interface Frame {
    tail: Uint8Array;
    templateHash: string;
    dispatchTag: string;
    sourceSha256: string;
}
export interface Profile {
    id: string;
    networkGenesis: string;
    frames: Record<Module, Frame>;
    compilerCommit: string;
}
export interface Snapshot {
    ledger: Uint8Array;
    tip: Outpoint;
    scriptPublicKey: Spk;
    covenantId: string;
    value: bigint;
    utxoDaa: bigint;
    currentDaa: bigint;
    origin: Outpoint;
}
export declare function phaseModule(phase: Phase): Module;
export declare function templateHash(tail: Uint8Array): string;
/** State pushes use data opcodes, not ScriptNum optimizations. */
export declare function pushBytes(b: Uint8Array): Uint8Array;
export declare function scriptFor(ledger: Uint8Array, tail: Uint8Array): Uint8Array;
export declare function newOpen(ownerKey: string, networkGenesis: string, routes: Routes, config: Config): Ledger;
export declare function encodeLedger(s: Ledger): Uint8Array;
export declare function decodeLedger(b: Uint8Array): Ledger;
export declare function validateConfig(c: Config): void;
export declare function records(s: Ledger): {
    end: number;
    key: string;
    count: number;
}[];
export declare function validateLedger(s: Ledger): void;
export declare function valueOf(s: Ledger): bigint;
export declare function rootScript(s: Ledger, p: Profile): Uint8Array;
export declare function rootId(origin: Outpoint, genesisScript: Uint8Array): string;
/** Crucial bootstrap trust: a root-CID equation alone does not authenticate arbitrary route hashes. */
export declare function verifySnapshot(x: Snapshot, p: Profile): Ledger;
export declare function scriptOf(s: Ledger, p: Profile): Uint8Array;
export declare function appendPurchase(s: Ledger, quantity: number, buyer: string): Ledger;
export declare function cloneLedger(s: Ledger): Ledger;
