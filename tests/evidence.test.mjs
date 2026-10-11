import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { repository, verify, cli, artifacts } from './helpers.mjs';

test('explain retrieves persisted original evidence and rejects traversal and unknown finding IDs', async (t) => {
  const root = await repository(t);
  const result = await verify(root, 'evidence-run', 'full');
  assert.match(result.runId, /^[a-f0-9-]{36}$/);
  assert.equal(result.analyzers[0].evidence, undefined);
  const explain = spawnSync(process.execPath, [cli, 'explain', result.runId, result.findings[0].id, '--root', root, '--json'], { encoding: 'utf8' });
  await writeFile(join(artifacts, 'explained.json'), explain.stdout);
  assert.equal(explain.status, 0);
  const evidence = JSON.parse(explain.stdout);
  assert.equal(evidence.finding.rule, 'eslint(no-debugger)');
  assert.match(evidence.evidence.stdout, /debugger/);
  for (const [runId, findingId] of [['../../package', 'unknown'], [result.runId, 'unknown']]) {
    const denied = spawnSync(process.execPath, [cli, 'explain', runId, findingId, '--root', root, '--json'], { encoding: 'utf8' });
    assert.equal(denied.status, 2);
  }
});

test('evidence directory symlink cannot write outside repository', async (t) => {
  const root = await repository(t);
  const outside = await repository(t);
  await mkdir(join(root, '.prooflane'), { recursive: true });
  await symlink(outside, join(root, '.prooflane/runs'), 'junction');
  const result = await verify(root, 'evidence-symlink', 'full');
  assert.equal(result.outcome, 'incomplete');
  assert.ok(!(await readdir(outside)).some((name) => /^[a-f0-9-]{36}\.json$/.test(name)));
});
