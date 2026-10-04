import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const LOCAL_SDK_PATH = fileURLToPath(new URL('../sdk/kaspa.js', import.meta.url));

export function loadSdk() {
  const target = process.env.KASPA_SDK_PATH ? resolve(process.env.KASPA_SDK_PATH) : LOCAL_SDK_PATH;
  let sdk;
  try {
    sdk = require(target);
  } catch (err) {
    try {
      sdk = require('kaspa');
    } catch {
      throw new Error(`KASPA_SDK_LOAD_FAILED: could not load SDK from ${target} (${err.message})`);
    }
  }
  if (sdk.version() !== '2.0.1') throw new Error(`本服务核验 SDK 2.0.1，实际加载为 ${sdk.version()}`);
  if (typeof globalThis.WebSocket !== 'function') throw new Error('需要 Node.js 22+ 的原生 WebSocket 支持');
  return sdk;
}
