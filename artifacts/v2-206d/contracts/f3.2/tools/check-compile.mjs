// V2-only reproducibility check. RUN ONLY AFTER explicit compilation permission.
// Rebuilds REFUNDING -> SEALED -> OPEN into a NEW candidate directory; never compiles zero placeholders directly.
// node contracts/f3.2/tools/check-compile.mjs /absolute/silverc /absolute/new-bundle-directory
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {loadV2Bundle} from './linking.mjs';
const [exe, dest] = process.argv.slice(2);
if (!exe || !dest || process.argv.length !== 4 || !path.isAbsolute(exe) || !path.isAbsolute(dest)) throw Error('Usage: node check-compile.mjs /absolute/silverc /absolute/new-bundle-directory');
const root = fileURLToPath(new URL('../', import.meta.url));
const pinned = await loadV2Bundle(root); // Old F3.2 pins are not a V2 reproduction target.
execFileSync(process.execPath, [fileURLToPath(new URL('./build-v2.mjs', import.meta.url)), exe, dest], {stdio: 'inherit', timeout: 600000});
const rebuilt = await loadV2Bundle(dest);
assert.equal(rebuilt.profile.id, pinned.profile.id, 'Rebuilt V2 Profile differs');
assert.deepEqual(rebuilt.pins.frames, pinned.pins.frames, 'V2 source/constructor/artifact/template pins differ');
console.log('PASS: V2 linked build matches local pins. Compilation only; no VM, budget, acceptance or publication claim.');
