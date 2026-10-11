import assert from 'node:assert/strict';
import { writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { repository, verify, cli, artifacts, put } from './helpers.mjs';

async function connect(t, root) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp', '--root', root], stderr: 'pipe' });
  const client = new Client({ name: 'prooflane-e2e', version: '1' });
  t.after(async () => { await client.close(); await rm(root, { recursive: true, force: true }); });
  await client.connect(transport);
  return client;
}

test('MCP and CLI agree on real findings; explain returns evidence and rejects invalid references', async (t) => {
  const root = await repository(t, { cleanup: false });
  const expected = await verify(root, 'mcp-cli-reference', 'full');
  const client = await connect(t, root);
  const reply = await client.callTool({ name: 'check_project', arguments: {} });
  const actual = JSON.parse(reply.content[0].text);
  await writeFile(join(artifacts, 'mcp-check.json'), JSON.stringify(reply, null, 2));
  assert.equal(actual.outcome, expected.outcome);
  assert.deepEqual(actual.findings.map((f) => [f.rule, f.location, f.status]), expected.findings.map((f) => [f.rule, f.location, f.status]));
  const expanded = await client.callTool({ name: 'explain', arguments: { runId: actual.runId, findingId: actual.findings[0].id } });
  assert.match(expanded.content[0].text, /debugger/);
  const invalid = await client.callTool({ name: 'explain', arguments: { runId: '../../package' } });
  assert.equal(invalid.isError, true);
});

test('MCP returns bounded findings with an explicit total', async (t) => {
  const root = await repository(t, { cleanup: false });
  await put(root, 'src/main.ts', 'debugger;\n'.repeat(100));
  const client = await connect(t, root);
  const reply = await client.callTool({ name: 'check_changes', arguments: {} });
  const result = JSON.parse(reply.content[0].text);
  assert.equal(result.totalFindings, 100);
  assert.equal(result.findings.length, 20);
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(reply.content[0].text) < 32 * 1024);
});

test('MCP cancellation stops analysis and the same connection remains usable', { timeout: 15000 }, async (t) => {
  const root = await repository(t, { cleanup: false, tool: "require('node:fs').writeFileSync('node_modules/ready','ready'); setInterval(()=>{},1000)" });
  const client = await connect(t, root);
  const controller = new AbortController();
  const request = client.callTool({ name: 'check_project', arguments: {} }, undefined, { signal: controller.signal });
  const cancelled = assert.rejects(request);
  for (let i = 0; i < 100; i++) {
    try { await readFile(join(root, 'node_modules/ready')); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise((done) => setTimeout(done, 25));
  }
  assert.equal(await readFile(join(root, 'node_modules/ready'), 'utf8'), 'ready');
  controller.abort();
  await cancelled;
  assert.equal((await client.listTools()).tools.length, 3);
});

test('MCP stdin EOF cancels active verification and exits without a termination signal', { timeout: 10000 }, async (t) => {
  const root = await repository(t, { cleanup: false, tool: "require('node:fs').writeFileSync('node_modules/ready',String(process.pid)); setInterval(()=>{},1000)" });
  let analyzerPid;
  const child = spawn(process.execPath, [cli, 'mcp', '--root', root], { stdio: ['pipe', 'pipe', 'pipe'] });
  const exit = new Promise((done) => child.on('close', (code) => done(code)));
  t.after(async () => {
    child.kill('SIGKILL');
    try {
      if (analyzerPid && process.platform !== 'win32') process.kill(-analyzerPid, 'SIGKILL');
      else if (analyzerPid) spawn('taskkill.exe', ['/pid', String(analyzerPid), '/t', '/f'], { stdio: 'ignore' });
    } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
    await rm(root, { recursive: true, force: true });
  });
  child.stdout.resume(); child.stderr.resume();
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'eof-test', version: '1' } } }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'check_project', arguments: {} } }) + '\n');
  for (let i = 0; i < 100; i++) {
    try { await readFile(join(root, 'node_modules/ready')); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise((done) => setTimeout(done, 25));
  }
  assert.match(await readFile(join(root, 'node_modules/ready'), 'utf8'), /^\d+$/);
  analyzerPid = Number(await readFile(join(root, 'node_modules/ready'), 'utf8'));
  child.stdin.end();
  let timer;
  const result = await Promise.race([exit, new Promise((done) => { timer = setTimeout(() => done('did not exit'), 2000); })]);
  clearTimeout(timer);
  assert.equal(result, 0);
});
