import { RestReader } from './rest-reader.js';
import type { BlockResponse, PassAProvider, SelectedChain } from './pass-a.js';
export interface ChainRpc {
    getSinkBlueScore(): Promise<{
        blueScore: bigint | string | number;
    }>;
    getVirtualChainFromBlockV2(arg: {
        startHash: string;
        minConfirmationCount: number;
        dataVerbosityLevel?: 'Low';
    }): Promise<SelectedChain>;
    getBlock(arg: {
        hash: string;
        includeTransactions: boolean;
    }): Promise<BlockResponse>;
}
/** JSON-wRPC messages return `params`, not JSON-RPC `result`. */
export declare class LaneProofRpc {
    readonly url: string;
    readonly timeoutMs: number;
    private ws;
    private next;
    private pending;
    constructor(url: string, timeoutMs?: number);
    connect(): Promise<void>;
    request(method: string, params: Record<string, unknown>): Promise<unknown>;
    getSeqCommitLaneProof(hash: string, laneKey?: string): Promise<unknown>;
    close(reason?: Error): void;
}
export declare function browserPassAProvider(services: {
    rest: RestReader;
    chain: ChainRpc;
    lane: LaneProofRpc;
}): PassAProvider;
