import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { run } from '../dist/process.js';
import { runOracle, assessTrial, summarize } from './benchmark-results.mjs';
import { tasks as allTasks, seedTask, testSource } from './benchmark-tasks.mjs';

const { values, positionals } = parseArgs({ options: { model: { type: 'string' }, 'output-dir': { type: 'string' }, 'verification-only': { type: 'boolean' }, repetitions: { type: 'string', default: '2' }, 'prepare-only': { type: 'boolean' } }, allowPositionals: true });
if (positionals.length !== 1 || (!values.model && !values['prepare-only'])) throw new Error('Usage: node scripts/benchmark-agent.mjs <epub-repository> --model MODEL [--verification-only] [--repetitions 2] [--prepare-only] [--output-dir NEW_DIRECTORY]');
const tasks = values['verification-only'] ? allTasks : allTasks.filter((task) => ['positive-location-size', 'cache-scope-escaping'].includes(task.name));
const repetitions = Number(values.repetitions);
assert.ok(Number.isInteger(repetitions) && repetitions >= 1 && repetitions <= 10, 'repetitions must be an integer between 1 and 10');
const project = fileURLToPath(new URL('../', import.meta.url));
const source = resolve(positionals[0]);
const output = resolve(values['output-dir'] ?? join(project, 'artifacts', `benchmark-${Date.now()}`));
await mkdir(dirname(output), { recursive: true });
await mkdir(output); // Existing trials must never be overwritten by a retry.
const temporary = await mkdtemp(join(tmpdir(), 'prooflane-benchmark-'));
const phase = values['verification-only'] ? 'verification-only' : 'repair-and-verify';
const results = [];
const manifest = { schemaVersion: 2, phase, model: values.model ?? null, reasoningEffort: 'high', timeoutMs: 240000, repetitions, plannedTrials: tasks.length * repetitions * 2, node: process.version, platform: process.platform, cases: [], hashes: {} };
const save = (path, data) => writeFile(path, JSON.stringify(data, null, 2) + '\n');
const persist = async () => save(join(output, 'summary.json'), { ...manifest, attempted: results.length, complete: results.length === manifest.plannedTrials && results.every((r) => r.agentComplete && r.oracle.state !== 'incomplete'), results, statistics: summarize(results), limitation: `${tasks.length} scenarios in one real EPUB repository, repeated paired trials; not a cross-project or population-level guarantee. Tokens are not monetary cost.` });

async function git(root, ...args) {
  const result = await run('git', ['-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${join(temporary, 'no-hooks')}`, '-c', 'user.name=ProofLane Benchmark', '-c', 'user.email=benchmark@example.invalid', ...args], root, 30000);
  assert.equal(result.code, 0, result.stderr || result.failure);
  assert.equal(result.failure, undefined);
  return result.stdout.replace(/\r?\n$/, '');
}
async function linkTools(root) {
  await mkdir(join(root, 'node_modules'), { recursive: true });
  for (const name of ['oxlint', 'vitest']) await symlink(join(project, 'node_modules', name), join(root, 'node_modules', name), 'junction');
  await writeFile(join(root, '.git/info/exclude'), '.prooflane/runs/\n.prooflane/observations.*\n.vitest/\n');
}
async function hashTree(directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const relative = prefix + entry.name;
    if (entry.isDirectory()) await hashTree(path, relative + '/');
    else if (entry.isFile()) manifest.hashes[relative] = createHash('sha256').update(await readFile(path)).digest('hex');
  }
}

try {
  assert.equal(await git(source, 'status', '--porcelain=v1'), '', 'Benchmark source must be clean; uses frozen HEAD only');
  manifest.sourceRevision = await git(source, 'rev-parse', 'HEAD');
  manifest.harnessRevision = await git(project, 'rev-parse', 'HEAD');
  manifest.harnessDirty = (await git(project, 'status', '--porcelain=v1')).length > 0;
  const codexVersion = await run('codex', ['--version'], project, 10000);
  if (!values['prepare-only']) assert.equal(codexVersion.code, 0, 'Codex CLI is required');
  manifest.codexVersion = codexVersion.stdout.trim();
  const frozen = join(output, 'frozen');
  await mkdir(frozen);
  for (const path of ['dist', 'scripts', 'package.json', 'package-lock.json']) await cp(join(project, path), join(frozen, path), { recursive: true });
  await git(source, 'bundle', 'create', join(frozen, 'source.bundle'), 'HEAD');
  await cp(join(frozen, 'dist'), join(temporary, 'harness/dist'), { recursive: true });
  await cp(join(frozen, 'package.json'), join(temporary, 'harness/package.json'));
  await symlink(join(project, 'node_modules'), join(temporary, 'harness/node_modules'), 'junction');
  const cli = join(temporary, 'harness/dist/cli.js');
  manifest.tools = {};
  for (const name of ['oxlint', 'vitest']) manifest.tools[name] = JSON.parse(await readFile(join(project, 'node_modules', name, 'package.json'), 'utf8')).version;
  const verdictSchema = join(temporary, 'verdict-schema.json');
  await writeFile(verdictSchema, JSON.stringify({ type: 'object', properties: { verdict: { type: 'string', enum: ['pass', 'block', 'incomplete'] } }, required: ['verdict'], additionalProperties: false }));
  for (const task of tasks) {
    console.log(`Preparing ${task.name}`);
    const root = join(temporary, task.name);
    const artifact = join(output, 'cases', task.name);
    const input = join(frozen, 'cases', task.name);
    await mkdir(artifact, { recursive: true });
    await mkdir(input, { recursive: true });
    await git(project, 'clone', '--quiet', '--no-checkout', join(frozen, 'source.bundle'), root);
    await git(root, 'checkout', '--quiet', '--detach', manifest.sourceRevision);
    await linkTools(root);
    await writeFile(join(root, 'prooflane.json'), '{"analyzers":["oxlint","vitest"],"concurrency":2}\n');
    await writeFile(join(root, 'vitest.config.mjs'), "export default {test:{include:['prooflane-benchmark.test.ts']}};\n");
    await writeFile(join(root, 'prooflane-benchmark.test.ts'), testSource(task));
    const healthy = await runOracle(root, testSource(task, true), join(artifact, 'healthy'));
    assert.equal(healthy.state, 'pass', `${task.name}: healthy oracle failed: ${healthy.reason}`);
    const preflight = await run(process.execPath, [cli, 'verify', 'full', '--root', root, '--json'], root, 60000);
    await save(join(artifact, 'preflight.json'), preflight);
    assert.equal(preflight.code, 0, `${task.name}: healthy Harness preflight failed`);
    await git(root, 'add', '.');
    await git(root, 'commit', '--quiet', '-m', 'benchmark healthy fixture');
    if (task.baseline) {
      const original = await readFile(join(root, task.files[0]), 'utf8');
      await seedTask(root, task);
      await git(root, 'add', '.'); await git(root, 'commit', '--quiet', '-m', 'accepted defect');
      for (const action of ['create', 'update']) {
        if (action === 'update') await writeFile(join(root, task.files[0]), original);
        const baseline = await run(process.execPath, [cli, 'baseline', action, '--root', root, '--json'], root, 60000);
        await save(join(artifact, `baseline-${action}.json`), baseline);
        assert.equal(baseline.code, 0, `${task.name}: baseline ${action} failed`);
      }
      await seedTask(root, task);
      await git(root, 'add', '.prooflane/baseline.json'); await git(root, 'commit', '--quiet', '-m', 'record fix history before reappearance');
    } else await seedTask(root, task);
    const seeded = await runOracle(root, testSource(task, true, true), join(artifact, 'seeded'));
    assert.equal(seeded.state, task.expected, `${task.name}: seeded oracle ${seeded.state}: ${seeded.reason}`);
    await git(root, 'add', '-N', '.');
    const patch = await git(root, 'diff', '--binary', 'HEAD');
    await writeFile(join(input, 'working-tree.patch'), patch ? patch + '\n' : '');
    await git(root, 'bundle', 'create', join(input, 'commits.bundle'), `${manifest.sourceRevision}..HEAD`);
    await writeFile(join(input, 'oracle.test.ts'), testSource(task, true, true));
    await save(join(input, 'task.json'), task);
    await git(root, 'add', '.');
    const inputTree = await git(root, 'write-tree');
    await git(root, 'reset', '--quiet');
    manifest.cases.push({ name: task.name, category: task.category, expected: task.expected, head: await git(root, 'rev-parse', 'HEAD'), inputTree, patch: `cases/${task.name}/working-tree.patch` });
  }
  const materialize = async (task, root) => {
    const item = manifest.cases.find((entry) => entry.name === task.name);
    await git(project, 'clone', '--quiet', '--no-checkout', join(frozen, 'source.bundle'), root);
    await git(root, 'fetch', '--quiet', join(frozen, 'cases', task.name, 'commits.bundle'), 'HEAD');
    await git(root, 'checkout', '--quiet', '--detach', item.head);
    const patch = join(frozen, 'cases', task.name, 'working-tree.patch');
    if ((await readFile(patch)).length) await git(root, 'apply', '--binary', patch);
    await linkTools(root);
    await git(root, 'add', '.');
    assert.equal(await git(root, 'write-tree'), item.inputTree, 'Frozen inputs did not reproduce the prepared tree');
    await git(root, 'reset', '--quiet');
  };
  for (const task of tasks) {
    const root = join(temporary, `replay-${task.name}`);
    await materialize(task, root);
    const oracle = await runOracle(root, testSource(task, true, true), join(output, 'cases', task.name, 'replay'));
    assert.equal(oracle.state, task.expected, `Frozen oracle disagrees: ${task.name}`);
    const check = await run(process.execPath, [cli, 'verify', 'changed', '--root', root, '--json'], root, 60000);
    await save(join(output, 'cases', task.name, 'changed-check.json'), check);
    if (task.baseline) assert.ok(JSON.parse(check.stdout).findings.some((finding) => finding.status === 'regression'), 'Baseline scenario must exercise a confirmed regression');
    await rm(root, { recursive: true, force: true });
  }
  for (const task of tasks) await rm(join(temporary, task.name), { recursive: true, force: true });
  manifest.inputsReplayed = true;
  await hashTree(frozen);
  await save(join(output, 'manifest.json'), manifest);
  await persist();
  if (!values['prepare-only']) for (let repetition = 1; repetition <= repetitions; repetition++) {
    for (const [taskIndex, task] of tasks.entries()) for (const arm of (taskIndex + repetition) % 2 ? ['control', 'harness'] : ['harness', 'control']) {
      const label = `${task.name}-r${repetition}-${arm}`;
      const root = join(temporary, `trial-${randomUUID()}`);
      const artifact = join(output, label);
      await mkdir(artifact);
      const result = { task: task.name, category: task.category, repetition, arm, phase, agentComplete: false, oracle: { state: 'incomplete', reason: 'Trial did not finish' }, verdict: null, usage: null, outOfScopeEdits: [], agentMs: null, commandCount: null };
      console.log(`Starting ${label}`);
      try {
        await materialize(task, root);
        const beforeStatus = await git(root, 'status', '--porcelain=v1', '--untracked-files=all');
        // Commit a comparison tree separately; preserve HEAD for changed checks and baseline regressions.
        await git(root, 'add', '.');
        const beforeTree = await git(root, 'write-tree');
        await git(root, 'reset', '--quiet');
        const head = await git(root, 'rev-parse', 'HEAD');
        const instructions = `${phase === 'verification-only' ? 'Verify, without changing source, tests, configuration, dependencies or baselines.' : `Repair only if needed; edits are allowed only in: ${task.files.join(', ')}. Do not change tests, configuration, dependencies or baselines.`} Requirement: ${task.requirement}\nWork locally without network, commits or pushes. Do not inspect other trials or files outside this workspace except the provided tool installation. Report pass, block or incomplete based on actual evidence. Pass covers the configured checks, not all EPUB/Rust/browser behavior. Visible contract: prooflane-benchmark.test.ts. Existing warnings alone do not block; test failure blocks; tool execution failure is incomplete. A baseline may contain accepted and resolved history; do not accept new failures.`;
        const modes = arm === 'harness'
          ? `Use the verification harness: node ${JSON.stringify(cli)} verify changed --root .\nUse explain or full verification when needed.`
          : 'Use standalone project tools: node node_modules/oxlint/bin/oxlint --format json and node node_modules/vitest/vitest.mjs run --maxWorkers=1 --update=none --allowOnly=false. Inspect both outputs.';
        const prompt = `${instructions}\n${modes}`;
        await writeFile(join(artifact, 'prompt.txt'), prompt);
        const started = performance.now();
        const agent = await run('codex', ['exec', '--ignore-user-config', '--ephemeral', '--sandbox', 'workspace-write', '--json', '-m', values.model, '-c', 'model_reasoning_effort="high"', '--output-schema', verdictSchema, '-C', root, prompt], root, manifest.timeoutMs);
        result.agentMs = Math.round(performance.now() - started);
        result.agentExit = agent.code;
        result.failure = agent.failure ?? null;
        await writeFile(join(artifact, 'agent.jsonl'), agent.stdout);
        await writeFile(join(artifact, 'stderr.txt'), agent.stderr);
        const events = agent.stdout.split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return { type: 'invalid-event' }; } });
        result.usage = events.findLast((event) => event.type === 'turn.completed')?.usage ?? null;
        const validUsage = result.usage && ['input_tokens', 'output_tokens', 'cached_input_tokens'].every((key) => Number.isSafeInteger(result.usage[key]) && result.usage[key] >= 0) && result.usage.cached_input_tokens <= result.usage.input_tokens;
        if (!validUsage) result.usage = null;
        const commands = events.filter((event) => event.type === 'item.completed' && event.item?.type === 'command_execution').map((event) => event.item.command);
        result.commandCount = commands.length;
        await save(join(artifact, 'commands.json'), commands);
        try { result.verdict = JSON.parse(events.findLast((event) => event.type === 'item.completed' && event.item?.type === 'agent_message')?.item.text ?? '').verdict; } catch { result.verdict = null; }
        result.agentComplete = Boolean(agent.code === 0 && !agent.failure && validUsage && ['pass', 'block', 'incomplete'].includes(result.verdict) && !events.some((event) => ['invalid-event', 'turn.failed', 'error'].includes(event.type)));
        await git(root, 'add', '.');
        const afterTree = await git(root, 'write-tree');
        const edited = (await git(root, 'diff', '--name-only', beforeTree, afterTree)).split('\n').filter(Boolean);
        result.outOfScopeEdits = edited.filter((file) => phase === 'verification-only' || !task.files.includes(file));
        if (await git(root, 'rev-parse', 'HEAD') !== head) result.outOfScopeEdits.push('.git/HEAD');
        await writeFile(join(artifact, 'agent.diff'), await git(root, 'diff', '--binary', beforeTree, afterTree));
        await save(join(artifact, 'workspace.json'), { beforeStatus, afterStatus: await git(root, 'status', '--porcelain=v1', '--untracked-files=all'), edited });
        result.oracle = await runOracle(root, testSource(task, true, true), join(artifact, 'oracle'));
      } catch (error) { result.failure = String(error); }
      Object.assign(result, assessTrial(result));
      results.push(result);
      await save(join(artifact, 'result.json'), result);
      await persist();
      console.log(JSON.stringify(result));
      await rm(root, { recursive: true, force: true });
    }
  }
  assert.equal(await git(source, 'rev-parse', 'HEAD'), manifest.sourceRevision, 'Original source revision changed during benchmark');
  assert.equal(await git(source, 'status', '--porcelain=v1'), '', 'Original source working tree changed during benchmark');
  manifest.sourceUnchanged = true;
  await save(join(output, 'manifest.json'), manifest);
  await persist();
  if (!values['prepare-only']) process.exitCode = results.some((r) => !r.agentComplete || r.oracle.state === 'incomplete') ? 2 : results.every((r) => r.taskSuccess) ? 0 : 1;
} catch (error) {
  manifest.failure = String(error);
  await persist();
  throw error;
} finally { await rm(temporary, { recursive: true, force: true }); }
