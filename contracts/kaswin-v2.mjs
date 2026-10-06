// V2 plugin candidate. Requires an explicitly configured LOCAL publication repository + reviewed V2 Profile pin.
// No default Profile is fabricated; contracts/default.json intentionally remains unchanged until V2 artifacts exist.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createV2RoundAdapter} from './v2-rounds.mjs';
import {wireSpk} from '../src/normalize.mjs';
import {registryScope, registrationOf, DEFAULT_REGISTRY_ADDRESS, REGISTRATION_SOMPI} from '../src/adapter/registry.mjs';
const HASH = /^[0-9a-f]{64}$/;
const TN10_GENESIS = 'f896a3034873be1739fc4359236899fd3d65d2bc94f9780df0d0da3eb1cc4370';
const ACTIONS = {81: 'BUY', 82: 'CLOSE', 84: 'DRAW_AND_PAY', 89: 'TIMEOUT_REFUND', 90: 'REFUND'};

export const PROFILE_ID = '206d4ec7072727ae3291726f19c82293b38340a5a7de05d306cf105c4206a9c3';
export const NETWORK_GENESIS = TN10_GENESIS;

function resolveRepo(repoDir) {
  if (repoDir && typeof repoDir === 'string') return path.resolve(repoDir);
  if (process.env.KASWIN_V2_REPO) return path.resolve(process.env.KASWIN_V2_REPO);
  const candidates = [
    path.resolve(fileURLToPath(new URL('../../../references/kaswin-v2', import.meta.url))),
    path.resolve(fileURLToPath(new URL('../artifacts/v2', import.meta.url))),
    '/root/kaswin-publish-20261005'
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'contracts/f3.2/pins.json'))) return c;
  }
  return null;
}

export function actionOf(tx) {
  const script = tx?.inputs?.[0]?.signatureScript;
  return typeof script === 'string' && /^[0-9a-f]{2}/i.test(script) ? ACTIONS[parseInt(script.slice(0, 2), 16)] ?? 'UNKNOWN' : 'UNKNOWN';
}
export async function create(options = {}, {sdk} = {}) {
  const repoDir = resolveRepo(options.repoDir);
  const o = {repoDir, registryAddresses: [DEFAULT_REGISTRY_ADDRESS], registrationSompi: REGISTRATION_SOMPI, ...options};
  if (!HASH.test(o.profileId ?? '') || o.profileId === '00'.repeat(32)) throw Error('V2_PROFILE_PIN_REQUIRED');
  if (o.networkGenesis !== TN10_GENESIS) throw Error('V2_TN10_PIN_REQUIRED');
  if (typeof o.repoDir !== 'string' || !path.isAbsolute(o.repoDir) || !fs.existsSync(path.join(o.repoDir, 'contracts/f3.2/pins.json')))
    throw Error('V2_LOCAL_REPOSITORY_REQUIRED');
  if (String(o.registrationSompi) !== REGISTRATION_SOMPI) throw Error('V2_REGISTRATION_AMOUNT_PIN');
  if (!Array.isArray(o.registryAddresses)) throw Error('REGISTRY_ADDRESSES');
  const load = relative => import(pathToFileURL(path.join(o.repoDir, relative)).href);
  const {loadV2Bundle} = await load('contracts/f3.2/tools/linking.mjs');
  const {pins, profile} = await loadV2Bundle(path.join(o.repoDir, 'contracts/f3.2'));
  if (profile.id !== o.profileId || pins.networkGenesis !== o.networkGenesis) throw Error('V2_UNPINNED_PROFILE');
  const [S, P, G, B, H, builders] = await Promise.all(['state', 'protocol', 'genesis-discovery', 'blake3', 'hashes', 'builders'].map(m => load(`packages/f3.2-core/lib/${m}.js`)));
  const scope = sdk && o.registryAddresses.length ? registryScope(sdk, o.registryAddresses) : [];
  const adapter = createV2RoundAdapter({S, P, G, B, H, builders, profile, networkGenesis: o.networkGenesis, registryScope: scope, registrationOf});
  const watch = new Set(scope.map(r => r.address)), fee = BigInt(REGISTRATION_SOMPI);
  const prefix = Buffer.from('KASWIN_GENESIS_V2').toString('hex') + profile.id;
  // A routing/template check only. The engine must establish selected-chain acceptance and hydrate funding before genesis().
  const inspectGenesis = tx => {
    const payload = tx?.payload, output = tx?.outputs?.[0], binding = output?.covenant;
    if (typeof payload !== 'string' || !/^[0-9a-f]*$/.test(payload)) return {match: false, reason: 'GENESIS_PAYLOAD_FORMAT'};
    if (payload.length !== prefix.length + S.HEADER * 2 || !payload.startsWith(prefix)) return {match: false, reason: 'V2_TAG_PROFILE_OR_LENGTH'};
    if (!binding || binding.authorizingInput !== 0) return {match: false, reason: 'GENESIS_BINDING'};
    try {
      G.verifyGenesisAnnouncement({accepted: true, payload, authorizingOutpoint: tx.inputs?.[0]?.previousOutpoint,
        outputIndex: 0, value: BigInt(output.value), spk: wireSpk(output.scriptPublicKey), covenantId: binding.covenantId,
        authorizingInput: binding.authorizingInput, covenantOutputIndices: tx.outputs.flatMap((v, i) => v.covenant?.covenantId === binding.covenantId ? [i] : [])}, profile);
      return {match: true};
    } catch (e) { return {match: false, reason: String(e?.message ?? e)}; }
  };
  return {id: 'kaswin-v2', version: profile.id.slice(0, 16), profileId: profile.id,
    watchAddresses: () => [...watch],
    discover: u => u.address && watch.has(u.address) && u.amount === fee && u.outpoint.index === 1 && (!u.covenantId || u.covenantId === S.ZERO) ? u.outpoint.transactionId : null,
    candidateGenesis: tx => typeof tx?.payload === 'string' && tx.payload.startsWith(prefix),
    inspectGenesis, matchesGenesis: tx => inspectGenesis(tx).match,
    genesis: adapter.genesis, advance: adapter.advance, kindOf: actionOf,
    internals: {S, P, G, profile, adapter}};
}
