import { type Draft } from './builders.js';
export interface NativeTransaction {
    id: string;
    storageMass: bigint;
    serializeToSafeJSON(): string;
    inputs: {
        signatureScript: string;
    }[];
    [key: string]: unknown;
}
export interface KaspaExports {
    Transaction: new (data: Record<string, unknown>) => NativeTransaction;
    calculateTransactionFee(network: string, tx: NativeTransaction, signatureCount: number): bigint | undefined;
    calculateTransactionMass(network: string, tx: NativeTransaction, signatureCount: number): bigint | undefined;
}
export interface ConnectedWallet {
    network: string;
    publicKey: string;
    signTransaction(transaction: NativeTransaction, inputIndexes: number[]): Promise<void>;
}
/** Quote must use all populated inputs, exact output scripts/CIDs and fixed network rules.
 * This hook handles transactions above the wallet helper's 100000 mass cap; never
 * interpret that helper's false/undefined as a consensus rejection. */
export interface ConsensusMassQuote {
    quote(draft: Draft, signedSizeReservation: boolean): Promise<{
        storageMass: bigint;
        computeMass: bigint;
        normalizedTransientMass: bigint;
        relayFeeFloor: bigint;
    }>;
}
export interface RpcClient {
    getServerInfo(): Promise<{
        networkId?: string;
        network?: string;
    }>;
    submitTransaction(request: {
        transaction: NativeTransaction;
        allowOrphan: boolean;
    }): Promise<{
        transactionId: string;
    }>;
}
/** Compare the WHOLE SDK serialization, not only fields known to our DTO codec. */
export declare function inspectNativeMutation(before: string, after: string, indices: readonly number[]): void;
export declare class KaspaSdkAdapter {
    readonly sdk: KaspaExports;
    readonly rpc: RpcClient;
    readonly networkId: string;
    readonly wallet: () => ConnectedWallet | null;
    readonly massQuote?: ConsensusMassQuote | undefined;
    constructor(sdk: KaspaExports, rpc: RpcClient, networkId: string, wallet: () => ConnectedWallet | null, massQuote?: ConsensusMassQuote | undefined);
    assertNetwork(): Promise<void>;
    private quote;
    native(d: Draft): Promise<NativeTransaction>;
    measure(d: Draft): Promise<{
        feeFloor: bigint;
        mass: bigint;
    }>;
    sign(d: Draft, actorKey: string): Promise<{
        native: NativeTransaction;
        safeJson: string;
        txid: string;
    }>;
    submitSigned(tx: NativeTransaction): Promise<string>;
}
