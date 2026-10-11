import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { run } from '../dist/process.js';
import { runOracle } from './benchmark-results.mjs';
import { tasks, seedTask, testSource } from './benchmark-tasks.mjs';

const { values, positionals } = parseArgs({ options: { model: { type: 'string' }, 'output-dir': { type: 'string' } }, allowPositionals: true });
assert.ok(positionals.length === 1 && values.model, 'Usage: npm run verify:mcp-agent -- <epub-repository> --model MODEL [--output-dir NEW_DIRECTORY]');
assert.ok(process.env.npm_execpath, 'Run through npm run verify:mcp-agent');
assert.notEqual(process.platform, 'win32', 'Live Codex SIGINT acceptance currently requires POSIX; Windows protocol cancellation is covered by E2E');
const project = fileURLToPath(new URL('../', import.meta.url));
const source = resolve(positionals[0]);
const output = resolve(values['output-dir'] ?? join(project, 'artifacts', `mcp-agent-${Date.now()}`));
await mkdir(dirname(output), { recursive: true });
await mkdir(output);
const temporary = await mkdtemp(join(tmpdir(), 'prooflane-mcp-agent-'));
const workspace = join(temporary, 'workspace');
const install = join(temporary, 'install');
const task = tasks.find((task) => task.name === 'positive-location-size');
const summary = { model: values.model, node: process.version, platform: process.platform, completed: false };
const save = (name, data) => writeFile(join(output, name), JSON.stringify(data, null, 2) + '\n');
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function command(name, binary, args, cwd, expected = 0) {
  const result = await run(binary, args, cwd, 120000);
  await save(`${name}.json`, result);
  assert.equal(result.failure, undefined, result.failure);
  assert.equal(result.code, expected, result.stderr || result.stdout);
  return result.stdout;
}
async function git(root, ...args) {
  const result = await run('git', ['-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${join(temporary, 'no-hooks')}`, '-c', 'user.name=ProofLane Acceptance', '-c', 'user.email=acceptance@example.invalid', ...args], root, 30000);
  assert.equal(result.code, 0, result.stderr || result.failure);
  return result.stdout.trim();
}
const eventsOf = (text) => text.split('\n').filter(Boolean).map(JSON.parse);
const mcpItems = (events) => events.filter((e) => e.item?.type === 'mcp_tool_call' && e.item.server === 'prooflane');
const terminate = (pid) => { try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
try {
  assert.equal(await git(source, 'status', '--porcelain=v1'), '', 'Source must be clean');
  summary.sourceRevision = await git(source, 'rev-parse', 'HEAD');
  summary.codex = (await command('codex-version', 'codex', ['--version'], project)).trim();
  const packed = JSON.parse(await command('pack', process.execPath, [process.env.npm_execpath, 'pack', '--json', '--pack-destination', output], project))[0];
  summary.packageIntegrity = packed.integrity;
  await mkdir(install);
  await writeFile(join(install, 'package.json'), '{"private":true}');
  await command('install', process.execPath, [process.env.npm_execpath, 'install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', join(output, packed.filename)], install);
  await cp(join(install, 'package-lock.json'), join(output, 'installed-package-lock.json'));
  const installed = join(install, 'node_modules/@sunnylost/prooflane');
  const cli = join(installed, 'dist/cli.js');
  await git(project, 'clone', '--quiet', '--no-hardlinks', source, workspace);
  await mkdir(join(workspace, 'node_modules'), { recursive: true });
  for (const name of ['oxlint', 'vitest']) await symlink(join(project, 'node_modules', name), join(workspace, 'node_modules', name), 'junction');
  await writeFile(join(workspace, '.git/info/exclude'), '.prooflane/runs/\n.prooflane/observations.*\n.agents/\n');
  await cp(join(installed, 'skills/prooflane'), join(workspace, '.agents/skills/prooflane'), { recursive: true });
  await writeFile(join(workspace, 'prooflane.json'), '{"analyzers":["oxlint","vitest"],"concurrency":2}');
  await writeFile(join(workspace, 'vitest.config.mjs'), "export default {test:{include:['prooflane-benchmark.test.ts']}};");
  await writeFile(join(workspace, 'prooflane-benchmark.test.ts'), testSource(task));
  assert.equal((await runOracle(workspace, testSource(task, true), join(output, 'healthy-oracle'))).state, 'pass');
  await git(workspace, 'add', '.'); await git(workspace, 'commit', '--quiet', '-m', 'MCP acceptance fixture');
  await seedTask(workspace, task);
  assert.equal((await runOracle(workspace, testSource(task, true), join(output, 'broken-oracle'))).state, 'defect');
  await git(workspace, 'add', '.');
  const beforeTree = await git(workspace, 'write-tree');
  await git(workspace, 'reset', '--quiet');
  const config = {
    'mcp_servers.prooflane.command': process.execPath,
    'mcp_servers.prooflane.args': [cli, 'mcp', '--root', workspace],
    'mcp_servers.prooflane.required': true,
    'mcp_servers.prooflane.startup_timeout_sec': 20,
    'mcp_servers.prooflane.tool_timeout_sec': 150,
    'mcp_servers.prooflane.enabled_tools': ['check_changes', 'check_project', 'explain'],
    'mcp_servers.prooflane.tools.check_changes.approval_mode': 'approve',
    'mcp_servers.prooflane.tools.check_project.approval_mode': 'approve',
    'mcp_servers.prooflane.tools.explain.approval_mode': 'approve',
  };
  await save('client-config.json', config);
  const args = ['exec', '--ignore-user-config', '--ephemeral', '--sandbox', 'workspace-write', '--json', '-m', values.model, '-c', 'model_reasoning_effort="high"', ...Object.entries(config).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]), '-C', workspace];
  const prompt = `Use $prooflane (read .agents/skills/prooflane/SKILL.md) to fix this requirement: ${task.requirement} First use the connected prooflane check_changes MCP tool and inspect its finding through explain. Repair only ${task.files[0]}; preserve tests, configuration, baselines and unrelated code. Recheck with check_changes, then use check_project for final acceptance. Verification must use the actual MCP tools; shell reads/edits are allowed but do not invoke CLI analyzers or ProofLane through a shell. Work locally without network, commits or pushes.`;
  await writeFile(join(output, 'prompt.txt'), prompt);
  console.log('Running real Codex MCP repair');
  const agent = await run('codex', [...args, prompt], workspace, 240000);
  await writeFile(join(output, 'repair.jsonl'), agent.stdout);
  await writeFile(join(output, 'repair.stderr.txt'), agent.stderr);
  assert.equal(agent.code, 0, agent.stderr || agent.failure);
  assert.equal(agent.failure, undefined);
  const events = eventsOf(agent.stdout);
  const calls = mcpItems(events).filter((e) => e.type === 'item.completed').map((e) => e.item);
  await save('mcp-calls.json', calls);
  const report = (call) => { try { return JSON.parse(call.result.content.find((c) => c.type === 'text').text); } catch { return null; } };
  const first = calls.findIndex((call) => call.tool === 'check_changes' && report(call)?.outcome === 'block');
  const explained = calls.findIndex((call, index) => index > first && call.tool === 'explain' && !call.error);
  const rechecked = calls.findIndex((call, index) => index > explained && call.tool === 'check_changes' && report(call)?.outcome === 'pass');
  assert.ok(first >= 0 && explained > first && rechecked > explained, 'Actual MCP block → explain → repair → pass sequence missing');
  assert.ok(calls.slice(rechecked + 1).some((call) => call.tool === 'check_project' && report(call)?.outcome === 'pass'), 'Final MCP project acceptance missing');
  await git(workspace, 'add', '.');
  const afterTree = await git(workspace, 'write-tree');
  const edited = (await git(workspace, 'diff', '--name-only', beforeTree, afterTree)).split('\n').filter(Boolean);
  await git(workspace, 'reset', '--quiet');
  assert.deepEqual([...new Set(edited)], task.files);
  await writeFile(join(output, 'repair.diff'), await git(workspace, 'diff', beforeTree, afterTree));
  assert.equal((await runOracle(workspace, testSource(task, true), join(output, 'fixed-oracle'))).state, 'pass');
  summary.repair = { mcpCalls: calls.map((call) => ({ tool: call.tool, outcome: report(call)?.outcome ?? null })), usage: events.findLast((e) => e.type === 'turn.completed')?.usage, edited, oracle: 'pass' };
  await save('summary.json', summary);
  console.log('Running real Codex MCP interruption');
  const marker = join(workspace, 'node_modules/prooflane-cancel-ready');
  await writeFile(join(workspace, 'prooflane-benchmark.test.ts'), "import {test} from 'vitest'; import {writeFileSync} from 'node:fs'; test('cancellation probe',async()=>{writeFileSync('node_modules/prooflane-cancel-ready',JSON.stringify({pid:process.pid,parentPid:process.ppid})); await new Promise(()=>{});},120000);");
  const cancelPrompt = 'Call the prooflane check_project MCP tool exactly once with timeoutMs 120000 and wait for its result. Do not edit files or use shell tools. This acceptance run will interrupt the pending request.';
  await writeFile(join(output, 'cancel-prompt.txt'), cancelPrompt);
  const child = spawn('codex', [...args, cancelPrompt], { cwd: workspace, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', worker;
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((done, reject) => { child.on('error', reject); child.on('close', (code, signal) => done({ code, signal })); });
  let deadline;
  try {
    for (let i = 0; i < 900; i++) {
      try { worker = JSON.parse(await readFile(marker, 'utf8')); break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (child.exitCode !== null || child.signalCode !== null) break;
      await delay(100);
    }
    assert.ok(worker?.pid && alive(worker.pid), 'MCP analyzer did not become active');
    child.kill('SIGINT');
    const exit = await Promise.race([exited, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Codex did not exit after interruption')), 15000); })]);
    clearTimeout(deadline);
    for (let i = 0; i < 100 && alive(worker.pid); i++) await delay(50);
    assert.equal(alive(worker.pid), false, 'Interrupted MCP analyzer leaked');
    const cancelEvents = mcpItems(eventsOf(stdout));
    assert.ok(cancelEvents.some((e) => e.item.tool === 'check_project'), 'No real MCP cancellation target was recorded');
    summary.cancellation = { exit, analyzerExited: true, mcpEvents: cancelEvents };
  } finally {
    clearTimeout(deadline);
    await writeFile(join(output, 'cancel.jsonl'), stdout);
    await writeFile(join(output, 'cancel.stderr.txt'), stderr);
    terminate(-child.pid);
    if (worker) for (const pid of [worker.pid, worker.parentPid]) if (alive(pid)) terminate(pid);
  }
  assert.equal(await git(source, 'status', '--porcelain=v1'), '');
  assert.equal(await git(source, 'rev-parse', 'HEAD'), summary.sourceRevision);
  summary.sourceUnchanged = true;
  summary.completed = true;
  await save('summary.json', summary);
  console.log(JSON.stringify(summary));
} catch (error) {
  summary.failure = String(error);
  await save('summary.json', summary);
  throw error;
} finally { await rm(temporary, { recursive: true, force: true }); }
