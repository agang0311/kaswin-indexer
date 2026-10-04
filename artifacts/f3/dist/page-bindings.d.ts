import { KaswinActions, type Prepared } from './browser-actions.js';
import { type Action } from './protocol.js';
import { type Funding } from './builders.js';
import { type PassAProvider } from './pass-a.js';
/** Plug into PageContext.drawProof; provider is browserPassAProvider(rest, SDK RPC, LaneProofRpc).
 * Refresh verifies the current snapshot before any proof request; the contract's
 * OpChainblockSeqCommit remains the final chain-membership check at spend.
 */
export declare function createPassADrawProof(api: KaswinActions, provider: PassAProvider): (round: string) => Promise<{
    opening: Uint8Array<ArrayBufferLike>;
    accessor: {
        blockHash: string;
        sequenceCommitment: string;
    };
}>;
export interface PageContext {
    actorKey(): string;
    /** Actual wallet UTXOs selected by the hosting app; never synthetic fixtures. */
    funds(action: Action): Promise<Funding[]>;
    /** From the tested native-VM budget profile for this action, not a guessed fee. */
    budget(action: Action): number;
    /** Actual node/proof provider. Timeout never calls this. */
    drawProof(round: string): Promise<{
        opening: Uint8Array;
        accessor: {
            blockHash: string;
            sequenceCommitment: string;
        };
    }>;
    /** Non-blocking application dialog with exact output/fee/debit display. */
    approve(plan: Prepared): Promise<boolean>;
}
export declare function bindKaswinPage(root: HTMLElement, api: KaswinActions, context: PageContext): () => void;
