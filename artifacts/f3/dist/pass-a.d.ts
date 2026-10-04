import * as S from './state.js';
export declare const COINBASE_LANE_KEY = "8aa78027db66a16cb69692ee0af5cb76738ef80ad14c9d13920d7fa3cc40b9e4";
export interface BlockResponse {
    block: {
        header: Record<string, unknown>;
        verboseData?: Record<string, unknown>;
        transactions?: Array<Record<string, unknown>>;
    };
}
export interface SelectedChain {
    removedChainBlockHashes: string[];
    addedChainBlockHashes: string[];
    chainBlockAcceptedTransactions: Array<{
        chainBlockHeader: {
            hash?: string;
            daaScore?: bigint | string | number;
        };
    }>;
}
export interface AcceptedClose {
    isAccepted: boolean;
    acceptingBlockHash: string;
    output0: {
        amount: bigint;
        scriptPublicKey: string;
        covenantId: string;
    };
}
export interface PassAProvider {
    getAcceptedClose(txid: string): Promise<AcceptedClose>;
    getSinkBlueScore(): Promise<{
        blueScore: bigint | string | number;
    }>;
    getVirtualChainFromBlockV2(arg: {
        startHash: string;
        minConfirmationCount: number;
    }): Promise<SelectedChain>;
    /** Optional untrusted DAA index: returns the candidate FIRST chain block with DAA >= B.
     * Fixed TN10 RPC cannot resolve a selected-chain hash from a DAA score directly.
     * A wrong/stale candidate is rejected; an unavailable index returns null.
     * An index returning an arbitrary later block must NOT be described as first-crossing.
     */
    getSelectedChainCandidateAtOrAfterDaa?(boundaryDaa: bigint): Promise<string | null>;
    getBlock(arg: {
        hash: string;
        includeTransactions: boolean;
    }): Promise<BlockResponse>;
    getSeqCommitLaneProof(hash: string, laneKey: string): Promise<unknown>;
}
export interface PassAResult {
    opening: Uint8Array;
    openingHex: string;
    boundaryDaa: string;
    parent: {
        hash: string;
        daa: string;
        seqCommit: string;
    };
    target: {
        hash: string;
        daa: string;
        seqCommit: string;
    };
    activityRoots: {
        parent: string;
        target: string;
    };
    payloadRoots: {
        parent: string;
        target: string;
    };
}
interface ParsedHeader {
    hash: string;
    daa: bigint;
    blue: bigint;
    timestamp: bigint;
    selectedParent: string;
    seqCommit: string;
    blueWork: string;
}
/** OwnedSmtProof::from_bytes + compute_root<SeqCommitActiveNode>. */
export declare function laneRoot(proofBytes: readonly number[], laneKey: string, lane: unknown): Uint8Array;
export declare function verifyLaneProof(headerSeq: string, proof: unknown, expectedParentSeq?: string): {
    activityRoot: Uint8Array<ArrayBufferLike>;
    lanesRoot: Uint8Array<ArrayBufferLike>;
    parentSeq: string;
    payloadAndCtxDigest: string;
};
export interface BlockData {
    header: ParsedHeader;
    coinbasePayload: string;
    blues: string[];
    reds: string[];
    chainBlock: boolean;
}
/** Assemble from already-captured node data, verifying both independent header SeqCommits. */
export declare function assemblePassA(input: {
    boundaryDaa: bigint;
    parent: BlockData;
    target: BlockData;
    parentLane: unknown;
    targetLane: unknown;
    blocks: Map<string, BlockData>;
}): PassAResult;
/** Locate T/P on the selected chain, collect RPC data and independently rebuild both roots. */
export declare function acquirePassA(snapshot: S.Snapshot, profile: S.Profile, provider: PassAProvider): Promise<PassAResult>;
export {};
