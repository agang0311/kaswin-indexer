// V2 reverse-topological linker. RUN ONLY AFTER explicit compilation permission.
// node contracts/f3.2/tools/build-v2.mjs /absolute/silverc /absolute/new-bundle-directory
// Writes a standalone candidate bundle only; never installs it, tests, signs or broadcasts.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import * as S from '../../../packages/f3.2-core/lib/state.js';
import {parseCompiledFrame, makeProfile, COMPILER_COMMIT} from '../../../packages/f3.2-core/lib/artifacts.js';
import {ORDER, DEPENDENCIES, COMPILER_SHA256, NETWORK_GENESIS, sha256, linkSource, requireV2Core, loadV2Bundle} from './linking.mjs';

const [exe, dest] = process.argv.slice(2);
if (!exe || !dest || process.argv.length !== 4 || !path.isAbsolute(exe) || !path.isAbsolute(dest)) throw Error('Usage: node build-v2.mjs /absolute/silverc /absolute/new-bundle-directory');
requireV2Core();
assert.equal(sha256(await fs.readFile(exe)), COMPILER_SHA256, 'Compiler binary does not match the pinned SilverScript build');
const root = fileURLToPath(new URL('../', import.meta.url));
await fs.mkdir(dest); // Fail if it exists; no tracked files or existing artifacts are overwritten.
await fs.mkdir(path.join(dest, 'src'));
await fs.mkdir(path.join(dest, 'artifacts'));
const frames = {}, framePins = {};
// Public test point, NOT a wallet or private key. Constructor values only instantiate the state span.
const owner = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const config = {ticketPrice: 100000000n, ticketCap: 3, purchaseCap: 256, minTickets: 3, closeEligibleDaa: 500n};
for (const module of ORDER) {
  const template = await fs.readFile(path.join(root, `src/${module}.sil`), 'utf8');
  const linked = linkSource(module, template, frames);
  let ledger = S.newOpen(owner, config);
  if (module !== 'open') ledger = {...S.appendPurchase(ledger, 3, owner), phase: module === 'sealed' ? S.Phase.SEALED : S.Phase.REFUNDING};
  S.validateLedger(ledger);
  const raw = S.encodeLedger(ledger), args = JSON.stringify([{kind: 'bytes', value: Array.from(raw)}]) + '\n';
  const sourceFile = path.join(dest, `artifacts/${module}-linked.sil`);
  const argsFile = path.join(dest, `artifacts/${module}-linked.args.json`);
  const outputFile = path.join(dest, `artifacts/${module}-linked.json`);
  await fs.writeFile(path.join(dest, `src/${module}.sil`), template, {flag: 'wx'});
  await fs.writeFile(sourceFile, linked, {flag: 'wx'});
  await fs.writeFile(argsFile, args, {flag: 'wx'});
  const log = execFileSync(exe, [sourceFile, '--constructor-args', argsFile, '-o', outputFile], {encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024});
  await fs.writeFile(path.join(dest, `artifacts/${module}.log`), log, {flag: 'wx'});
  const artifact = await fs.readFile(outputFile), doc = JSON.parse(artifact.toString('utf8'));
  const frame = parseCompiledFrame(module, doc, sha256(linked));
  const name = {open: 'KaswinOpen', sealed: 'KaswinSealed', refunding: 'KaswinRefunding'}[module];
  const compiled = doc.contracts[name].compiled;
  const bytecode = typeof compiled.bytecode === 'string' ? Buffer.from(compiled.bytecode.replace(/^0x/, ''), 'hex') : Buffer.from(compiled.bytecode);
  assert.equal(compiled.state_span.len, S.pushBytes(raw).length, `${module}: compiler state push length mismatch`);
  assert.deepEqual(bytecode, Buffer.from(S.scriptFor(raw, frame.tail)), `${module}: compiler/TS state script mismatch`);
  assert.notEqual(frame.templateHash, S.ZERO, `${module}: zero template hash`);
  frames[module] = frame;
  framePins[module] = {templateSourceSha256: sha256(template), sourceSha256: sha256(linked), artifactSha256: sha256(artifact), constructorArgsSha256: sha256(args), templateHash: frame.templateHash, tailBytes: frame.tail.length,
    dependencies: Object.fromEntries(DEPENDENCIES[module].map(m => [m, frames[m].templateHash]))};
}
const profile = makeProfile(frames);
const serialized = Object.fromEntries(S.MODULES.map(m => [m, {...frames[m], tail: Buffer.from(frames[m].tail).toString('hex')}]));
const pins = {protocolVersion: 2, profileId: profile.id, networkGenesis: NETWORK_GENESIS, compilerCommit: COMPILER_COMMIT, compilerBinarySha256: COMPILER_SHA256,
  budgetProfileId: null, frames: framePins}; // Must remain null until new V2 budget measurements are reviewed.
const report = {status: 'V2_COMPILED_NOT_VM_OR_TN10_VERIFIED', protocolVersion: 2, profileId: profile.id, compilerCommit: COMPILER_COMMIT, compilerBinarySha256: COMPILER_SHA256,
  compileOrder: ORDER, frames: serialized, budgetStatus: 'PENDING_V2_VM_CALIBRATION', vm: 'NOT_RUN', network: 'NOT_RUN'};
for (const [name, value] of [['pins.json', pins], ['profile.json', {id: profile.id, compilerCommit: COMPILER_COMMIT, frames: serialized}], ['artifacts/build-report.json', report]]) {
  await fs.writeFile(path.join(dest, name), JSON.stringify(value, null, 2) + '\n', {flag: 'wx'});
}
await loadV2Bundle(dest);
console.log(`V2 candidate bundle: ${dest}\nProfile: ${profile.id}\nCompilation/ABI/link consistency only. VM, budget calibration, TN10 acceptance and publication remain BLOCKED.`);
