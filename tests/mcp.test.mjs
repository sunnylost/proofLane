import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { repository, verify, cli, artifacts, put } from './helpers.mjs';

async function connect(t, root) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp', '--root', root], stderr: 'pipe' });
  const client = new Client({ name: 'prooflane-e2e', version: '1' });
  t.after(() => client.close());
  await client.connect(transport);
  return client;
}

test('MCP and CLI agree on real findings; explain returns evidence and rejects invalid references', async (t) => {
  const root = await repository(t);
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
  const root = await repository(t);
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
  const root = await repository(t, { tool: "require('node:fs').writeFileSync('node_modules/ready','ready'); setInterval(()=>{},1000)" });
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
