import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { run } from '../dist/process.js';

const { values } = parseArgs({ options: { root: { type: 'string', default: '.' }, base: { type: 'string' }, label: { type: 'string' }, 'output-dir': { type: 'string' }, reference: { type: 'string', default: 'check:stage4' }, candidate: { type: 'string', default: 'verify:project' } } });
assert.ok(values.base && values.label && values['output-dir'], 'Provide --base REV --label TASK --output-dir NEW_DIRECTORY');
const root = resolve(values.root), output = resolve(values['output-dir']);
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
for (const name of [values.reference, values.candidate]) {
  assert.match(name, /^[a-zA-Z0-9:_-]+$/);
  assert.ok(manifest.scripts?.[name], `Missing project script ${name}`);
}
const manager = manifest.packageManager?.split('@')[0] ?? 'npm';
assert.ok(['npm', 'pnpm', 'yarn'].includes(manager), 'Unsupported project package manager');
const execute = (args, timeout) => process.platform === 'win32'
  ? run('cmd.exe', ['/d', '/s', '/c', `${manager} ${args.join(' ')}`], root, timeout)
  : run(manager, args, root, timeout);
async function git(...args) {
  const result = await run('git', args, root, 30000);
  assert.equal(result.code, 0, result.stderr || result.failure);
  return result.stdout.trim();
}
assert.equal(await git('status', '--porcelain=v1'), '', 'Commit the real change before recording; trial inputs must be reproducible');
const base = await git('rev-parse', '--verify', '--end-of-options', `${values.base}^{commit}`);
const head = await git('rev-parse', 'HEAD');
const changedFiles = (await git('diff', '--name-only', base, head, '--')).split('\n').filter(Boolean);
assert.ok(changedFiles.length, 'The trial must identify an actual committed change');
const version = await execute(['--version'], 30000);
assert.equal(version.code, 0, version.stderr || version.failure);
if (manifest.packageManager) assert.equal(version.stdout.trim(), manifest.packageManager.split('@').at(-1));
await mkdir(dirname(output), { recursive: true });
await mkdir(output);
const summary = { schemaVersion: 1, label: values.label, base, head, changedFiles, packageManager: manifest.packageManager ?? version.stdout.trim(), node: process.version, platform: process.platform, trials: [], complete: false, allChecksPassed: false, agentUsage: null, humanInterventions: null, limitation: 'Two orders on one actual committed change; command workflow comparison, not an Agent trial or long-term effectiveness evidence.' };
const save = () => writeFile(join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
await writeFile(join(output, 'change.patch'), await git('diff', '--binary', '--no-ext-diff', '--no-textconv', base, head, '--'));
await save();
try {
  for (const [index, order] of [['reference', 'candidate'], ['candidate', 'reference']].entries()) {
    for (const arm of order) {
      const script = values[arm];
      const label = `${index + 1}-${arm}`;
      console.log(`Running ${label}: ${script}`);
      const start = performance.now();
      const result = await execute(['run', script], 20 * 60 * 1000);
      const trial = { label, arm, script, wallMs: Math.round(performance.now() - start), exitCode: result.code, failure: result.failure ?? null, passed: result.code === 0 && !result.failure };
      await writeFile(join(output, `${label}.stdout.log`), result.stdout);
      await writeFile(join(output, `${label}.stderr.log`), result.stderr);
      summary.trials.push(trial);
      await save();
      assert.equal(await git('status', '--porcelain=v1'), '', 'Check modified tracked or unignored project files');
      assert.equal(await git('rev-parse', 'HEAD'), head, 'Check changed the input revision');
    }
  }
  summary.complete = true;
  summary.allChecksPassed = summary.trials.every((trial) => trial.passed);
  process.exitCode = summary.allChecksPassed ? 0 : 1;
} catch (error) {
  summary.error = String(error);
  process.exitCode = 2;
} finally { await save(); }
console.log(JSON.stringify(summary));
