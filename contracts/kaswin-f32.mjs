// F3.2 fixed optimized templates; same state/ABI/transition adapter, distinct immutable profile key.
import {fileURLToPath} from 'node:url';
import {create as createF3} from './kaswin-f3.mjs';
export const PROFILE_ID = '7ca61d81be1a2448d16b18cb2bdce845c91ed4993a6da0fd26b14d211fbce863';
export const DEFAULT_PACKAGE = fileURLToPath(new URL('../artifacts/f32/', import.meta.url));
export async function create(options = {}, context = {}) {
  if (options.profileId && options.profileId !== PROFILE_ID) throw Error('F32_PROFILE_PIN_MISMATCH');
  return createF3({...options,
    packageDir: options.packageDir ?? DEFAULT_PACKAGE,
    profileId: PROFILE_ID,
  }, context);
}
