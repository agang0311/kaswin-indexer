import { check, unhex } from './bytes.js';
/** F3.1 client/indexer policy, NOT a change to the F3 covenant profile. */
export const DEFAULT_REGISTRY_ADDRESS = 'kaspatest:qztrjpfpuf6g9jw76e6ay909z43hndpv5maqkker6ur4enz7llarsh82ezggl';
export const REGISTRATION_SOMPI = 5000000n;
// Decoded from the above address using pinned official kaspa-wasm 2.0.1
// payToAddressScript, not inferred from the readable address string.
export const DEFAULT_REGISTRY_SPK = Object.freeze({ version: 0, script: '2096390521e27482c9ded675d215e5156379b42ca6fa0b5b23d7075ccc5efffa38ac' });
export function checkRegistrySpk(spk) {
    check(spk !== null && Number.isInteger(spk.version) && spk.version >= 0 && spk.version <= 65535, 'REGISTRY_VERSION');
    check(typeof spk.script === 'string' && spk.script.length > 0 && spk.script.length <= 2000000, 'REGISTRY_SCRIPT');
    unhex(spk.script);
    return { version: spk.version, script: spk.script.toLowerCase() };
}
//# sourceMappingURL=registry.js.map