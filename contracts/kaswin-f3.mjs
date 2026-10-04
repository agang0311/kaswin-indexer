// Kaswin F3 (pinned profile) as a contract plugin. All rules come from the locally pinned compiled package and
// workers/tn10-index/vps/rounds.mjs; nothing is taken from the network.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createRoundAdapter} from '../src/adapter/rounds.mjs';
import {registryScope, registrationOf, DEFAULT_REGISTRY_ADDRESS} from '../src/adapter/registry.mjs';

export const DEFAULT_PACKAGE = fileURLToPath(new URL('../artifacts/f3/', import.meta.url));
const ACTIONS = ['?', 'BUY', 'CLOSE', 'DRAW', 'DRAW_AND_PAY', 'ACCEPT', 'ADVANCE_SAMPLE', 'ACCEPT_AND_PAY', 'PAY', 'TIMEOUT_REFUND', 'REFUND'];

export function actionOf(tx) {
  const s = tx?.inputs?.[0]?.signatureScript ?? '';
  const op = parseInt(s.slice(0, 2), 16);
  return op >= 0x51 && op <= 0x5a ? ACTIONS[op - 0x50] : 'UNKNOWN';
}

/**
 * options: profileId (REQUIRED pin), networkGenesis (REQUIRED), packageDir, artifactStatus, frames,
 *          registryAddresses (F3.1 discovery; [] = manual `track` only), registrationSompi
 */
export async function create(options, {sdk} = {}) {
  const o = {packageDir: DEFAULT_PACKAGE, artifactStatus: 'F3_COMPILED_NOT_VM_OR_TN10_VERIFIED', frames: ['open', 'refunding', 'sealed'],
    registryAddresses: [DEFAULT_REGISTRY_ADDRESS], registrationSompi: '5000000', ...options};
  if (!/^[0-9a-f]{64}$/.test(o.profileId ?? '')) throw Error('F3_PROFILE_ID_PIN_REQUIRED');
  if (!/^[0-9a-f]{64}$/.test(o.networkGenesis ?? '')) throw Error('F3_NETWORK_GENESIS_REQUIRED');
  const dir = path.resolve(o.packageDir);
  const mod = f => import(pathToFileURL(path.join(dir, 'dist', f)).href);
  const [S, P, G, B, H, A] = await Promise.all(['state.js', 'protocol.js', 'genesis-discovery.js', 'blake3.js', 'hashes.js', 'artifacts.js'].map(mod));
  const report = JSON.parse(fs.readFileSync(path.join(dir, 'artifacts/build-report.json'), 'utf8'));
  if (report.status !== o.artifactStatus || report.typescriptArtifactLoaderVerified !== true ||
      Object.keys(report.frames).sort().join(',') !== [...o.frames].sort().join(',')) throw Error('F3_ARTIFACT_GATE');
  const frames = Object.fromEntries(Object.entries(report.frames).map(([m, v]) => [m, {...v, tail: Uint8Array.from(Buffer.from(v.tail, 'hex'))}]));
  const profile = A.makeProfile(o.networkGenesis, frames);
  if (profile.id !== o.profileId) throw Error('UNPINNED_PROFILE ' + profile.id);
  const addresses = o.registryAddresses ?? [];
  const scope = sdk && addresses.length ? registryScope(sdk, addresses) : [];
  const adapter = createRoundAdapter({S, P, G, B, H, profile, registryScope: scope, registrationOf: scope.length ? registrationOf : null});
  const fee = BigInt(o.registrationSompi), watch = new Set(scope.map(r => r.address));
  const announcementPrefix = Buffer.from('KASWIN_F3_GENESIS').toString('hex') + profile.id;
  // Fast profile/shape rejection, then authenticate the creation template against the pinned package.
  // This is NOT acceptance or creator-funding validation: genesis() still runs after accepted-row hydration.
  const inspectGenesis = tx => {
    const payload = tx?.payload, output = tx?.outputs?.[0], binding = output?.covenant;
    if (typeof payload !== 'string' || !/^[0-9a-f]*$/.test(payload)) return {match: false, reason: 'GENESIS_PAYLOAD_FORMAT'};
    if (payload.length !== announcementPrefix.length + S.HEADER * 2) return {match: false, reason: 'GENESIS_ANNOUNCEMENT_LENGTH'};
    if (!payload.startsWith(announcementPrefix)) return {match: false, reason: 'GENESIS_TAG_OR_PROFILE_UNSUPPORTED'};
    if (!binding || binding.authorizingInput !== 0) return {match: false, reason: 'GENESIS_BINDING'};
    try {
      const k = output.scriptPublicKey;
      G.verifyGenesisAnnouncement({accepted: true, payload,
        authorizingOutpoint: tx.inputs?.[0]?.previousOutpoint, outputIndex: 0, value: BigInt(output.value),
        spk: typeof k === 'string' ? {version: parseInt(k.slice(2, 4) + k.slice(0, 2), 16), script: k.slice(4)} : k,
        covenantId: binding.covenantId, authorizingInput: binding.authorizingInput,
        covenantOutputIndices: tx.outputs.flatMap((o, i) => o.covenant?.covenantId === binding.covenantId ? [i] : []),
      }, profile);
      return {match: true};
    } catch (e) { return {match: false, reason: String(e?.message ?? e)}; }
  };
  return {
    id: 'kaswin-f3', version: profile.id.slice(0, 16), profileId: profile.id,
    watchAddresses: () => [...watch],
    // F3.1 registration marker: canonical output index 1 paying exactly the registration fee to a registry address.
    discover: u => (u.address && watch.has(u.address) && u.amount === fee && u.outpoint.index === 1 ? u.outpoint.transactionId : null),
    // Shallow discovery only. Never inspect witness or unrelated payload contents.
    candidateGenesis: tx => typeof tx?.payload === 'string' && tx.payload.startsWith(announcementPrefix),
    inspectGenesis,
    matchesGenesis: tx => inspectGenesis(tx).match,
    genesis: (tx, b) => adapter.genesis(tx, b),
    advance: (round, tx, b) => adapter.advance(round, tx, b),
    kindOf: actionOf,
    internals: {S, P, G, profile, adapter},
  };
}
