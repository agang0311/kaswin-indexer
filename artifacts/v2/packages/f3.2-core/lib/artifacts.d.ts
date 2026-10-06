import { type Profile, type Module, type Frame } from './state.js';
export declare const COMPILER_COMMIT = "3ed973335b59269293564805cc2c58a14595ec03";
export declare function parseCompiledFrame(module: Module, doc: unknown, sourceSha256: string): Frame;
export declare function makeProfile(frames: Record<Module, Frame>): Profile;
export declare function loadTrustedProfile(inputs: Record<Module, {
    text: string;
    expectedArtifactSha256: string;
    sourceSha256: string;
}>): Promise<Profile>;
