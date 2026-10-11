import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { repository, put, verify, cli, artifacts, git } from './helpers.mjs';

async function baseline(root, action, label) {
  const run = spawnSync(process.execPath, [cli, 'baseline', action, '--root', root, '--json'], { encoding: 'utf8', timeout: 15000 });
  await writeFile(join(artifacts, `${label}.json`), run.stdout);
  assert.equal(run.error, undefined);
  return { code: run.status, result: JSON.parse(run.stdout) };
}

test('baseline preserves historical errors across line shifts and detects added duplicate errors', async (t) => {
  const root = await repository(t);
  const created = await baseline(root, 'create', 'baseline-created');
  assert.equal(created.code, 0);
  await put(root, 'src/history.ts', '\n\ndebugger;\n');
  const existing = await verify(root, 'baseline-shift');
  assert.equal(existing.outcome, 'pass');
  assert.equal(existing.findings[0].status, 'existing');
  await put(root, 'src/history.ts', '\n\ndebugger;\ndebugger;\n');
  const added = await verify(root, 'baseline-duplicate');
  assert.equal(added.outcome, 'block');
  assert.deepEqual(added.findings.map((f) => f.status).sort(), ['existing', 'new']);
  assert.equal(new Set(added.findings.map((f) => f.fingerprint)).size, 2);
  assert.equal((await baseline(root, 'create', 'baseline-refuse-overwrite')).code, 2);
});

test('partial scan never resolves an unchecked historical finding; update records real fix and detects recurrence', async (t) => {
  const root = await repository(t);
  assert.equal((await baseline(root, 'create', 'history-baseline')).code, 0);
  await put(root, 'src/main.ts', 'export const value = 2;\n');
  const partial = await verify(root, 'partial-baseline');
  assert.deepEqual(partial.resolved, []);
  assert.deepEqual(partial.analyzers[0].coverage.checked, ['src/main.ts']);
  await put(root, 'src/history.ts', 'export {};\n');
  const updated = await baseline(root, 'update', 'baseline-fixed');
  assert.equal(updated.code, 0);
  assert.equal(updated.result.resolved.length, 1);
  await put(root, 'src/history.ts', 'debugger;\n');
  const regression = await verify(root, 'baseline-regression');
  assert.equal(regression.outcome, 'block');
  assert.equal(regression.findings[0].status, 'regression');
});

test('ignore changes and invalid baseline cannot silently suppress findings', async (t) => {
  const root = await repository(t);
  assert.equal((await baseline(root, 'create', 'ignore-baseline')).code, 0);
  await put(root, '.oxlintrc.json', '{"rules":{"no-debugger":"error"},"ignorePatterns":["src/history.ts"]}');
  const incompatible = await verify(root, 'incompatible-baseline', 'full');
  assert.equal(incompatible.outcome, 'incomplete');
  assert.match(incompatible.errors.join(' '), /incompatible/i);
  assert.equal((await baseline(root, 'reset', 'reset-baseline')).code, 0);
  await put(root, '.prooflane/baseline.json', '{"schemaVersion":1,"entries":"wrong"}');
  assert.equal((await verify(root, 'corrupt-baseline', 'full')).outcome, 'incomplete');
});

test('covered and excluded files are distinguished; fingerprint is stable across committed checkout paths', async (t) => {
  const root = await repository(t);
  await put(root, '.oxlintrc.json', '{"rules":{"no-debugger":"error"},"ignorePatterns":["excluded.ts"]}');
  await put(root, 'excluded.ts', 'debugger;\n');
  git(root, 'add', '.'); git(root, 'commit', '-m', 'ignore fixture');
  const result = await verify(root, 'coverage-files', 'full');
  assert.equal(result.analyzers[0].coverage.complete, true);
  assert.ok(result.analyzers[0].coverage.excluded.includes('excluded.ts'));
  assert.ok(!result.analyzers[0].coverage.checked.includes('excluded.ts'));
  const other = await repository(t);
  const second = await verify(other, 'fingerprint-other-root', 'full');
  assert.equal(result.findings[0].fingerprint, second.findings[0].fingerprint);
});

test('baseline writer lock rejects concurrent update without altering the accepted baseline', async (t) => {
  const root = await repository(t);
  assert.equal((await baseline(root, 'create', 'lock-baseline')).code, 0);
  const path = join(root, '.prooflane/baseline.json');
  const before = await readFile(path, 'utf8');
  await put(root, '.prooflane/baseline.lock', 'another writer');
  assert.equal((await baseline(root, 'update', 'locked-baseline')).code, 2);
  assert.equal(await readFile(path, 'utf8'), before);
});

test('deleting a previously diagnosed file is resolved only by complete project coverage', async (t) => {
  const root = await repository(t);
  assert.equal((await baseline(root, 'create', 'deleted-file-baseline')).code, 0);
  await rm(join(root, 'src/history.ts'));
  const result = await verify(root, 'deleted-file-resolved');
  assert.equal(result.outcome, 'pass');
  assert.equal(result.resolved.length, 1);
});

test('ordinary verification records confirmed fixes without accepting new findings', async (t) => {
  const root = await repository(t);
  assert.equal((await baseline(root, 'create', 'observed-fix-baseline')).code, 0);
  const accepted = await readFile(join(root, '.prooflane/baseline.json'), 'utf8');
  await put(root, 'src/history.ts', 'export {};\n');
  const fixed = await verify(root, 'observed-fixed', 'full');
  assert.equal(fixed.resolved.length, 1);
  assert.equal(await readFile(join(root, '.prooflane/baseline.json'), 'utf8'), accepted);
  await put(root, 'src/history.ts', 'debugger;\n');
  const returned = await verify(root, 'observed-regression');
  assert.equal(returned.outcome, 'block');
  assert.equal(returned.findings[0].status, 'regression');
});

test('ignored root analyzer configuration still invalidates the baseline', async (t) => {
  const root = await repository(t);
  await put(root, '.gitignore', 'node_modules/\n.oxlintrc.json\n');
  git(root, 'rm', '--cached', '.oxlintrc.json');
  assert.equal((await baseline(root, 'create', 'ignored-config-baseline')).code, 0);
  await put(root, '.oxlintrc.json', '{"rules":{"no-debugger":"off"}}');
  const result = await verify(root, 'ignored-config-changed', 'full');
  assert.equal(result.outcome, 'incomplete');
  assert.match(result.errors.join(' '), /incompatible/);
});
