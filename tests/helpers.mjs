import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const project = fileURLToPath(new URL('../', import.meta.url));
export const cli = join(project, 'dist/cli.js');
export const artifacts = join(project, 'artifacts/e2e');
await mkdir(artifacts, { recursive: true });

export function git(root, ...args) {
  const result = spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${join(root, 'no-hooks')}`, ...args], {
    cwd: root, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'ProofLane Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'ProofLane Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

export async function put(root, file, content) {
  await mkdir(dirname(join(root, file)), { recursive: true });
  await writeFile(join(root, file), content);
}

export async function repository(t, { tool = 'real', commit = true, cleanup = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'prooflane-e2e-'));
  if (cleanup) t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  await put(root, '.gitignore', 'node_modules/\nignored.ts\n');
  await put(root, 'package.json', '{"private":true}');
  await put(root, '.oxlintrc.json', JSON.stringify({ rules: { 'no-debugger': 'error' } }));
  await put(root, 'src/main.ts', 'export const value = 1;\n');
  await put(root, 'src/history.ts', 'debugger;\n');
  if (tool === 'real') {
    await mkdir(join(root, 'node_modules'), { recursive: true });
    await symlink(join(project, 'node_modules/oxlint'), join(root, 'node_modules/oxlint'), 'junction');
  } else if (tool !== 'missing') {
    await put(root, 'node_modules/oxlint/package.json', JSON.stringify({ version: '1.87.0', bin: { oxlint: 'cli.cjs' } }));
    await put(root, 'node_modules/oxlint/cli.cjs', tool);
  }
  if (commit) {
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'fixture');
  }
  return root;
}

export async function verify(root, label, profile = 'changed', flags = []) {
  const started = performance.now();
  const run = spawnSync(process.execPath, [cli, 'verify', profile, '--root', root, '--json', ...flags], { encoding: 'utf8', timeout: 15_000, maxBuffer: 20 * 1024 * 1024 });
  await writeFile(join(artifacts, `${label}.json`), JSON.stringify({ exitCode: run.status, durationMs: Math.round(performance.now() - started), node: process.version, platform: process.platform, stdout: run.stdout, stderr: run.stderr, error: run.error?.message }, null, 2));
  assert.equal(run.error, undefined);
  assert.equal(run.stderr, '');
  const result = JSON.parse(run.stdout);
  assert.equal(run.status, { pass: 0, block: 1, incomplete: 2 }[result.outcome]);
  return result;
}

