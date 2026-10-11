import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { analyzerVersions } from '../dist/tools.js';

const project = fileURLToPath(new URL('../', import.meta.url));
const output = join(project, 'artifacts/e2e/compatibility');
const minimum = join(project, 'artifacts/compatibility/minimum');
await mkdir(output, { recursive: true });
assert.ok(process.env.npm_execpath, 'Run via npm run test:compatibility');
async function execute(label, args, env = process.env) {
  const child = spawn(process.execPath, args, { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  await writeFile(join(output, `${label}.log`), stdout + stderr);
  assert.equal(code, 0, `${label} failed; see artifacts/e2e/compatibility/${label}.log`);
}
await execute('install-minimum', [process.env.npm_execpath, 'install', '--prefix', minimum, '--ignore-scripts', '--save-exact', '--no-audit', '--no-fund', ...Object.entries(analyzerVersions).map(([name, range]) => `${name}@${range.minimum}`)]);
await writeFile(join(output, 'minimum-package-lock.json'), await readFile(join(minimum, 'package-lock.json')));
const summary = { node: process.version, platform: process.platform, versions: analyzerVersions, completed: [] };
await writeFile(join(output, 'summary.json'), JSON.stringify(summary, null, 2));
for (const [tier, root] of [['minimum', minimum], ['recommended', project]]) {
  for (const [name, range] of Object.entries(analyzerVersions)) assert.equal(JSON.parse(await readFile(join(root, 'node_modules', name, 'package.json'), 'utf8')).version, range[tier]);
  const env = { ...process.env, PROOFLANE_ANALYZER_ROOT: root, PROOFLANE_ARTIFACTS: join(output, tier) };
  await execute(tier, ['--test', '--test-timeout=30000', 'tests/analyzers.test.mjs'], env);
  summary.completed.push(tier);
  await writeFile(join(output, 'summary.json'), JSON.stringify(summary, null, 2));
}
await execute('baseline-upgrades', ['--test', '--test-timeout=30000', 'tests/compatibility.e2e.mjs'], { ...process.env, PROOFLANE_ANALYZER_ROOT: minimum, PROOFLANE_ARTIFACTS: join(output, 'baseline-upgrades') });
summary.completed.push('baseline-upgrades');
await writeFile(join(output, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
