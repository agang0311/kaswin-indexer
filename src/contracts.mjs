// Contract plugins: the engine tracks a covenant UTXO lineage generically; a plugin owns the rules of ONE pinned
// contract version (how to recognise a Genesis, how to verify/decode one transition). New contract rules = new
// plugin + config entry; old rounds keep the plugin (and version) that created them, because a covenant's script
// is fixed at Genesis and does not change when a newer template is released.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';

export const BUILTIN_DIR = fileURLToPath(new URL('../contracts/', import.meta.url));
const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * Plugin interface (all rules are LOCAL and pinned; never load templates/profiles from the network or a relay):
 *   id, version: strings; `${id}@${version}` is stored on every round and relay message
 *   profileId?: string (pinned artifact identity, reported only)
 *   watchAddresses(): string[]            discovery addresses to subscribe (may be empty)
 *   discover(utxo): string|null           txid of a Genesis candidate from an `added` UTXO event, else null
 *   matchesGenesis?(tx): boolean         prefilter raw DTO before hydration; not acceptance/authentication
 *   genesis(tx, {hash, daa}): Round|null  null = not this contract; throw = unknown (retry), never silently drop
 *   advance(round, tx, {hash, daa}): Round  throw = accepted spend does not follow these rules -> STALE
 *   kindOf(tx): string                    label only, never used for filtering
 * Round (engine-required fields): id, tip: {transactionId,index}|null, spk: {version,script}|wire string,
 *   value: decimal string (sompi), cid: covenant id hex|null, terminal: string|null. Anything else is opaque.
 */
export function validatePlugin(p, where = 'plugin') {
  const bad = m => { throw Error(`CONTRACT_PLUGIN_INVALID ${where}: ${m}`); };
  if (!p || typeof p !== 'object') bad('not an object');
  if (!ID.test(p.id ?? '')) bad('id');
  if (typeof p.version !== 'string' || !p.version || p.version.length > 128) bad('version');
  for (const f of ['watchAddresses', 'discover', 'genesis', 'advance', 'kindOf']) if (typeof p[f] !== 'function') bad(f);
  if (p.matchesGenesis !== undefined && typeof p.matchesGenesis !== 'function') bad('matchesGenesis');
  return Object.freeze({...p, key: `${p.id}@${p.version}`});
}

export function checkRound(r, key) {
  const bad = m => { throw Error(`CONTRACT_ROUND_INVALID ${key}: ${m}`); };
  if (!r || typeof r.id !== 'string' || !/^[0-9a-f]{64}$/.test(r.id)) bad('id');
  if (r.tip !== null && !(typeof r.tip?.transactionId === 'string' && Number.isInteger(r.tip.index))) bad('tip');
  if (r.tip && !r.spk) bad('spk');
  if (r.tip && !/^[0-9]+$/.test(String(r.value))) bad('value');
  if (r.tip && r.cid != null && !/^[0-9a-f]{64}$/.test(r.cid)) bad('cid');
  if (!r.tip && !r.terminal) bad('terminal without reason');
  return r;
}

export class ContractRegistry {
  constructor(plugins = []) {
    this.byKey = new Map();
    for (const p of plugins) {
      const v = p.key ? p : validatePlugin(p);
      if (this.byKey.has(v.key)) throw Error('CONTRACT_DUPLICATE ' + v.key);
      this.byKey.set(v.key, v);
    }
  }
  get(key) { const p = this.byKey.get(key); if (!p) throw Error('CONTRACT_NOT_LOADED ' + key); return p; }
  has(key) { return this.byKey.has(key); }
  all() { return [...this.byKey.values()]; }
  /** Only plugins still accepting new rounds are asked about Genesis; retired ones still verify their old rounds. */
  forGenesis(only = null) { return this.all().filter(p => (only ? p.key === only || p.id === only : !p.retired)); }
  watchAddresses() { return [...new Set(this.all().filter(p => !p.retired).flatMap(p => p.watchAddresses()))]; }
  describe() { return this.all().map(p => ({key: p.key, profileId: p.profileId ?? null, retired: !!p.retired, module: p.module ?? null, moduleSha256: p.moduleSha256 ?? null})); }
}

/**
 * contracts.json:
 *   {"contracts": [{"module": "kaswin-f3.mjs" | "./path/x.mjs", "sha256": "<hex, optional pin>", "retired": false,
 *                   "options": {...plugin specific...}}]}
 * Bare names resolve in the built-in contracts/ dir; relative paths resolve against the config file.
 */
export async function loadContracts(configPath, ctx = {}) {
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!Array.isArray(cfg.contracts) || !cfg.contracts.length) throw Error('CONTRACTS_CONFIG_EMPTY');
  const base = path.dirname(path.resolve(configPath)), plugins = [];
  for (const [i, c] of cfg.contracts.entries()) {
    const file = /[\\/]/.test(c.module) ? path.resolve(base, c.module) : path.join(BUILTIN_DIR, c.module);
    const sha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    if (c.sha256 && c.sha256 !== sha) throw Error(`CONTRACT_MODULE_HASH_MISMATCH ${c.module} expected ${c.sha256} got ${sha}`);
    const mod = await import(pathToFileURL(file).href);
    if (typeof mod.create !== 'function') throw Error('CONTRACT_MODULE_WITHOUT_CREATE ' + c.module);
    const options = {...c.options};
    if (ctx.registryAddresses !== undefined) options.registryAddresses = ctx.registryAddresses;
    const p = await mod.create(options, ctx);
    plugins.push(validatePlugin({...p, retired: c.retired === true, module: c.module, moduleSha256: sha, pinned: !!c.sha256}, `contracts[${i}]`));
  }
  return new ContractRegistry(plugins);
}
