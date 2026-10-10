import fs from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

function findSdkPath() {
  if (process.env.KASPA_SDK_PATH && fs.existsSync(process.env.KASPA_SDK_PATH)) {
    return resolve(process.env.KASPA_SDK_PATH);
  }
  const candidates = [
    fileURLToPath(new URL('../sdk/kaspa.js', import.meta.url)),
    '/opt/kaswin-index/live/sdk/kaspa.js',
    fileURLToPath(new URL('../../../references/kaspa-wasm32-sdk/nodejs/kaspa/kaspa.js', import.meta.url))
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

export function loadSdk() {
  const target = findSdkPath();
  let sdk;
  if (target) {
    try {
      sdk = require(target);
    } catch (err) {
      throw new Error(`KASPA_SDK_LOAD_FAILED: could not load SDK from ${target} (${err.message})`);
    }
  } else {
    try {
      sdk = require('kaspa');
    } catch {
      throw new Error('KASPA_SDK_NOT_FOUND: no local SDK found in sdk/, /opt/kaswin-index/live/sdk, or references/');
    }
  }
  if (sdk.version() !== '2.0.1') throw new Error(`本服务核验 SDK 2.0.1，实际加载为 ${sdk.version()}`);
  if (typeof globalThis.WebSocket !== 'function') throw new Error('需要 Node.js 22+ 的原生 WebSocket 支持');
  return sdk;
}
