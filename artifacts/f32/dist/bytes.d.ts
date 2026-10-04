/** Binary helpers. Application data are not Kaspa wire transactions. */
export declare class KaswinError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
export declare function check(ok: unknown, code: string, message?: string): asserts ok;
export declare function uint(value: bigint, bits?: number): bigint;
export declare function integer(n: number, min: number, max: number): number;
export declare function hex(bytes: Uint8Array): string;
export declare function unhex(value: string, length?: number): Uint8Array;
export declare function key(value: string): string;
export declare function cat(...parts: readonly Uint8Array[]): Uint8Array;
export declare const ascii: (s: string) => Uint8Array;
export declare function le(n: bigint, width: number): Uint8Array;
export declare function fromLe(b: Uint8Array): bigint;
export declare function same(a: Uint8Array, b: Uint8Array): boolean;
/** Exact decimal KAS parser. Never rounds a floating point amount. */
export declare function kasToSompi(s: string): bigint;
export declare function sompiToKas(n: bigint): string;
export declare function abortIfNeeded(signal?: AbortSignal): void;
/** Unambiguous typed snapshot for mutation checks, NOT a consensus serializer. */
export declare function stable(value: unknown): string;
