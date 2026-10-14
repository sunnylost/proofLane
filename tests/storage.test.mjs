import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { repository, verify, put, cli, artifacts, project } from './helpers.mjs';

function invoke(root, ...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args, '--root', root, '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      try {
        assert.equal(stderr, '');
        const result = JSON.parse(stdout);
        assert.equal(code, { pass: 0, block: 1, incomplete: 2 }[result.outcome]);
        resolve(result);
      } catch (error) { reject(error); }
    });
  });
}

test('evidence retention enforces the 64 MiB budget and preserves the newest explainable run', async (t) => {
  const root = await repository(t);
  const first = await verify(root, 'retention-seed', 'full');
  const directory = join(root, '.prooflane/runs');
  const template = JSON.parse(await readFile(join(directory, `${first.runId}.json`), 'utf8'));
  const older = [];
  for (let i = 0; i < 5; i++) {
    const runId = randomUUID();
    const path = join(directory, `${runId}.json`);
    await writeFile(path, JSON.stringify({ ...template, runId, retentionPadding: 'x'.repeat(13 * 1024 * 1024) }));
    const time = new Date(Date.now() - 60000 + i * 1000);
    await utimes(path, time, time);
    older.push(runId);
  }
  const current = await verify(root, 'retention-trigger', 'full');
  const files = await readdir(directory);
  const bytes = (await Promise.all(files.map(async (file) => (await stat(join(directory, file))).size))).reduce((sum, size) => sum + size, 0);
  assert.ok(bytes <= 64 * 1024 * 1024);
  assert.ok(!files.includes(`${older[0]}.json`));
  assert.ok(older.slice(1).every((id) => files.includes(`${id}.json`)));
  const explained = spawnSync(process.execPath, [cli, 'explain', current.runId, '--root', root, '--json'], { encoding: 'utf8' });
  assert.equal(explained.status, 0, explained.stderr);
  assert.equal(JSON.parse(explained.stdout).outcome, current.outcome);
  await writeFile(join(artifacts, 'retention-capacity.json'), JSON.stringify({ bytes, records: files.length, removed: older[0], newest: current.runId, explained: true }, null, 2));
});

test('concurrent verifiers preserve accepted baseline and confirmed repair history', async (t) => {
  const root = await repository(t);
  assert.equal((await invoke(root, 'baseline', 'create')).outcome, 'pass');
  const path = join(root, '.prooflane/baseline.json');
  const original = await readFile(path, 'utf8');
  await put(root, 'src/history.ts', 'export {};\n');
  const reports = await Promise.all(Array.from({ length: 4 }, () => invoke(root, 'verify', 'full')));
  assert.ok(reports.some((report) => report.outcome === 'pass'));
  for (const report of reports) {
    if (report.outcome !== 'pass') {
      assert.equal(report.outcome, 'incomplete');
      assert.match(report.errors.join(' '), /EEXIST.*observations.lock/);
    }
    const saved = JSON.parse(await readFile(join(root, '.prooflane/runs', `${report.runId}.json`), 'utf8'));
    assert.equal(saved.outcome, report.outcome);
  }
  assert.equal(new Set(reports.map((report) => report.runId)).size, 4);
  assert.equal(await readFile(path, 'utf8'), original);
  await put(root, 'src/history.ts', 'debugger;\n');
  const recurrence = await verify(root, 'concurrent-history-recurrence');
  assert.equal(recurrence.outcome, 'block');
  assert.equal(recurrence.findings[0].status, 'regression');
  await writeFile(join(artifacts, 'concurrent-verification.json'), JSON.stringify(reports, null, 2));
});

test('an abruptly killed baseline writer preserves the baseline and requires explicit stale-lock recovery', async (t) => {
  const root = await repository(t, { cleanup: false });
  let child, analyzerPid;
  const kill = () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === 'win32') spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
    else {
      child.kill('SIGKILL');
      if (analyzerPid) {
        try { process.kill(-analyzerPid, 'SIGKILL'); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    }
  };
  t.after(async () => { kill(); await rm(root, { recursive: true, force: true }); });
  assert.equal((await invoke(root, 'baseline', 'create')).outcome, 'pass');
  const baseline = join(root, '.prooflane/baseline.json');
  const original = await readFile(baseline, 'utf8');
  await rm(join(root, 'node_modules/oxlint'));
  await put(root, 'node_modules/oxlint/package.json', JSON.stringify({ version: '1.87.0', bin: 'cli.cjs' }));
  await put(root, 'node_modules/oxlint/cli.cjs', "require('node:fs').writeFileSync('node_modules/writer-ready',String(process.pid)); setInterval(()=>{},1000);");
  child = spawn(process.execPath, [cli, 'baseline', 'update', '--root', root, '--json'], { stdio: 'ignore' });
  const exit = new Promise((resolve) => child.on('close', resolve));
  for (let i = 0; i < 200; i++) {
    try { analyzerPid = Number(await readFile(join(root, 'node_modules/writer-ready'), 'utf8')); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(Number.isSafeInteger(analyzerPid) && analyzerPid > 0);
  kill();
  await exit;
  assert.equal(await readFile(baseline, 'utf8'), original);
  const refused = await invoke(root, 'baseline', 'update');
  assert.equal(refused.outcome, 'incomplete');
  assert.match(refused.errors.join(' '), /Baseline is locked/);
  await rm(join(root, '.prooflane/baseline.lock'));
  await rm(join(root, 'node_modules/oxlint'), { recursive: true });
  await symlink(join(project, 'node_modules/oxlint'), join(root, 'node_modules/oxlint'), 'junction');
  const recovered = await invoke(root, 'baseline', 'update');
  assert.equal(recovered.outcome, 'pass');
  assert.equal(await readFile(baseline, 'utf8'), original);
  await mkdir(artifacts, { recursive: true });
  await writeFile(join(artifacts, 'interrupted-baseline.json'), JSON.stringify({ refused, recovered }, null, 2));
});
