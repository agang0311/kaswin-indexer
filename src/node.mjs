// SDK 2.0.1 RpcClient via kaspa-resolver (or an explicit URL, never both). Read-only: no submit, no wallet.
// strategy 'fallback' + connectDeadlineMs: fail fast and dispose the client (used by dual-node members, which reconnect
// themselves; measured 2026-09-30: a connect against a refusing endpoint may hang past timeoutDuration).
export async function openNode(sdk, {network = 'testnet-10', url = null, resolverUrls = null, tls = undefined, timeoutMs = 15000, log = () => {},
  strategy = 'retry', connectDeadlineMs = null} = {}) {
  if (url && resolverUrls) throw Error('URL_AND_RESOLVER_ARE_EXCLUSIVE');
  const resolver = url ? undefined : new sdk.Resolver(resolverUrls ? {urls: resolverUrls, ...(tls === undefined ? {} : {tls})} : undefined);
  const rpc = new sdk.RpcClient(url ? {url, networkId: network, encoding: sdk.Encoding.Borsh} : {resolver, networkId: network, encoding: sdk.Encoding.Borsh});
  const handlers = {connect: [], disconnect: [], utxos: []};
  rpc.addEventListener('connect', () => handlers.connect.forEach(f => f()));
  rpc.addEventListener('disconnect', () => handlers.disconnect.forEach(f => f()));
  rpc.addEventListener('utxos-changed', e => handlers.utxos.forEach(f => f(e.data)));
  const connecting = rpc.connect({blockAsyncConnect: true, strategy: strategy === 'fallback' ? sdk.ConnectStrategy.Fallback : sdk.ConnectStrategy.Retry,
    timeoutDuration: timeoutMs, retryInterval: 3000});
  let identity;
  try {
    if (connectDeadlineMs) {
      let timer;
      await Promise.race([connecting, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('CONNECT_TIMEOUT')), connectDeadlineMs); })])
        .finally(() => clearTimeout(timer));
    } else await connecting;
    identity = await verifyNode(rpc, network);
  } catch (e) {
    connecting.catch(() => {});
    try { await rpc.disconnect(); } catch {}
    throw e;
  }
  log('CONNECTED', identity);

  const node = {
    rpc, identity,
    on(kind, fn) { handlers[kind].push(fn); },
    verify: async () => (node.identity = await verifyNode(rpc, network)),
    subscribeUtxosChanged: addrs => rpc.subscribeUtxosChanged(addrs),
    unsubscribeUtxosChanged: addrs => rpc.unsubscribeUtxosChanged(addrs),
    getBlockDagInfo: () => rpc.getBlockDagInfo(),
    getSinkBlueScore: () => rpc.getSinkBlueScore(),
    getBlock: r => rpc.getBlock(r),
    getBlocks: r => rpc.getBlocks(r),
    getMempoolEntriesByAddresses: r => rpc.getMempoolEntriesByAddresses(r),
    getUtxosByAddresses: r => rpc.getUtxosByAddresses(r),
    getVirtualChainFromBlock: r => rpc.getVirtualChainFromBlock(r),
    getVirtualChainFromBlockV2: r => rpc.getVirtualChainFromBlockV2(r),
    close: () => rpc.disconnect(),
  };
  return node;
}

async function verifyNode(rpc, network) {
  const info = await rpc.getServerInfo();
  if (info.networkId !== network) throw Error('WRONG_NETWORK_' + info.networkId);
  if (info.isSynced !== true) throw Error('NODE_NOT_SYNCED');
  if (info.hasUtxoIndex !== true) throw Error('NODE_WITHOUT_UTXOINDEX');   // subscribeUtxosChanged/getUtxosByAddresses need it
  let p2pId = null; try { p2pId = (await rpc.getInfo()).p2pId; } catch {}
  return {url: rpc.url ?? null, nodeId: rpc.nodeId ?? null, p2pId, serverVersion: info.serverVersion, networkId: info.networkId, checkedAt: new Date().toISOString()};
}

export function addressOfFactory(sdk, network) {
  return spk => {
    const s = new sdk.ScriptPublicKey(spk.version, spk.script);
    try { const a = sdk.addressFromScriptPublicKey(s, network); if (!a) throw Error('SPK_HAS_NO_ADDRESS'); return a.toString(); }
    finally { s.free?.(); }
  };
}
