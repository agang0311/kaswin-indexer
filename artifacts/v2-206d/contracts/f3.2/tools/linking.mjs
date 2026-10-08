/** V2-only local build provenance. No compiler/network side effects in this module. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {parseCompiledFrame, makeProfile, COMPILER_COMMIT} from '../../../packages/f3.2-core/lib/artifacts.js';
import * as S from '../../../packages/f3.2-core/lib/state.js';

export const ORDER = ['refunding', 'sealed', 'open'];
export const DEPENDENCIES = {refunding: [], sealed: ['refunding'], open: ['sealed', 'refunding']};
export const COMPILER_SHA256 = '81de9aa4157dbde3633ebab629e86c5975770fc13ee2d2093e52d7f725616a00';
export const NETWORK_GENESIS = 'f896a3034873be1739fc4359236899fd3d65d2bc94f9780df0d0da3eb1cc4370';
export const sha256 = b => createHash('sha256').update(b).digest('hex');
const HASH = /^[0-9a-f]{64}$/;
export function requireV2Core() {
  assert.equal(S.HEADER, 228, 'Regenerate the V2 core lib/ before linking or loading V2 artifacts');
  assert.equal(Buffer.from(S.encodeLedger(S.newOpen('00'.repeat(32), {ticketPrice: 100000000n, ticketCap: 3, purchaseCap: 256, minTickets: 3, closeEligibleDaa: 500n}))).subarray(0, 4).toString(), 'KW20');
}
export function linkSource(module, source, frames) {
  assert.ok(ORDER.includes(module), 'Unknown V2 module');
  const names = [...source.matchAll(/byte\[32\] constant ([A-Z]+)_TEMPLATE_HASH = byte\[32\]\(0x([0-9a-f]{64})\);/g)].map(m => m[1].toLowerCase());
  assert.deepEqual(names, DEPENDENCIES[module], `${module}: unexpected forward dependencies`);
  let linked = source;
  for (const dependency of DEPENDENCIES[module]) {
    const hash = frames[dependency]?.templateHash;
    assert.ok(HASH.test(hash ?? '') && hash !== '00'.repeat(32), `${module}: missing ${dependency} hash`);
    const marker = `byte[32] constant ${dependency.toUpperCase()}_TEMPLATE_HASH = byte[32](0x${'00'.repeat(32)});`;
    assert.equal(linked.split(marker).length, 2, `${module}: missing/duplicate placeholder`);
    linked = linked.replace(marker, `byte[32] constant ${dependency.toUpperCase()}_TEMPLATE_HASH = byte[32](0x${hash});`);
  }
  return linked;
}
/** Load only a completed V2 linked bundle from a trusted LOCAL directory, not an indexer. */
export async function loadV2Bundle(contractDir) {
  requireV2Core();
  const pins = JSON.parse(await fs.readFile(path.join(contractDir, 'pins.json'), 'utf8'));
  assert.equal(pins.protocolVersion, 2, 'V2 linked pins are required; old artifacts cannot be relabelled');
  assert.equal(pins.compilerCommit, COMPILER_COMMIT);
  assert.equal(pins.compilerBinarySha256, COMPILER_SHA256);
  assert.equal(pins.networkGenesis, NETWORK_GENESIS, 'Only the pinned TN10 build is supported');
  assert.deepEqual(Object.keys(pins.frames).sort(), [...S.MODULES].sort());
  const frames = {}, provenance = {};
  for (const module of ORDER) {
    const pin = pins.frames[module];
    assert.deepEqual(pin.dependencies, Object.fromEntries(DEPENDENCIES[module].map(m => [m, frames[m].templateHash])), `${module}: dependency provenance drift`);
    const template = await fs.readFile(path.join(contractDir, `src/${module}.sil`), 'utf8');
    const linked = await fs.readFile(path.join(contractDir, `artifacts/${module}-linked.sil`), 'utf8');
    const artifact = await fs.readFile(path.join(contractDir, `artifacts/${module}-linked.json`));
    const args = await fs.readFile(path.join(contractDir, `artifacts/${module}-linked.args.json`));
    assert.equal(sha256(template), pin.templateSourceSha256, `${module}: template source drift`);
    assert.equal(linked, linkSource(module, template, frames), `${module}: wrong linked dependency`);
    assert.equal(sha256(linked), pin.sourceSha256, `${module}: linked source drift`);
    assert.equal(sha256(artifact), pin.artifactSha256, `${module}: artifact drift`);
    assert.equal(sha256(args), pin.constructorArgsSha256, `${module}: constructor drift`);
    const frame = parseCompiledFrame(module, JSON.parse(artifact.toString('utf8')), pin.sourceSha256);
    assert.equal(frame.templateHash, pin.templateHash);
    assert.equal(frame.tail.length, pin.tailBytes);
    frames[module] = frame;
    provenance[module] = {...pin};
  }
  const profile = makeProfile(frames);
  assert.equal(profile.id, pins.profileId, 'Profile ID differs from V2 pins');
  return {pins, frames, profile, provenance};
}
