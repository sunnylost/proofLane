import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
if (!process.argv[2]) throw new Error('Usage: npm run verify:project -- <existing Git repository with local Oxlint>');
const source = resolve(process.argv[2]);
const artifacts = join(project, 'artifacts/project');
const temporary = await mkdtemp(join(tmpdir(), 'prooflane-project-'));
const root = join(temporary, 'checkout');
await mkdir(artifacts, { recursive: true });

function command(executable, args, cwd) {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8', timeout: 120_000, maxBuffer: 20 * 1024 * 1024 });
  assert.equal(result.error, undefined);
  return result;
}

function git(cwd, ...args) {
  const result = command('git', args, cwd);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

async function verify(label, profile) {
  const result = command(process.execPath, [join(project, 'dist/cli.js'), 'verify', profile, '--root', root, '--json'], project);
  await writeFile(join(artifacts, `${label}.json`), result.stdout);
  const parsed = JSON.parse(result.stdout);
  assert.equal(result.status, { pass: 0, block: 1, incomplete: 2 }[parsed.outcome]);
  return parsed;
}

const originalStatus = git(source, 'status', '--porcelain=v1', '-z');
const revision = git(source, 'rev-parse', 'HEAD').trim();
try {
  git(project, 'clone', '--quiet', '--no-hardlinks', '--', source, root);
  const installed = await realpath(join(source, 'node_modules/oxlint'));
  await mkdir(join(root, 'node_modules'), { recursive: true });
  await symlink(installed, join(root, 'node_modules/oxlint'), 'junction');
  const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin.oxlint;
  const direct = command(process.execPath, [join(installed, bin), '--format', 'json', '--', '.'], root);
  await writeFile(join(artifacts, 'direct-oxlint.json'), direct.stdout);
  const raw = JSON.parse(direct.stdout);
  assert.ok([0, 1].includes(direct.status));
  const full = await verify('full', 'full');
  assert.notEqual(full.outcome, 'incomplete', JSON.stringify(full.errors));
  const expected = raw.diagnostics.map((d) => JSON.stringify([d.filename, d.code ?? 'parse-error', d.severity, d.message])).sort();
  const actual = full.findings.map((f) => JSON.stringify([f.location.file, f.rule, f.severity, f.message])).sort();
  assert.deepEqual(actual, expected);
  assert.equal(full.analyzers[0].filesChecked, raw.number_of_files);
  const injected = join(root, 'prooflane-acceptance.ts');
  await writeFile(injected, 'const = ;\n');
  const blocked = await verify('injected-error', 'changed');
  assert.equal(blocked.outcome, 'block');
  assert.ok(blocked.findings.some((f) => f.location.file === 'prooflane-acceptance.ts' && f.severity === 'error'));
  await writeFile(injected, 'export {};\n');
  assert.equal((await verify('fixed', 'changed')).outcome, 'pass');
  assert.equal(git(source, 'status', '--porcelain=v1', '-z'), originalStatus);
  const summary = { source, revision, analyzerVersion: manifest.version, filesChecked: raw.number_of_files, findings: full.findings.length, directExitCode: direct.status, fullOutcome: full.outcome, injectedError: 'block', fixed: 'pass', sourceWorktreeUnchanged: true };
  await writeFile(join(artifacts, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
