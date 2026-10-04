/** Pure discovery authentication. Provider must separately establish acceptance/live/reorg facts. */
import { ascii, check, hex, same, unhex } from './bytes.js';
import { blake2b256 } from './hashes.js';
import { p2sh } from './covenant-id.js';
import * as S from './state.js';
export function verifyGenesisAnnouncement(e, p) {
    check(e.accepted === true, 'GENESIS_NOT_ACCEPTED');
    const bytes = unhex(e.payload), tag = ascii('KASWIN_F3_GENESIS');
    check(bytes.length === tag.length + 32 + S.HEADER, 'GENESIS_ANNOUNCEMENT_LENGTH');
    check(same(bytes.slice(0, tag.length), tag), 'GENESIS_ANNOUNCEMENT_TAG');
    check(hex(bytes.slice(tag.length, tag.length + 32)) === p.id, 'GENESIS_PROFILE');
    const ledger = bytes.slice(tag.length + 32), s = S.decodeLedger(ledger);
    S.validateLedger(s);
    check(s.networkGenesis === p.networkGenesis, 'WRONG_NETWORK');
    for (const m of S.MODULES)
        check(s.routes[m] === p.frames[m].templateHash && S.templateHash(p.frames[m].tail) === s.routes[m], 'UNAPPROVED_TEMPLATE');
    const initial = S.newOpen(s.ownerKey, s.networkGenesis, s.routes, s.config);
    check(same(ledger, S.encodeLedger(initial)), 'NONCANONICAL_GENESIS_STATE');
    check(e.outputIndex === 0 && e.authorizingInput === 0 && e.value === S.DEPOSIT, 'GENESIS_OUTPUT');
    check(e.covenantOutputIndices.length === 1 && e.covenantOutputIndices[0] === 0, 'GENESIS_OUTPUT_GROUP');
    const script = S.rootScript(s, p), spk = p2sh(hex(blake2b256(script)));
    check(e.spk.version === spk.version && e.spk.script === spk.script, 'GENESIS_SPK');
    check(S.rootId(e.authorizingOutpoint, script) === e.covenantId, 'OPEN_GENESIS_CID_MISMATCH');
    return s;
}
//# sourceMappingURL=genesis-discovery.js.map