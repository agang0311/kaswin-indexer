/** Browser-safe TN10 PASS-A acquisition and verification (no local Rust/Node dependency).
 * Fixed consensus source: rusty-kaspa cfafeb4 (seq-commit hashing/verify,
 * crypto/smt proof, ghostdag consensus_ordered_mergeset). The node's independent
 * header commitment is the reference; self-consistency alone is NOT accepted.
 */
import { cat, check, hex, le, same, unhex } from './bytes.js';
import { domainHash } from './blake3.js';
import * as S from './state.js';
const Z = new Uint8Array(32);
export const COINBASE_LANE_KEY = '8aa78027db66a16cb69692ee0af5cb76738ef80ad14c9d13920d7fa3cc40b9e4';
const COINBASE_SUBNETWORK = '0100000000000000000000000000000000000000';
const H = (tag, ...parts) => domainHash(tag, cat(...parts));
const branch = (l, r) => H('SeqCommitmentMerkleBranchHash', l, r);
const h32 = (v) => unhex(v, 32);
const eq = (a, b, code) => check(a === b, code);
function object(x, code) { check(x !== null && typeof x === 'object' && !Array.isArray(x), code); return x; }
function string(x, code) { check(typeof x === 'string', code); return x; }
function uint63(x, code) {
    check(typeof x === 'bigint' || typeof x === 'string' || typeof x === 'number' && Number.isSafeInteger(x), code);
    check(typeof x !== 'string' || /^(0|[1-9][0-9]*)$/.test(x), code);
    const n = BigInt(x);
    check(n >= 0n && n < 1n << 63n, code);
    return n;
}
const u64 = (x, code) => le(uint63(x, code), 8);
function parseHeader(raw) {
    const h = object(raw, 'BLOCK_HEADER'), parents = h.parentsByLevel;
    check(Array.isArray(parents) && Array.isArray(parents[0]) && typeof parents[0][0] === 'string', 'SELECTED_PARENT_MISSING');
    const hash = string(h.hash, 'BLOCK_HASH'), selectedParent = parents[0][0], seqCommit = string(h.acceptedIdMerkleRoot, 'HEADER_SEQ_COMMIT');
    h32(hash);
    h32(selectedParent);
    h32(seqCommit);
    const blueWork = string(h.blueWork, 'BLUE_WORK');
    check(/^(?:[0-9a-f]{2}){1,24}$/.test(blueWork), 'BLUE_WORK_ENCODING');
    return { hash, selectedParent, seqCommit, blueWork, daa: uint63(h.daaScore, 'BLOCK_DAA'), blue: uint63(h.blueScore, 'BLOCK_BLUE_SCORE'), timestamp: uint63(h.timestamp, 'BLOCK_TIMESTAMP') };
}
function merkle(leaves) {
    if (!leaves.length)
        return Z;
    if (leaves.length === 1)
        return leaves[0];
    let size = 1;
    while (size < leaves.length)
        size *= 2;
    // kaspa-merkle::calc_merkle_root_with_hasher: an absent LEFT subtree stays
    // absent. Only an existing left child with a missing right child hashes ZERO.
    // Hashing padded ZERO subtrees would give the wrong root for 5, 9, ... leaves.
    let level = Array.from({ length: size }, (_, i) => leaves[i]);
    while (level.length > 1) {
        const next = [];
        for (let i = 0; i < level.length; i += 2)
            next.push(level[i] === undefined ? undefined : branch(level[i], level[i + 1] ?? Z));
        level = next;
    }
    check(level[0] !== undefined, 'MERKLE_ROOT_MISSING');
    return level[0];
}
/** OwnedSmtProof::from_bytes + compute_root<SeqCommitActiveNode>. */
export function laneRoot(proofBytes, laneKey, lane) {
    check(Array.isArray(proofBytes) && proofBytes.length >= 33 && proofBytes.length <= 16384 && proofBytes.every(x => Number.isInteger(x) && x >= 0 && x <= 255), 'SMT_PROOF_BYTES');
    const raw = Uint8Array.from(proofBytes), bitmap = raw.slice(0, 32), tag = raw[32];
    let at = 33, depth = 256;
    if (tag === 1 || tag === 2) {
        check(raw.length > at, 'SMT_TERMINAL');
        depth = raw[at++];
    }
    else
        check(tag === 0, 'SMT_TERMINAL_TAG');
    check((lane === null ? tag !== 1 : tag !== 2), 'SMT_TERMINAL_LANE_MISMATCH');
    let foreignKey, foreignLeaf;
    if (tag === 2) {
        check(raw.length >= at + 64, 'SMT_FOREIGN_LEAF');
        foreignKey = raw.slice(at, at + 32);
        foreignLeaf = raw.slice(at + 32, at + 64);
        at += 64;
    }
    const expected = Array.from({ length: depth }, (_, d) => d).filter(d => (bitmap[d >>> 3] & (1 << (d & 7))) === 0).length;
    check(raw.length - at === expected * 32, 'SMT_SIBLING_COUNT');
    const key = h32(laneKey), siblings = Array.from({ length: expected }, (_, i) => raw.slice(at + i * 32, at + i * 32 + 32));
    let seed;
    if (lane !== null) {
        const v = object(lane, 'SMT_LANE');
        seed = H('SeqCommitActiveCollapsedNode', key, H('SeqCommitActiveLeaf', h32(string(v.tip, 'SMT_LANE_TIP')), u64(v.blueScore, 'SMT_LANE_SCORE')));
    }
    else
        seed = tag === 2 && foreignKey && !same(foreignKey, key) ? H('SeqCommitActiveCollapsedNode', foreignKey, foreignLeaf) : Z;
    let cursor = expected;
    const empty = [Z];
    for (let i = 1; i <= 256; i++)
        empty.push(H('SeqCommitActiveNode', empty[i - 1], empty[i - 1]));
    for (let d = depth - 1; d >= 0; d--) {
        const missing = (bitmap[d >>> 3] & (1 << (d & 7))) !== 0;
        const sibling = missing ? empty[255 - d] : siblings[--cursor];
        const right = (key[d >>> 3] & (0x80 >> (d & 7))) !== 0;
        seed = H('SeqCommitActiveNode', ...(right ? [sibling, seed] : [seed, sibling]));
    }
    check(cursor === 0, 'SMT_SIBLING_CURSOR');
    return seed;
}
export function verifyLaneProof(headerSeq, proof, expectedParentSeq) {
    const p = object(proof, 'LANE_PROOF'), laneKey = string(p.laneKey, 'LANE_KEY');
    eq(laneKey, COINBASE_LANE_KEY, 'WRONG_LANE');
    const siblings = p.smtProof;
    check(Array.isArray(siblings), 'SMT_PROOF_REQUIRED');
    const lr = laneRoot(siblings, laneKey, p.lane);
    const activity = H('SeqCommitActivityRoot', h32(string(p.inactivityShortcut, 'SHORTCUT')), lr);
    const digest = string(p.payloadAndCtxDigest, 'PAYLOAD_CONTEXT_DIGEST'), parentSeq = string(p.parentSeqCommit, 'PARENT_SEQ');
    h32(digest);
    h32(parentSeq);
    if (expectedParentSeq !== undefined)
        eq(parentSeq, expectedParentSeq, 'PARENT_SEQ_MISMATCH');
    const seq = branch(h32(parentSeq), branch(activity, h32(digest)));
    eq(hex(seq), headerSeq, 'LANE_HEADER_COMMITMENT_MISMATCH');
    return { activityRoot: activity, lanesRoot: lr, parentSeq, payloadAndCtxDigest: digest };
}
function minerPayloadLeaf(hash, blueWork, payload) {
    const work = unhex(blueWork), bytes = unhex(payload);
    check(work.length <= 24 && bytes.length <= 1_000_000, 'PAYLOAD_INPUT_LIMIT');
    let first = 0;
    while (first < work.length && work[first] === 0)
        first++;
    return H('SeqCommitMinerPayloadLeaf', h32(hash), le(BigInt(work.length - first), 8), work.slice(first), H('PayloadDigest', bytes));
}
function readBlock(response, withBody, selected) {
    const b = object(response.block, 'BLOCK_RESPONSE'), h = parseHeader(b.header), verbose = object(b.verboseData, 'BLOCK_VERBOSE');
    if (selected)
        check(verbose.isChainBlock === true, 'NOT_SELECTED_CHAIN_BLOCK');
    if (!withBody)
        return { header: h, coinbasePayload: '', blues: [], reds: [], chainBlock: verbose.isChainBlock === true };
    const txs = b.transactions;
    check(Array.isArray(txs) && txs.length > 0, 'COINBASE_MISSING');
    const coinbase = object(txs[0], 'COINBASE_TX');
    eq(string(coinbase.subnetworkId, 'COINBASE_SUBNETWORK'), COINBASE_SUBNETWORK, 'COINBASE_SUBNETWORK');
    const blues = verbose.mergeSetBluesHashes, reds = verbose.mergeSetRedsHashes;
    check(Array.isArray(blues) && blues.length > 0 && blues.every(v => typeof v === 'string') && Array.isArray(reds) && reds.every(v => typeof v === 'string'), 'MERGESET_MISSING');
    eq(blues[0], h.selectedParent, 'MERGESET_SELECTED_PARENT');
    const hashes = [...blues, ...reds];
    check(hashes.length <= 1024 && new Set(hashes).size === hashes.length, 'MERGESET_SIZE_OR_DUPLICATE');
    hashes.forEach(h32);
    const payload = string(coinbase.payload, 'COINBASE_PAYLOAD');
    unhex(payload);
    return { header: h, coinbasePayload: payload, blues: blues, reds: reds, chainBlock: verbose.isChainBlock === true };
}
function payloadRoot(current, mergeset) {
    const { blues, reds, header } = current, all = [...blues, ...reds];
    eq(all[0], header.selectedParent, 'MERGESET_PARENT');
    const ordered = all.slice(1).sort((a, b) => { const x = BigInt('0x' + mergeset.get(a).header.blueWork), y = BigInt('0x' + mergeset.get(b).header.blueWork); return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0; });
    return merkle([all[0], ...ordered].map(hash => { const data = mergeset.get(hash); check(data, 'MERGESET_BLOCK_MISSING'); return minerPayloadLeaf(hash, data.header.blueWork, data.coinbasePayload); }));
}
function verifyPayload(current, proofDigest, root, parent) {
    eq(current.header.selectedParent, parent.header.hash, 'CONTEXT_SELECTED_PARENT');
    const ctx = H('SeqCommitMergesetContext', u64(parent.header.timestamp, 'CONTEXT_TIMESTAMP'), u64(current.header.daa, 'CONTEXT_DAA'), u64(current.header.blue, 'CONTEXT_BLUE'));
    eq(hex(branch(ctx, root)), proofDigest, 'PAYLOAD_CONTEXT_HEADER_MISMATCH');
}
function openSeq(opening, base, parent) {
    const ctx = H('SeqCommitMergesetContext', opening.slice(base + 64, base + 88));
    return branch(parent, branch(opening.slice(base, base + 32), branch(ctx, opening.slice(base + 32, base + 64))));
}
/** Assemble from already-captured node data, verifying both independent header SeqCommits. */
export function assemblePassA(input) {
    const { boundaryDaa, parent, target, blocks } = input;
    check(parent.header.daa < boundaryDaa && target.header.daa >= boundaryDaa && target.header.blue > parent.header.blue, 'FIRST_CROSSING');
    eq(target.header.selectedParent, parent.header.hash, 'NOT_DIRECT_SELECTED_PARENT');
    const pProof = verifyLaneProof(parent.header.seqCommit, input.parentLane);
    const tProof = verifyLaneProof(target.header.seqCommit, input.targetLane, parent.header.seqCommit);
    const pParent = blocks.get(parent.header.selectedParent), tParent = blocks.get(target.header.selectedParent);
    check(pParent && tParent, 'CONTEXT_PARENT_MISSING');
    eq(pProof.parentSeq, pParent.header.seqCommit, 'P_PARENT_HEADER_COMMITMENT');
    const pRoot = payloadRoot(parent, blocks), tRoot = payloadRoot(target, blocks);
    verifyPayload(parent, pProof.payloadAndCtxDigest, pRoot, pParent);
    verifyPayload(target, tProof.payloadAndCtxDigest, tRoot, tParent);
    const opening = cat(h32(target.header.hash), tProof.activityRoot, tRoot, u64(tParent.header.timestamp, 'T_PARENT_TIME'), u64(target.header.daa, 'T_DAA'), u64(target.header.blue, 'T_BLUE'), h32(pProof.parentSeq), pProof.activityRoot, pRoot, u64(pParent.header.timestamp, 'P_PARENT_TIME'), u64(parent.header.daa, 'P_DAA'), u64(parent.header.blue, 'P_BLUE'));
    check(opening.length === 240, 'PASS_A_LENGTH');
    eq(hex(openSeq(opening, 152, opening.slice(120, 152))), parent.header.seqCommit, 'P_OPENING_COMMITMENT');
    eq(hex(openSeq(opening, 32, openSeq(opening, 152, opening.slice(120, 152)))), target.header.seqCommit, 'T_OPENING_COMMITMENT');
    return { opening, openingHex: hex(opening), boundaryDaa: boundaryDaa.toString(), parent: { hash: parent.header.hash, daa: parent.header.daa.toString(), seqCommit: parent.header.seqCommit }, target: { hash: target.header.hash, daa: target.header.daa.toString(), seqCommit: target.header.seqCommit }, activityRoots: { parent: hex(pProof.activityRoot), target: hex(tProof.activityRoot) }, payloadRoots: { parent: hex(pRoot), target: hex(tRoot) } };
}
/** Locate T/P on the selected chain, collect RPC data and independently rebuild both roots. */
export async function acquirePassA(snapshot, profile, provider) {
    const state = S.verifySnapshot(snapshot, profile);
    check(state.phase === S.Phase.SEALED && snapshot.tip.index === 0, 'SEALED_SNAPSHOT_REQUIRED');
    const accepted = await provider.getAcceptedClose(snapshot.tip.transactionId);
    check(accepted.isAccepted === true, 'CLOSE_NOT_ACCEPTED');
    h32(accepted.acceptingBlockHash);
    check(accepted.output0.amount === snapshot.value && accepted.output0.scriptPublicKey === snapshot.scriptPublicKey.script && accepted.output0.covenantId === snapshot.covenantId, 'CLOSE_OUTPUT_MISMATCH');
    const anchor = readBlock(await provider.getBlock({ hash: accepted.acceptingBlockHash, includeTransactions: false }), false, true);
    eq(anchor.header.hash, accepted.acceptingBlockHash, 'ACCEPTING_BLOCK_HASH');
    check(anchor.header.daa === snapshot.utxoDaa, 'SEALED_DAA_MISMATCH');
    const boundaryDaa = snapshot.utxoDaa + S.DRAW_DELAY;
    let parent, target;
    const candidate = await provider.getSelectedChainCandidateAtOrAfterDaa?.(boundaryDaa);
    if (candidate !== null && candidate !== undefined) {
        h32(candidate);
        target = readBlock(await provider.getBlock({ hash: candidate, includeTransactions: false }), false, true);
        eq(target.header.hash, candidate, 'CANDIDATE_HASH_MISMATCH');
        parent = readBlock(await provider.getBlock({ hash: target.header.selectedParent, includeTransactions: false }), false, true);
        eq(parent.header.hash, target.header.selectedParent, 'CANDIDATE_PARENT_HASH_MISMATCH');
        check(anchor.header.daa <= parent.header.daa && parent.header.daa < boundaryDaa && target.header.daa >= boundaryDaa, 'CANDIDATE_NOT_FIRST_CROSSING');
    }
    else {
        // The accepted CLOSE tx (regardless of who signed it) identifies the anchor.
        // Low verbosity returns aligned chainBlockHeader.daaScore entries; scan the
        // whole returned batch locally rather than getBlock(hash) once per chain block.
        // minConfirmationCount trims the response HEAD only; it is not a DAA index
        // or a policy for finality. Keep an explicit resource bound on pagination.
        const sink = uint63((await provider.getSinkBlueScore()).blueScore, 'SINK_BLUE_SCORE');
        check(sink >= anchor.header.blue, 'SINK_BEFORE_ANCHOR');
        const distance = sink - anchor.header.blue;
        const minConfirmationCount = Number(distance > 256n ? distance - 256n : 0n);
        let previousHash = anchor.header.hash, previousDaa = anchor.header.daa;
        for (let page = 0; page < 8 && target === undefined; page++) {
            const chain = await provider.getVirtualChainFromBlockV2({ startHash: previousHash, minConfirmationCount });
            check(Array.isArray(chain.removedChainBlockHashes) && chain.removedChainBlockHashes.length === 0 &&
                Array.isArray(chain.addedChainBlockHashes) && chain.addedChainBlockHashes.length > 0 && chain.addedChainBlockHashes.length <= 512 &&
                Array.isArray(chain.chainBlockAcceptedTransactions) && chain.chainBlockAcceptedTransactions.length === chain.addedChainBlockHashes.length, 'SELECTED_CHAIN_BATCH_UNAVAILABLE');
            for (let i = 0; i < chain.addedChainBlockHashes.length; i++) {
                const hash = chain.addedChainBlockHashes[i];
                h32(hash);
                const row = object(chain.chainBlockAcceptedTransactions[i], 'CHAIN_BLOCK_ROW');
                const head = object(row.chainBlockHeader, 'CHAIN_BLOCK_LOW_HEADER');
                eq(string(head.hash, 'CHAIN_BLOCK_HEADER_HASH'), hash, 'CHAIN_HEADER_HASH_MISMATCH');
                const daa = uint63(head.daaScore, 'CHAIN_BLOCK_DAA');
                check(daa > previousDaa, 'SELECTED_CHAIN_DAA_NOT_INCREASING');
                if (daa >= boundaryDaa) {
                    // Only P and T require full headers/bodies; full getBlock also rechecks
                    // isChainBlock and T's exact selected parent against the preceding hash.
                    parent = readBlock(await provider.getBlock({ hash: previousHash, includeTransactions: false }), false, true);
                    target = readBlock(await provider.getBlock({ hash, includeTransactions: false }), false, true);
                    eq(parent.header.hash, previousHash, 'P_HASH_MISMATCH');
                    eq(target.header.hash, hash, 'T_HASH_MISMATCH');
                    check(parent.header.daa === previousDaa && target.header.daa === daa, 'CHAIN_LOW_FULL_DAA_MISMATCH');
                    eq(target.header.selectedParent, parent.header.hash, 'SELECTED_PARENT_DISCONTINUITY');
                    break;
                }
                previousHash = hash;
                previousDaa = daa;
            }
        }
    }
    check(parent && target && parent.header.daa < boundaryDaa && target.header.daa >= boundaryDaa && target.header.selectedParent === parent.header.hash, 'FIRST_CROSSING_UNAVAILABLE');
    const pFull = readBlock(await provider.getBlock({ hash: parent.header.hash, includeTransactions: true }), true, true);
    const tFull = readBlock(await provider.getBlock({ hash: target.header.hash, includeTransactions: true }), true, true);
    eq(pFull.header.seqCommit, parent.header.seqCommit, 'P_HEADER_CHANGED');
    eq(tFull.header.seqCommit, target.header.seqCommit, 'T_HEADER_CHANGED');
    const blocks = new Map([[pFull.header.hash, pFull], [tFull.header.hash, tFull]]);
    const load = async (hash) => { if (!blocks.has(hash)) {
        const b = readBlock(await provider.getBlock({ hash, includeTransactions: true }), true, false);
        eq(b.header.hash, hash, 'MERGESET_BLOCK_HASH');
        blocks.set(hash, b);
    } return blocks.get(hash); };
    for (const hash of [...pFull.blues, ...pFull.reds, ...tFull.blues, ...tFull.reds, pFull.header.selectedParent, tFull.header.selectedParent])
        await load(hash);
    // Membership is rechecked just before returning. Native accessor rechecks at spend.
    const pCheck = readBlock(await provider.getBlock({ hash: pFull.header.hash, includeTransactions: false }), false, true), tCheck = readBlock(await provider.getBlock({ hash: tFull.header.hash, includeTransactions: false }), false, true);
    eq(pCheck.header.seqCommit, pFull.header.seqCommit, 'P_REORG');
    eq(tCheck.header.seqCommit, tFull.header.seqCommit, 'T_REORG');
    eq(tCheck.header.selectedParent, pCheck.header.hash, 'PARENT_REORG');
    const [pLane, tLane] = await Promise.all([provider.getSeqCommitLaneProof(pFull.header.hash, COINBASE_LANE_KEY), provider.getSeqCommitLaneProof(tFull.header.hash, COINBASE_LANE_KEY)]);
    return assemblePassA({ boundaryDaa, parent: pFull, target: tFull, parentLane: { ...object(pLane, 'P_LANE'), laneKey: COINBASE_LANE_KEY }, targetLane: { ...object(tLane, 'T_LANE'), laneKey: COINBASE_LANE_KEY }, blocks });
}
//# sourceMappingURL=pass-a.js.map