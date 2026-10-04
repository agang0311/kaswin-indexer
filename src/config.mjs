// Operator configuration only; does not change pinned contract rules.
export function runtimeOptions(cli, env = process.env) {
  const out = {...cli};
  const nodeKeys = ['url', 'urls', 'resolver', 'pool'];
  // An explicit CLI node mode overrides the entire environment node mode.
  if (!nodeKeys.some(k => cli[k])) {
    out.url = env.KASWIN_NODE_URL || undefined;
    out.urls = env.KASWIN_NODE_URLS || undefined;
    out.resolver = env.KASWIN_RESOLVER_URLS || undefined;
  }
  if (nodeKeys.filter(k => out[k]).length > 1) throw Error('USE_ONE_OF_URL_URLS_RESOLVER_POOL');
  const raw = cli['registry-addresses'] ?? env.KASWIN_REGISTRY_ADDRESSES;
  if (raw !== undefined) {
    const list = raw.split(',').map(x => x.trim());
    if (!list.length || list.length > 16 || list.some(x => !x.startsWith('kaspatest:') || /\s/.test(x)) || new Set(list).size !== list.length)
      throw Error('INVALID_REGISTRY_ADDRESSES');
    out.registryAddresses = list; // Actual address checksum/SPK validated by the pinned SDK at plugin creation.
  }
  return out;
}
