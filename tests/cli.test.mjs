import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { git, put, repository, verify, cli, artifacts } from './helpers.mjs';

test('changed verifies staged, unstaged and untracked files; fix passes; full still finds historical error', async (t) => {
  const root = await repository(t);
  await put(root, 'src/main.ts', 'debugger;\n');
  await put(root, 'staged.ts', 'debugger;\n');
  git(root, 'add', 'staged.ts');
  const special = process.platform === 'win32' ? '- odd name 中文.ts' : '- odd name 中文\nfile.ts';
  await put(root, special, 'debugger;\n');
  await put(root, 'ignored.ts', 'debugger;\n');
  const blocked = await verify(root, 'changed-errors');
  assert.equal(blocked.outcome, 'block');
  assert.equal(blocked.analyzers[0].status, 'completed');
  assert.deepEqual(blocked.findings.map((f) => f.location.file).sort(), [special, 'src/main.ts', 'staged.ts'].sort());
  assert.ok(blocked.findings.every((f) => f.rule === 'eslint(no-debugger)' && f.severity === 'error' && f.status === 'unclassified'));
  for (const file of [special, 'src/main.ts', 'staged.ts']) await put(root, file, 'export {};\n');
  assert.equal((await verify(root, 'changed-fixed')).outcome, 'pass');
  const full = await verify(root, 'full-history', 'full');
  assert.equal(full.outcome, 'block');
  assert.deepEqual(full.findings.map((f) => f.location.file), ['src/history.ts']);
});

test('unborn repository and explicit base include the expected files', async (t) => {
  const root = await repository(t, { commit: false });
  git(root, 'add', 'src/main.ts');
  assert.equal((await verify(root, 'unborn')).outcome, 'block');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'base');
  const base = git(root, 'rev-parse', 'HEAD');
  await put(root, 'src/main.ts', 'debugger;\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'change');
  assert.equal((await verify(root, 'no-local-changes')).analyzers[0].status, 'skipped');
  const result = await verify(root, 'explicit-base', 'changed', ['--base', base]);
  assert.deepEqual(result.findings.map((f) => f.location.file), ['src/main.ts']);
  assert.equal((await verify(root, 'invalid-base', 'changed', ['--base', '--help'])).outcome, 'incomplete');
});

for (const change of ['config', 'delete', 'rename']) {
  test(`${change} expands lint scope to the project`, async (t) => {
    const root = await repository(t);
    if (change === 'config') await put(root, '.oxlintrc.json', '{"rules":{"no-debugger":"error"},"plugins":[]}');
    if (change === 'delete') await rm(join(root, 'src/main.ts'));
    if (change === 'rename') git(root, 'mv', 'src/main.ts', 'src/renamed.ts');
    const result = await verify(root, `expanded-${change}`);
    assert.equal(result.scope, 'project');
    assert.equal(result.outcome, 'block');
    assert.ok(result.findings.some((f) => f.location.file === 'src/history.ts'));
  });
}

test('docs-only change skips lint with an explicit reason even when tool is absent', async (t) => {
  const root = await repository(t, { tool: 'missing' });
  await put(root, 'README.md', '# Docs\n');
  const result = await verify(root, 'docs-only');
  assert.equal(result.outcome, 'pass');
  assert.equal(result.analyzers[0].status, 'skipped');
  assert.ok(result.analyzers[0].reason);
});

test('real tool warning passes, syntax error blocks, invalid config is incomplete', async (t) => {
  const root = await repository(t);
  await put(root, '.oxlintrc.json', '{"rules":{"no-debugger":"warn"}}');
  const warning = await verify(root, 'warning', 'full');
  assert.equal(warning.outcome, 'pass');
  assert.equal(warning.findings[0].severity, 'warning');
  await put(root, 'src/main.ts', 'const = ;');
  const syntax = await verify(root, 'syntax', 'full');
  assert.equal(syntax.outcome, 'block');
  assert.ok(syntax.findings.some((f) => f.rule === 'parse-error'));
  await put(root, '.oxlintrc.json', '{ invalid');
  assert.equal((await verify(root, 'invalid-config', 'full')).outcome, 'incomplete');
});

const empty = JSON.stringify({ diagnostics: [], number_of_files: 2 });
const errorReport = JSON.stringify({ diagnostics: [{ message: 'Example lint error', code: 'example/rule', severity: 'error', filename: 'src/main.ts', labels: [] }], number_of_files: 1 });
for (const [name, tool] of [
  ['missing', 'missing'],
  ['malformed-json', 'console.log("not json")'],
  ['malformed-diagnostic', 'console.log(JSON.stringify({diagnostics:[{severity:"unknown"}],number_of_files:1}))'],
  ['unexpected-exit', `console.log(${JSON.stringify(empty)}); process.exitCode=1`],
  ['unexpected-exit-with-diagnostic', `console.log(${JSON.stringify(errorReport)}); process.exitCode=2`],
  ['zero-files', 'console.log(JSON.stringify({diagnostics:[],number_of_files:0}))'],
  ['output-limit', 'process.stdout.write("x".repeat(9*1024*1024))'],
  ['timeout', 'setInterval(()=>{},1000)'],
  ['mutation', `require('node:fs').writeFileSync('src/main.ts','debugger;'); console.log(${JSON.stringify(empty)})`],
]) {
  test(`${name} cannot report a pass`, async (t) => {
    const root = await repository(t, { tool });
    const result = await verify(root, `failure-${name}`, 'full', name === 'timeout' ? ['--timeout-ms', '100'] : []);
    assert.equal(result.outcome, 'incomplete');
    assert.ok(result.errors.length > 0);
    if (name === 'unexpected-exit-with-diagnostic') assert.equal(result.findings[0]?.rule, 'example/rule');
  });
}

test('timeout terminates descendant processes', async (t) => {
  const marker = join(await mkdtemp(join(tmpdir(), 'prooflane-process-')), 'escaped');
  t.after(() => rm(dirname(marker), { recursive: true, force: true }));
  const tool = `const child = require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'escaped'),1500)`)}],{stdio:'ignore'}); require('node:fs').writeFileSync(${JSON.stringify(`${marker}.pid`)},String(child.pid)); setInterval(()=>{},1000)`;
  const root = await repository(t, { tool });
  assert.equal((await verify(root, 'descendant-timeout', 'full', ['--timeout-ms', '600'])).outcome, 'incomplete');
  assert.match(await readFile(`${marker}.pid`, 'utf8'), /^\d+$/);
  await new Promise((done) => setTimeout(done, 1600));
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('SIGINT returns an incomplete JSON result and stops the analyzer', { skip: process.platform === 'win32' }, async (t) => {
  const root = await repository(t, { tool: "require('node:fs').writeFileSync('node_modules/ready','ready'); setInterval(()=>{},1000)" });
  const child = spawn(process.execPath, [cli, 'verify', 'full', '--root', root, '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  const exit = new Promise((done) => child.on('close', (code) => done(code)));
  t.after(() => child.kill('SIGKILL'));
  for (let i = 0; i < 100; i++) {
    try { await readFile(join(root, 'node_modules/ready')); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise((done) => setTimeout(done, 25));
  }
  assert.equal(await readFile(join(root, 'node_modules/ready'), 'utf8'), 'ready');
  child.kill('SIGINT');
  assert.equal(await exit, 2);
  await writeFile(join(artifacts, 'cancelled.json'), stdout);
  assert.equal(JSON.parse(stdout).outcome, 'incomplete');
  assert.match(JSON.parse(stdout).errors.join(' '), /cancelled/);
});

test('invalid CLI arguments and non-repository roots return structured incomplete results', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'prooflane-invalid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal((await verify(root, 'not-repository', 'full')).outcome, 'incomplete');
  assert.equal((await verify(root, 'invalid-timeout', 'full', ['--timeout-ms', '0'])).outcome, 'incomplete');
  const result = spawnSync(process.execPath, [cli, 'verify', 'full', '--json', '--unknown'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stdout).outcome, 'incomplete');
});

test('compact output is bounded and reports the remaining count', async (t) => {
  const root = await repository(t);
  await put(root, 'src/main.ts', 'debugger;\n'.repeat(30));
  const run = spawnSync(process.execPath, [cli, 'verify', 'changed', '--root', root], { encoding: 'utf8' });
  await writeFile(join(artifacts, 'compact.txt'), run.stdout);
  assert.equal(run.status, 1);
  assert.match(run.stdout, /10 more/);
  assert.ok(run.stdout.split('\n').length < 30);
});
