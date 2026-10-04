// Compatibility wrapper: the pinned F3 profile is now the `kaswin-f3` contract plugin (contracts/kaswin-f3.mjs).
import {create} from '../contracts/kaswin-f3.mjs';
import {ContractRegistry, validatePlugin} from './contracts.mjs';
import {DEFAULT_REGISTRY_ADDRESS} from '../../tn10-index/vps/registry.mjs';

export const PINNED_PROFILE_ID = '1dc418097f31655000dc779cd2c68d17812b981ab9868f25e7266d14fe70ba61';
export const NETWORK_GENESIS = 'f896a3034873be1739fc4359236899fd3d65d2bc94f9780df0d0da3eb1cc4370';

/** Legacy F3 fixture helper only. Runtime defaults are contracts/default.json (F3.2 + retired F3). */
export async function loadDefaultContracts({sdk, registryAddresses = [DEFAULT_REGISTRY_ADDRESS], packageDir} = {}) {
  const p = await create({profileId: PINNED_PROFILE_ID, networkGenesis: NETWORK_GENESIS, registryAddresses, ...(packageDir ? {packageDir} : {})}, {sdk});
  return new ContractRegistry([validatePlugin({...p, module: 'kaswin-f3.mjs'})]);
}
