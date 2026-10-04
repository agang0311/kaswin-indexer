import type { Spk } from './covenant-id.js';
/** F3.1 client/indexer policy, NOT a change to the F3 covenant profile. */
export declare const DEFAULT_REGISTRY_ADDRESS = "kaspatest:qztrjpfpuf6g9jw76e6ay909z43hndpv5maqkker6ur4enz7llarsh82ezggl";
export declare const REGISTRATION_SOMPI = 5000000n;
export declare const DEFAULT_REGISTRY_SPK: Spk;
export declare function checkRegistrySpk(spk: Spk): Spk;
