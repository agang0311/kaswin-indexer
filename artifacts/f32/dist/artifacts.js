/** Load trusted build OUTPUTS, never use registry-provided artifact metadata as trust. */
import { ascii, cat, check, hex, unhex } from './bytes.js';
import { blake2b256 } from './hashes.js';
import { MODULES, templateHash } from './state.js';
export const COMPILER_COMMIT = '3ed973335b59269293564805cc2c58a14595ec03';
const names = { open: 'KaswinOpen', sealed: 'KaswinSealed', refunding: 'KaswinRefunding' };
function object(x) { check(x !== null && typeof x === 'object' && !Array.isArray(x), 'ARTIFACT_OBJECT'); return x; }
function bytes(x) { if (typeof x === 'string')
    return unhex(x.replace(/^0x/, '')); check(Array.isArray(x) && x.every(b => Number.isInteger(b) && b >= 0 && b <= 255), 'ARTIFACT_BYTES'); return new Uint8Array(x); }
export function parseCompiledFrame(module, doc, sourceSha256) {
    unhex(sourceSha256, 32);
    const d = object(doc);
    check(d.schema_version === 1 && d.compiler_version === '0.1.0', 'ARTIFACT_VERSION');
    const c = object(object(d.contracts)[names[module]]), rt = object(c.runtime_state), fields = rt.fields;
    check(Array.isArray(fields) && fields.length === 1 && object(fields[0]).name === 'ledger', 'ARTIFACT_STATE');
    const a = object(c.compiled), script = bytes(a.bytecode), span = object(a.state_span);
    check(span.offset === 1 && Number.isSafeInteger(span.len), 'ARTIFACT_FRAME');
    const len = span.len;
    check(script[0] === 0x6b && len > 0 && len < script.length - 1, 'ARTIFACT_FRAME');
    const tail = script.slice(1 + len);
    check(tail[0] === 0x6c, 'ARTIFACT_FRAME');
    const hash = templateHash(tail);
    check(hash === hex(bytes(a.template_hash)), 'ARTIFACT_HASH');
    const entry = object(object(c.entries).spend), params = entry.params;
    const expected = ['action', 'originTxId', 'originIndex', 'programTailBytes', 'genesisTail', 'nextTail', 'data', 'actorPk', 'fee'];
    check(Array.isArray(params) && params.length === expected.length && params.every((x, i) => object(x).name === expected[i]), 'ENTRY_ABI_CHANGED');
    const types = [{ kind: 'int' }, { kind: 'fixed_bytes', len: 32 }, { kind: 'int' }, { kind: 'int' }, { kind: 'bytes' }, { kind: 'bytes' }, { kind: 'bytes' }, { kind: 'pubkey' }, { kind: 'int' }];
    check(params.every((x, i) => { const t = object(object(x).type), e = types[i]; return t.kind === e.kind && (e.kind !== 'fixed_bytes' || t.len === e.len); }), 'ENTRY_ABI_TYPE_CHANGED');
    check(typeof entry.dispatch_tag === 'string', 'ARTIFACT_TAG');
    unhex(entry.dispatch_tag, 4);
    return { tail, templateHash: hash, dispatchTag: entry.dispatch_tag, sourceSha256 };
}
export function makeProfile(networkGenesis, frames) {
    unhex(networkGenesis, 32);
    for (const m of MODULES)
        check(templateHash(frames[m].tail) === frames[m].templateHash, 'ARTIFACT_HASH');
    check(new Set(MODULES.map(m => frames[m].templateHash)).size === 3, 'FRAME_COLLISION');
    const id = hex(blake2b256(cat(ascii('KASWIN_F3_PROFILE_V1'), unhex(networkGenesis, 32), ...MODULES.flatMap(m => [unhex(frames[m].sourceSha256, 32), unhex(frames[m].templateHash, 32), unhex(frames[m].dispatchTag, 4)]))));
    return { id, networkGenesis, frames, compilerCommit: COMPILER_COMMIT };
}
export async function loadTrustedProfile(networkGenesis, inputs) {
    const frames = {};
    for (const m of MODULES) {
        const x = inputs[m];
        unhex(x.expectedArtifactSha256, 32);
        const actual = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(x.text))));
        check(actual === x.expectedArtifactSha256, 'ARTIFACT_NOT_TRUSTED');
        frames[m] = parseCompiledFrame(m, JSON.parse(x.text), x.sourceSha256);
    }
    return makeProfile(networkGenesis, frames);
}
//# sourceMappingURL=artifacts.js.map