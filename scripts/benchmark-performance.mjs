import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const project = fileURLToPath(new URL('../', import.meta.url));
const { values, positionals } = parseArgs({ allowPositionals: true, options: { 'output-dir': { type: 'string' }, repetitions: { type: 'string', default: '3' } } });
assert.equal(positionals.length, 1, 'Usage: npm run benchmark:performance -- <repository> --output-dir <new directory> [--repetitions 3]');
assert.ok(values['output-dir'], '--output-dir is required; existing results are never overwritten');
const repetitions = Number(values.repetitions);
assert.ok(Number.isSafeInteger(repetitions) && repetitions >= 2 && repetitions <= 20, 'repetitions must be 2..20');
const source = resolve(positionals[0]);
const output = resolve(values['output-dir']);
await mkdir(dirname(output), { recursive: true });
await mkdir(output);
const temporary = await mkdtemp(join(tmpdir(), 'prooflane-performance-'));
const root = join(temporary, 'checkout');
const summary = { schemaVersion: 1, completed: false, source, repetitions, machine: { node: process.version, platform: platform(), release: release(), arch: process.arch, cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem() }, runs: [] };

function command(executable, args, cwd, env = process.env) {
  const result = spawnSync(executable, args, { cwd, env, encoding: 'utf8', timeout: 180_000, maxBuffer: 32 * 1024 * 1024 });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
}

function git(cwd, ...args) {
  const result = command('git', ['-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${join(temporary, 'no-hooks')}`, ...args], cwd, { ...process.env, GIT_AUTHOR_NAME: 'ProofLane Benchmark', GIT_AUTHOR_EMAIL: 'benchmark@example.invalid', GIT_COMMITTER_NAME: 'ProofLane Benchmark', GIT_COMMITTER_EMAIL: 'benchmark@example.invalid' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function sourceState() {
  return createHash('sha256').update(git(source, 'status', '--porcelain=v1', '-z')).update(git(source, 'diff', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD')).digest('hex');
}

function diagnostics(items) {
  return items.map((item) => JSON.stringify([item.filename ?? item.location.file, item.code ?? item.rule ?? 'parse-error', item.severity, item.message])).sort();
}

async function measure(label, args) {
  const metrics = join(output, `${label}.resources.json`);
  const start = performance.now();
  const child = command(process.execPath, ['--import', new URL('measure-process.mjs', import.meta.url).href, join(project, 'dist/cli.js'), ...args, '--root', root, '--json'], project, { ...process.env, PROOFLANE_METRICS: metrics });
  const wallMs = Math.round(performance.now() - start);
  await writeFile(join(output, `${label}.json`), child.stdout);
  await writeFile(join(output, `${label}.stderr.txt`), child.stderr);
  assert.ok(child.stdout.trim(), `CLI emitted no JSON (exit ${child.status}): ${child.stderr.slice(0, 2000)}`);
  const result = JSON.parse(child.stdout);
  const resources = JSON.parse(await readFile(metrics, 'utf8'));
  const evidencePath = join(root, '.prooflane/runs', `${result.runId}.json`);
  const evidenceBytes = (await stat(evidencePath)).size;
  await cp(evidencePath, join(output, `${label}.evidence.json`));
  const record = { label, wallMs, harnessMaxRssKiB: resources.maxRSS, analyzerMs: result.analyzers.reduce((sum, analyzer) => sum + (analyzer.durationMs ?? 0), 0), evidenceBytes, outcome: result.outcome, scope: result.scope, filesChecked: result.analyzers[0]?.filesChecked ?? 0, findings: result.findings.length };
  summary.runs.push(record);
  console.log(JSON.stringify(record));
  assert.equal(child.status, { pass: 0, block: 1, incomplete: 2 }[result.outcome]);
  assert.notEqual(result.outcome, 'incomplete', JSON.stringify(result.errors));
  assert.ok(resources.maxRSS > 0, 'Process RSS measurement unavailable');
  return result;
}

async function series(name, profile) {
  const first = await measure(`${name}-1`, ['verify', profile]);
  for (let i = 2; i <= repetitions; i++) {
    const current = await measure(`${name}-${i}`, ['verify', profile]);
    assert.equal(current.snapshot, first.snapshot, 'Repeated input changed');
    assert.equal(current.outcome, first.outcome);
    assert.deepEqual(current.findings, first.findings);
  }
  return first;
}

let originalStatus;
try {
  originalStatus = git(source, 'status', '--porcelain=v1', '-z');
  summary.sourceStateSha256 = sourceState();
  summary.sourceRevision = git(source, 'rev-parse', 'HEAD').trim();
  summary.harnessRevision = git(project, 'rev-parse', 'HEAD').trim();
  const code = createHash('sha256');
  for (const file of (await readdir(join(project, 'dist'))).filter((file) => file.endsWith('.js')).sort()) code.update(file).update('\0').update(await readFile(join(project, 'dist', file)));
  summary.harnessDistSha256 = code.digest('hex');
  summary.benchmarkSha256 = createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).update(await readFile(new URL('measure-process.mjs', import.meta.url))).digest('hex');
  summary.sourceDirty = Boolean(originalStatus);
  git(project, 'clone', '--quiet', '--shared', '--', source, root);
  assert.equal(git(root, 'rev-parse', 'HEAD').trim(), summary.sourceRevision);
  const files = git(root, 'ls-files', '-z').split('\0').filter(Boolean);
  const sizes = await Promise.all(files.map(async (file) => (await stat(join(root, file))).size));
  summary.input = { trackedFiles: files.length, sourceFiles: files.filter((file) => /\.(?:[cm]?[jt]s|[jt]sx)$/.test(file)).length, trackedBytes: sizes.reduce((sum, size) => sum + size, 0) };
  assert.ok(!files.some((file) => file.startsWith('.prooflane/')), 'Use a HEAD without pre-existing ProofLane state');
  await mkdir(join(root, 'node_modules'), { recursive: true });
  await symlink(join(project, 'node_modules/oxlint'), join(root, 'node_modules/oxlint'), 'junction');
  const manifest = JSON.parse(await readFile(join(project, 'node_modules/oxlint/package.json'), 'utf8'));
  summary.analyzerVersion = manifest.version;
  summary.overrides = { 'prooflane.json': { analyzers: ['oxlint'] }, installedTool: 'ProofLane development Oxlint; original analyzer rules retained' };
  await writeFile(join(root, 'prooflane.json'), JSON.stringify(summary.overrides['prooflane.json']));
  await writeFile(join(root, '.git/info/exclude'), '\nnode_modules/\n');
  git(root, 'add', '--force', 'prooflane.json');
  git(root, 'commit', '--quiet', '-m', 'Select benchmark analyzer');
  summary.fixtureRevision = git(root, 'rev-parse', 'HEAD').trim();
  const full = await series('full', 'full');
  assert.equal(full.scope, 'project');
  assert.equal(full.analyzers[0].coverage.complete, true);
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin.oxlint;
  const start = performance.now();
  const direct = command(process.execPath, [join(project, 'node_modules/oxlint', bin), '--format', 'json', '--', '.'], root);
  summary.directOxlintMs = Math.round(performance.now() - start);
  await writeFile(join(output, 'direct-oxlint.json'), direct.stdout);
  assert.ok([0, 1].includes(direct.status), direct.stderr);
  const raw = JSON.parse(direct.stdout);
  assert.deepEqual(diagnostics(full.findings), diagnostics(raw.diagnostics));
  assert.equal(full.analyzers[0].filesChecked, raw.number_of_files);
  assert.equal((await measure('baseline-create', ['baseline', 'create'])).outcome, 'pass');
  git(root, 'add', '--force', '.prooflane/baseline.json');
  git(root, 'commit', '--quiet', '-m', 'Accept benchmark baseline explicitly');
  assert.equal((await series('baseline-full', 'full')).outcome, 'pass');
  const clean = await series('unchanged', 'changed');
  assert.equal(clean.scope, 'none');
  assert.equal(clean.outcome, 'pass');
  const file = full.analyzers[0].coverage.checked.find((file) => /\.[cm]?ts$/.test(file) && !file.endsWith('.d.ts'));
  assert.ok(file, 'An analyzed TypeScript source is required for the mutation control');
  const path = join(root, file);
  const original = await readFile(path, 'utf8');
  summary.mutation = { file, originalSha256: createHash('sha256').update(original).digest('hex'), edit: 'append newline, then append invalid TypeScript, then remove invalid text' };
  await writeFile(path, `${original}\n`);
  const changed = await series('changed', 'changed');
  assert.equal(changed.scope, 'files');
  assert.equal(changed.analyzers[0].filesChecked, 1);
  assert.equal(changed.outcome, 'pass');
  await writeFile(path, `${original}\nconst = ;\n`);
  const broken = await measure('injected-error', ['verify', 'changed']);
  assert.equal(broken.outcome, 'block');
  assert.ok(broken.findings.some((item) => item.location.file === file && item.severity === 'error' && item.status === 'new'));
  assert.deepEqual(broken.resolved, [], 'A parse failure cannot prove historical findings were fixed');
  await writeFile(path, `${original}\n`);
  assert.equal((await measure('fixed', ['verify', 'changed'])).outcome, 'pass');
  const records = await readdir(join(root, '.prooflane/runs'));
  const retained = await Promise.all(records.map(async (file) => (await stat(join(root, '.prooflane/runs', file))).size));
  summary.retention = { records: records.length, bytes: retained.reduce((sum, size) => sum + size, 0) };
  assert.ok(records.length > 0 && records.length <= 20 && summary.retention.bytes <= 64 * 1024 * 1024);
  if (summary.runs.reduce((sum, run) => sum + run.evidenceBytes, 0) <= 64 * 1024 * 1024) assert.equal(records.length, Math.min(summary.runs.length, 20));
  summary.completed = true;
} catch (error) {
  summary.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  try {
    summary.sourceWorktreeUnchanged = originalStatus !== undefined && sourceState() === summary.sourceStateSha256 && git(source, 'rev-parse', 'HEAD').trim() === summary.sourceRevision;
    assert.ok(summary.sourceWorktreeUnchanged, 'Source repository changed during measurement');
  } catch (error) { summary.completed = false; summary.error = String(error); process.exitCode = 1; }
  await writeFile(join(output, 'summary.json'), JSON.stringify(summary, null, 2));
  await rm(temporary, { recursive: true, force: true });
}
console.log(JSON.stringify({ output, completed: summary.completed, error: summary.error }));
