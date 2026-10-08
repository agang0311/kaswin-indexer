/** Build-time evidence gate only: validates a reviewed, hash-bound calibration receipt.
 * It does NOT run a VM or make measurements. No receipt is fabricated by compilation. */
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {sha256} from './linking.mjs';
import {actionBudget, actionUnits} from '../../../packages/f3.2-core/lib/protocol.js';
const REQUIRED = ['GENESIS', 'BUY', 'CLOSE_EMPTY', 'CLOSE_SEALED', 'CLOSE_REFUNDING', 'DRAW_AND_PAY', 'TIMEOUT_REFUND', 'REFUND_INTERMEDIATE', 'REFUND_FINAL'];
export async function requireReviewedBudgets(contract, pins, profile) {
  assert.equal(pins.budgetProfileId, profile.id, 'V2 budget calibration incomplete: release is BLOCKED');
  assert.match(pins.budgetEvidenceSha256 ?? '', /^[0-9a-f]{64}$/, 'Missing reviewed budget evidence fingerprint');
  const raw = await fs.readFile(path.join(contract, 'budget-evidence.json'));
  assert.equal(sha256(raw), pins.budgetEvidenceSha256, 'Budget evidence hash mismatch');
  const e = JSON.parse(raw);
  assert.equal(e.schema, 'KASWIN_V2_BUDGET_REVIEW_1');
  const report = JSON.parse(await fs.readFile(path.join(contract, 'artifacts/build-report.json'), 'utf8'));
  assert.equal(report.budgetStatus, 'REVIEWED_V2_VM_CALIBRATION', 'Build report still declares calibration pending');
  assert.equal(e.profileId, profile.id);
  assert.equal(e.compilerCommit, pins.compilerCommit);
  assert.equal(e.compilerBinarySha256, pins.compilerBinarySha256);
  assert.equal(e.consensusCommit, 'cfafeb4c093fa37a303f1b9f19c58f986b870ce3');
  assert.equal(e.protocolSourceSha256, sha256(await fs.readFile(new URL('../../../packages/f3.2-core/src/protocol.ts', import.meta.url))));
  assert.equal(e.buildersSourceSha256, sha256(await fs.readFile(new URL('../../../packages/f3.2-core/src/builders.ts', import.meta.url))));
  assert.equal(e.review?.status, 'APPROVED');
  assert.ok(typeof e.review.reviewer === 'string' && e.review.reviewer.trim());
  assert.ok(typeof e.review.at === 'string' && Number.isFinite(Date.parse(e.review.at)));
  assert.equal(e.coverage?.maxPurchases, 256);
  assert.equal(e.coverage?.refundBatch, 32);
  assert.equal(e.coverage?.defaultBudgetsExecuted, true);
  assert.equal(e.coverage?.allSupportedDirectorySizesAndRefundCursors, true);
  assert.deepEqual([...e.coverage.actions].sort(), [...REQUIRED].sort());
  assert.ok(Array.isArray(e.measurements) && e.measurements.length > 0, 'Missing VM measurements');
  const found = new Set(), covered = new Set();
  // Reachable directory/cursor matrix, not just a caller-provided 'complete' boolean.
  const requiredCases = new Set(['GENESIS', 'CLOSE_EMPTY:0:0']);
  for (let pc = 0; pc < 256; pc++) requiredCases.add(`BUY:${pc}:0`);
  for (let pc = 1; pc <= 256; pc++) {
    for (const action of ['CLOSE_SEALED', 'CLOSE_REFUNDING', 'DRAW_AND_PAY', 'TIMEOUT_REFUND']) requiredCases.add(`${action}:${pc}:0`);
    for (let cursor = 0; cursor < pc; cursor += 32) requiredCases.add(`REFUND_${pc - cursor <= 32 ? 'FINAL' : 'INTERMEDIATE'}:${pc}:${cursor}`);
  }
  for (const m of e.measurements) {
    assert.ok(REQUIRED.includes(m.path)); found.add(m.path);
    assert.equal(m.passed, true);
    assert.match(m.evidenceSha256 ?? '', /^[0-9a-f]{64}$/);
    assert.match(m.evidenceFile ?? '', /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
    assert.equal(sha256(await fs.readFile(path.join(contract, 'artifacts/budget', m.evidenceFile))), m.evidenceSha256, 'Missing/changed measurement log');
    assert.ok(Number.isSafeInteger(m.usedScriptUnits) && m.usedScriptUnits >= 0);
    const action = m.path.startsWith('CLOSE_') ? 'CLOSE' : m.path.startsWith('REFUND_') ? 'REFUND' : m.path;
    if (action === 'GENESIS') { assert.equal(m.budget, actionBudget('GENESIS')); covered.add('GENESIS'); }
    else {
      const s = m.ledger;
      assert.ok(s && Number.isInteger(s.purchaseCount) && s.purchaseCount >= 0 && s.purchaseCount <= 256);
      assert.ok(Number.isInteger(s.cursor) && s.cursor >= 0 && s.cursor <= s.purchaseCount);
      assert.ok(Number.isInteger(s.sold) && s.sold >= s.purchaseCount && s.sold <= 100000);
      assert.ok(Number.isInteger(s.config?.minTickets) && s.config.minTickets >= 3 && s.config.minTickets <= 100000);
      if (m.path === 'CLOSE_EMPTY') assert.ok(s.sold === 0 && s.purchaseCount === 0);
      if (['CLOSE_SEALED', 'DRAW_AND_PAY', 'TIMEOUT_REFUND'].includes(m.path)) assert.ok(s.sold >= s.config.minTickets);
      if (m.path === 'CLOSE_REFUNDING') assert.ok(s.sold > 0 && s.sold < s.config.minTickets);
      if (action === 'REFUND') {
        assert.ok(s.cursor < s.purchaseCount && s.cursor % 32 === 0);
        assert.equal(m.path, s.purchaseCount - s.cursor <= 32 ? 'REFUND_FINAL' : 'REFUND_INTERMEDIATE');
      } else assert.equal(s.cursor, 0);
      covered.add(`${m.path}:${s.purchaseCount}:${s.cursor}`);
      assert.equal(m.budget, actionBudget(action, s));
      assert.ok(m.usedScriptUnits <= actionUnits(action, s), 'Measurement exceeds provisional envelope');
    }
    assert.ok(m.usedScriptUnits <= 9999 + m.budget * 10000, 'Default committed budget is insufficient');
  }
  assert.deepEqual([...found].sort(), [...REQUIRED].sort());
  assert.deepEqual([...requiredCases].filter(k => !covered.has(k)), [], 'Missing directory/refund-cursor measurements');
  // This is an auditable receipt gate, not cryptographic proof that somebody ran those measurements.
  return e;
}
