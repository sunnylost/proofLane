import assert from 'node:assert/strict';
import { mkdir, symlink, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { repository, verify, put, git, project } from './helpers.mjs';

test('workspace-local tool is found without falling back outside the Git root', async (t) => {
  const root = await repository(t, { tool: 'missing' });
  const workspace = join(root, 'packages/app');
  await mkdir(join(workspace, 'node_modules'), { recursive: true });
  await symlink(join(project, 'node_modules/oxlint'), join(workspace, 'node_modules/oxlint'), 'junction');
  const result = await verify(workspace, 'workspace-tool', 'full');
  assert.equal(result.outcome, 'block');
  assert.equal(result.analyzers[0].version, '1.87.0');
  assert.equal((await verify(root, 'workspace-no-implicit-search', 'full')).outcome, 'incomplete');
});

test('internal source symlinks are verified; external source symlinks are rejected', async (t) => {
  const root = await repository(t);
  const outside = await repository(t);
  try { await symlink('src/history.ts', join(root, 'alias.ts'), 'file'); }
  catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') { t.skip('Runner lacks file symlink privilege'); return; } throw error; }
  const internal = await verify(root, 'internal-symlink', 'full');
  assert.equal(internal.outcome, 'block');
  await rm(join(root, 'alias.ts'));
  await symlink(join(outside, 'src/history.ts'), join(root, 'alias.ts'), 'file');
  assert.equal((await verify(root, 'external-symlink', 'full')).outcome, 'incomplete');
});

test('initialized submodule content participates in verification and dirty detection', async (t) => {
  const root = await repository(t);
  const module = await repository(t);
  git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', module, 'vendor/module');
  git(root, 'add', '.'); git(root, 'commit', '-m', 'add submodule');
  const full = await verify(root, 'submodule-full', 'full');
  assert.equal(full.outcome, 'block');
  assert.ok(full.findings.some((f) => f.location.file === 'vendor/module/src/history.ts'));
  await put(root, 'vendor/module/src/main.ts', 'debugger;\n');
  const dirty = await verify(root, 'submodule-dirty');
  assert.equal(dirty.scope, 'project');
  assert.ok(dirty.findings.some((f) => f.location.file === 'vendor/module/src/main.ts'));
  git(root, 'submodule', 'deinit', '--force', 'vendor/module');
  assert.equal((await verify(root, 'submodule-uninitialized', 'full')).outcome, 'incomplete');
});

test('large working tree verification retains deterministic identities and bounded resources', { timeout: 30000 }, async (t) => {
  const root = await repository(t);
  await mkdir(join(root, 'many'));
  for (let i = 0; i < 1000; i++) await writeFile(join(root, 'many', `file-${i}.ts`), `export const value = ${i};\n`);
  const first = await verify(root, 'large-tree-first', 'full');
  const second = await verify(root, 'large-tree-second', 'full');
  assert.equal(first.outcome, 'block');
  assert.equal(first.analyzers[0].filesChecked, 1002);
  assert.equal(first.snapshot, second.snapshot);
  assert.deepEqual(first.findings.map((f) => f.fingerprint), second.findings.map((f) => f.fingerprint));
});
