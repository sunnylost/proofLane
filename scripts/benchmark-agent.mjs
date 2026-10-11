import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { run } from '../dist/process.js';

const { values, positionals } = parseArgs({ options: { model: { type: 'string' }, 'output-dir': { type: 'string' }, 'verification-only': { type: 'boolean' } }, allowPositionals: true });
if (!positionals[0] || !values.model) throw new Error('Usage: node scripts/benchmark-agent.mjs <epub-repository> --model <same-model-for-both-arms>');
const project = fileURLToPath(new URL('../', import.meta.url));
const source = resolve(positionals[0]);
const output = resolve(values['output-dir'] ?? join(project, 'artifacts/benchmark'));
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), 'prooflane-benchmark-'));
const target = 'packages/engine/src/locations.ts';
await mkdir(join(temporary, 'harness'), { recursive: true });
await cp(join(project, 'dist'), join(temporary, 'harness/dist'), { recursive: true });
await cp(join(project, 'package.json'), join(temporary, 'harness/package.json'));
await symlink(join(project, 'node_modules'), join(temporary, 'harness/node_modules'), 'junction');
const cli = join(temporary, 'harness/dist/cli.js');
await cp(join(temporary, 'harness/dist'), join(output, 'harness-build/dist'), { recursive: true });
await cp(join(project, 'package.json'), join(output, 'harness-build/package.json'));
await cp(join(project, 'package-lock.json'), join(output, 'harness-build/package-lock.json'));
const verdictSchema = join(temporary, 'verdict-schema.json');
await writeFile(verdictSchema, JSON.stringify({ type: 'object', properties: { verdict: { type: 'string', enum: ['pass', 'block', 'incomplete'] } }, required: ['verdict'], additionalProperties: false }));
const tasks = [
  { name: 'positive-location-size', symbol: 'normalizeLocationGenerationOptions', from: 'return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;', to: 'return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 1;', request: 'Fix location size normalization: charsPerLocation must always be a positive integer; preserve the 1024 default and non-finite fallback of 1.', visible: "expect(normalizeLocationGenerationOptions({charsPerLocation:0}).charsPerLocation).toBe(1);", oracle: "for(const value of [-10,-0,NaN,Infinity,-Infinity]) expect(normalizeLocationGenerationOptions({charsPerLocation:value}).charsPerLocation).toBe(1); expect(normalizeLocationGenerationOptions({charsPerLocation:2.9}).charsPerLocation).toBe(2); expect(normalizeLocationGenerationOptions().charsPerLocation).toBe(1024);" },
  { name: 'cache-scope-escaping', symbol: 'bookLocationCacheKey', from: '.map(escapeCacheKeyPart)\n    .join(":")', to: '.join(":")', request: 'Fix book location cache key serialization: encode every component so scope names containing separators cannot change the cache-key structure. Preserve the v2 schema and defaults.', visible: "expect(bookLocationCacheKey('a:b',2)).toBe('foliosmith%3Alocations:v2:a%3Ab:2:1024');", oracle: "expect(bookLocationCacheKey('a/b#中',3,{charsPerLocation:2})).toBe('foliosmith%3Alocations:v2:a%2Fb%23%E4%B8%AD:3:2'); expect(bookLocationCacheKey('',-1)).toBe('foliosmith%3Alocations:v2::0:1024');" },
];

async function git(root, ...args) {
  const result = await run('git', ['-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${join(temporary, 'no-hooks')}`, '-c', 'user.name=ProofLane Benchmark', '-c', 'user.email=benchmark@example.invalid', ...args], root, 30000);
  assert.equal(result.code, 0, result.stderr || result.failure);
  return result.stdout.trim();
}

async function suite(root, assertions, symbol) {
  await writeFile(join(root, 'prooflane-benchmark.test.ts'), `import {test,expect} from 'vitest'; import {${symbol}} from './${target}'; test('location contract',()=>{${assertions}});`);
  return run(process.execPath, [join(project, 'node_modules/vitest/vitest.mjs'), 'run', 'prooflane-benchmark.test.ts', '--maxWorkers=1', '--update=none'], root, 30000);
}

const sourceStatus = await git(source, 'status', '--porcelain=v1');
const revision = await git(source, 'rev-parse', 'HEAD');
const results = [];
try {
  for (const [taskIndex, task] of tasks.entries()) {
    for (const arm of taskIndex % 2 ? ['harness', 'control'] : ['control', 'harness']) {
      const label = `${task.name}-${arm}`;
      const root = join(temporary, label);
      await git(project, 'clone', '--quiet', '--no-hardlinks', '--', source, root);
      assert.equal(await git(root, 'rev-parse', 'HEAD'), revision);
      await mkdir(join(root, 'node_modules'), { recursive: true });
      for (const [name, origin] of [['oxlint', source], ['vitest', project]]) await symlink(join(origin, 'node_modules', name), join(root, 'node_modules', name), 'junction');
      await writeFile(join(root, 'prooflane.json'), '{"analyzers":["oxlint","vitest"],"concurrency":2}');
      await writeFile(join(root, 'vitest.config.mjs'), "export default {test:{include:['prooflane-benchmark.test.ts']}};\n");
      await writeFile(join(root, '.git/info/exclude'), '.prooflane/runs/\n.vitest/\n');
      const original = await readFile(join(root, target), 'utf8');
      assert.ok(original.includes(task.from), 'Benchmark mutation must match the inspected source revision');
      assert.equal((await suite(root, task.visible + task.oracle, task.symbol)).code, 0, 'Independent oracle must pass before mutation');
      const healthy = await run(process.execPath, [cli, 'verify', 'full', '--root', root, '--json'], root, 60000);
      await writeFile(join(output, `${label}-preflight.json`), healthy.stdout);
      assert.equal(healthy.code, 0, 'Configured verification failed before mutation; inspect the preflight artifact');
      await writeFile(join(root, target), original.replace(task.from, task.to));
      const broken = await suite(root, task.visible, task.symbol);
      assert.equal(broken.code, 1, 'Independent test must detect the seeded defect');
      await writeFile(join(output, `${label}-before.txt`), broken.stdout + broken.stderr);
      await git(root, 'add', target, 'prooflane-benchmark.test.ts', 'prooflane.json', 'vitest.config.mjs');
      await git(root, 'commit', '-m', 'seed benchmark regression');
      const instructions = values['verification-only']
        ? `Verify the current implementation against this requirement: ${task.request}\nThis is verification only: do not edit source, tests, configuration, dependencies or baselines. Work locally without network or commits. Report pass, block or incomplete based on actual evidence. The visible contract test is prooflane-benchmark.test.ts.`
        : `${task.request}\nOnly edit ${target}. Do not modify tests, configuration, dependencies or baselines. Work locally without network, commits or pushes. Preserve unrelated behavior. Explain what you actually verified. The visible regression is in prooflane-benchmark.test.ts.`;
      const modes = arm === 'harness'
        ? `Use the verification harness with this command:\nnode ${JSON.stringify(cli)} verify full --root .\nUse explain if evidence is needed.`
        : 'Use the standalone project tools: node node_modules/oxlint/bin/oxlint --format json and node node_modules/vitest/vitest.mjs run --maxWorkers=1. Inspect their output to decide what needs fixing.';
      console.log(`Starting ${label}`);
      const started = performance.now();
      const agent = await run('codex', ['exec', '--ignore-user-config', '--ephemeral', '--sandbox', 'workspace-write', '--json', '-m', values.model, '-c', 'model_reasoning_effort="high"', ...(values['verification-only'] ? ['--output-schema', verdictSchema] : []), '-C', root, `${instructions}\n${modes}`], root, 240000);
      await writeFile(join(output, `${label}.jsonl`), agent.stdout);
      await writeFile(join(output, `${label}.stderr.txt`), agent.stderr);
      const events = agent.stdout.split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return { type: 'invalid-event' }; } });
      const usage = events.findLast((event) => event.type === 'turn.completed')?.usage ?? null;
      const commands = events.filter((event) => event.type === 'item.completed' && event.item?.type === 'command_execution').map((event) => event.item.command);
      const patch = await git(root, 'diff', '--');
      await writeFile(join(output, `${label}.diff`), patch);
      const edited = [...new Set([...(await git(root, 'diff', '--name-only')).split('\n'), ...(await git(root, 'ls-files', '--others', '--exclude-standard')).split('\n')])].filter(Boolean);
      const independent = await suite(root, task.oracle, task.symbol);
      await writeFile(join(output, `${label}-oracle.txt`), independent.stdout + independent.stderr);
      const checksObserved = commands.filter((command) => /node\s+[^\n]*(?:vitest\.mjs|oxlint\/bin\/oxlint|cli\.js[\\"']*\s+verify)/.test(command));
      let verdict = null;
      if (values['verification-only']) {
        try { verdict = JSON.parse(events.findLast((event) => event.type === 'item.completed' && event.item?.type === 'agent_message')?.item.text ?? '').verdict; }
        catch { verdict = null; }
      }
      const success = values['verification-only'] ? independent.code === 1 && verdict === 'block' && edited.length === 0 : independent.code === 0 && edited.every((file) => file === target);
      const result = { task: task.name, arm, phase: values['verification-only'] ? 'verification-only' : 'repair-and-verify', model: values.model, reasoningEffort: 'high', timeoutMs: 240000, agentExit: agent.code, failure: agent.failure ?? null, usage, wallTimeMs: Math.round(performance.now() - started), commandCount: commands.length, verificationCommands: checksObserved, taskSuccess: agent.code === 0 && usage !== null && success, oraclePassed: independent.code === 0, verdict, outOfScopeEdits: edited.filter((file) => values['verification-only'] || file !== target), verificationTokens: values['verification-only'] && usage ? usage.input_tokens + usage.output_tokens : null, verificationTokenNote: values['verification-only'] ? 'All model tokens belong to this verification-only session; source edits are forbidden and audited' : 'Whole repair session usage; no fabricated per-phase attribution', verificationEscape: values['verification-only'] ? verdict === 'pass' && independent.code !== 0 : agent.code === 0 && independent.code !== 0 };
      results.push(result);
      await writeFile(join(output, 'summary.json'), JSON.stringify({ revision, results, complete: results.length === tasks.length * 2 && results.every((r) => r.usage !== null), limitation: 'Two mutation tasks from the real EPUB repository; a pilot, not statistical evidence of general improvement.' }, null, 2));
      console.log(JSON.stringify(result));
      if (agent.code !== 0 || !usage) { process.exitCode = 2; throw new Error('Real agent run failed; recorded as incomplete, not a successful benchmark'); }
    }
  }
  assert.equal(await git(source, 'status', '--porcelain=v1'), sourceStatus);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
