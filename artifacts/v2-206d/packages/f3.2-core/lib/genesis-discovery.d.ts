import { type Outpoint, type Spk } from './covenant-id.js';
import * as S from './state.js';
export interface GenesisEvidence {
    accepted: boolean;
    payload: string;
    authorizingOutpoint: Outpoint;
    outputIndex: number;
    value: bigint;
    spk: Spk;
    covenantId: string;
    authorizingInput: number;
    /** All outputs sharing this CID, not all ordinary outputs. */
    covenantOutputIndices: number[];
}
export declare function verifyGenesisAnnouncement(e: GenesisEvidence, p: S.Profile): S.Ledger;
