export interface Outpoint {
    transactionId: string;
    index: number;
}
export interface Spk {
    version: number;
    script: string;
}
export interface AuthorizedOutput {
    index: number;
    value: bigint;
    spk: Spk;
}
export declare function p2sh(scriptHash: string, version?: number): Spk;
export declare function p2pk(publicKey: string): Spk;
export declare function spkBytes(spk: Spk): Uint8Array;
export declare function covenantPreimage(origin: Outpoint, outputs: readonly AuthorizedOutput[]): Uint8Array;
export declare function covenantId(origin: Outpoint, outputs: readonly AuthorizedOutput[]): string;
