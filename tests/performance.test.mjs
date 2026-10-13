import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { artifacts, git, project, put, repository } from './helpers.mjs';

test('performance runner measures CLI evidence without altering dirty source or overwriting prior results', { timeout: 60000 }, async (t) => {
  const root = await repository(t);
  await put(root, 'src/main.ts', 'export const uncommitted = 2;\n');
  const before = git(root, 'diff');
  const output = join(artifacts, `performance-${randomUUID()}`);
  const args = [join(project, 'scripts/benchmark-performance.mjs'), root, '--output-dir', output, '--repetitions', '2'];
  const run = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 55000 });
  assert.equal(run.error, undefined);
  const summary = JSON.parse(await readFile(join(output, 'summary.json'), 'utf8'));
  assert.equal(run.status, 0, JSON.stringify(summary));
  assert.equal(summary.completed, true);
  assert.equal(summary.sourceDirty, true);
  assert.equal(summary.sourceWorktreeUnchanged, true);
  assert.equal(git(root, 'diff'), before);
  assert.equal(summary.runs.find((run) => run.label === 'full-1').outcome, 'block');
  assert.equal(summary.runs.find((run) => run.label === 'changed-1').filesChecked, 1);
  assert.equal(summary.runs.find((run) => run.label === 'injected-error').outcome, 'block');
  assert.equal(summary.runs.find((run) => run.label === 'fixed').outcome, 'pass');
  for (const run of summary.runs) {
    assert.ok(run.wallMs > 0 && run.harnessMaxRssKiB > 0);
    const evidence = JSON.parse(await readFile(join(output, `${run.label}.evidence.json`), 'utf8'));
    assert.equal(evidence.outcome, run.outcome);
  }
  const saved = await readFile(join(output, 'summary.json'), 'utf8');
  assert.notEqual(spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 5000 }).status, 0);
  assert.equal(await readFile(join(output, 'summary.json'), 'utf8'), saved);
});
