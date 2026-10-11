import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { project, artifacts } from './helpers.mjs';
import { runOracle, classifyOracle, assessTrial, summarize } from '../scripts/benchmark-results.mjs';

// Protocol failures cannot all be produced by a pinned, healthy Vitest binary.
test('oracle rejects missing, contradictory, skipped and interrupted evidence instead of inventing a defect', () => {
  const report = { success: false, numPassedTests: 0, numFailedTests: 1, numTotalTests: 1, numPendingTests: 0, numTodoTests: 0, testResults: [{ status: 'failed', assertionResults: [{ fullName: 'contract', status: 'failed', failureMessages: ['AssertionError: expected 0 to be 1'] }] }] };
  assert.equal(classifyOracle({ code: 1 }, report).state, 'defect');
  for (const [process, data] of [[{ code: 1 }, null], [{ code: 0 }, report], [{ code: 1, failure: 'timeout' }, report], [{ code: 1 }, { ...report, numFailedTests: 2 }], [{ code: 1 }, { ...report, testResults: [] }]]) {
    assert.equal(classifyOracle(process, data).state, 'incomplete');
  }
});

test('oracle distinguishes real assertions from collection, runtime, skipped and timeout failures', { timeout: 20000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'prooflane-oracle-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await symlink(join(project, 'node_modules'), join(root, 'node_modules'), 'junction');
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  const cases = [
    ['healthy', "test('contract',()=>expect(1).toBe(1));", 'pass'],
    ['broken', "test('contract',()=>expect(0).toBe(1));", 'defect'],
    ['runtime', "test('contract',()=>{throw new Error('infrastructure unavailable')});", 'incomplete'],
    ['collection', "import './missing.ts'; test('contract',()=>expect(1).toBe(1));", 'incomplete'],
    ['skipped', "test.skip('contract',()=>expect(0).toBe(1));", 'incomplete'],
    ['timeout', "test('contract',async()=>{await new Promise(()=>{})});", 'incomplete'],
  ];
  for (const [name, body, expected] of cases) {
    const result = await runOracle(root, `import {test,expect} from 'vitest'; ${body}`, join(artifacts, 'benchmark-oracle', name), name === 'timeout' ? 2000 : 10000);
    assert.equal(result.state, expected, name + ': ' + JSON.stringify(result));
    assert.ok(JSON.parse(await readFile(join(artifacts, 'benchmark-oracle', name, 'execution.json'), 'utf8')));
  }
});

test('benchmark rates keep failed runs in denominators but exclude unknown oracle truth', () => {
  const trial = { phase: 'verification-only', oracle: { state: 'defect' }, verdict: 'pass', agentComplete: true, outOfScopeEdits: [] };
  assert.equal(assessTrial(trial).verificationEscape, true);
  assert.equal(assessTrial({ ...trial, oracle: { state: 'incomplete' } }).verificationEscape, null);
  assert.equal(assessTrial({ ...trial, agentComplete: false }).verificationEscape, null);
  assert.equal(assessTrial({ ...trial, oracle: { state: 'pass' }, verdict: 'block' }).falseBlock, true);
  assert.equal(assessTrial({ ...trial, verdict: 'block', outOfScopeEdits: ['source.ts'] }).taskSuccess, false);
  const rows = [
    { ...trial, arm: 'control', task: 't', repetition: 1, ...assessTrial(trial), usage: { input_tokens: 100, output_tokens: 10, cached_input_tokens: 50 }, agentMs: 20 },
    { ...trial, arm: 'harness', task: 't', repetition: 1, agentComplete: false, ...assessTrial({ ...trial, agentComplete: false }), usage: null, agentMs: 30 },
  ];
  const report = summarize(rows);
  assert.deepEqual(report.arms.harness.success, { numerator: 0, denominator: 1, rate: 0 });
  assert.equal(report.arms.harness.tokens.count, 0);
  assert.equal(report.pairedTokens.count, 0);
  assert.equal(report.arms.control.escape.numerator, 1);
});
