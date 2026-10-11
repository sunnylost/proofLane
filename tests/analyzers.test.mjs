import assert from 'node:assert/strict';
import { symlink, rm, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { repository, put, verify, project, git } from './helpers.mjs';

const analyzerRoot = resolve(process.env.PROOFLANE_ANALYZER_ROOT ?? project);

async function tools(root, names) {
  await rm(join(root, 'node_modules'), { recursive: true, force: true });
  await symlink(join(analyzerRoot, 'node_modules'), join(root, 'node_modules'), 'junction');
  await put(root, '.gitignore', 'node_modules\nignored.ts\n');
  await put(root, 'prooflane.json', JSON.stringify({ analyzers: names, concurrency: 2 }));
}

test('real Vitest fails on a broken implementation, related verification passes only after fixing it', async (t) => {
  const root = await repository(t);
  await tools(root, ['vitest']);
  await put(root, 'package.json', '{"type":"module","devDependencies":{"vitest":"5.0.3"}}');
  await put(root, 'src/math.ts', 'export const add = (a,b) => a-b;');
  await put(root, 'src/math.test.ts', "import {test,expect} from 'vitest'; import {add} from './math'; test('adds numbers',()=>expect(add(2,3)).toBe(5));");
  git(root, 'add', '.'); git(root, 'commit', '-m', 'broken implementation');
  const failed = await verify(root, 'vitest-real-failure', 'full');
  assert.equal(failed.outcome, 'block');
  assert.equal(failed.findings[0].source, 'vitest');
  assert.match(failed.findings[0].message, /expected -1 to be 5/);
  await put(root, 'src/math.ts', 'export const add = (a,b) => a+b;');
  assert.equal((await verify(root, 'vitest-related-fixed')).outcome, 'pass');
  await put(root, 'src/math.test.ts', "import {test,expect} from 'vitest'; test.skip('adds numbers',()=>expect(1).toBe(2));");
  assert.equal((await verify(root, 'vitest-all-skipped', 'full')).outcome, 'incomplete');
});

test('real Knip identifies unused file; removing the file resolves the reported issue', async (t) => {
  const root = await repository(t);
  await tools(root, ['knip']);
  await put(root, 'package.json', '{"type":"module","name":"knip-fixture"}');
  await put(root, 'knip.json', '{"entry":["src/main.ts"],"project":["src/**/*.ts"]}');
  const result = await verify(root, 'knip-unused', 'full');
  assert.notEqual(result.outcome, 'incomplete', result.errors.join(' '));
  assert.ok(result.findings.some((f) => f.source === 'knip' && f.location.file === 'src/history.ts'));
  await rm(join(root, 'src/history.ts'));
  const fixed = await verify(root, 'knip-fixed', 'full');
  assert.equal(fixed.outcome, 'pass');
  assert.equal(fixed.findings.length, 0);
});

test('real React Doctor finds index keys for string items and confirms stable value keys remove the warning', async (t) => {
  const root = await repository(t);
  await tools(root, ['react-doctor']);
  await rm(join(root, '.oxlintrc.json'));
  await put(root, 'package.json', '{"type":"module","name":"react-fixture","dependencies":{"react":"19.2.5"}}');
  await put(root, 'src/List.tsx', 'export function List({items}) { return <div>{items.map((item,index)=><span key={index}>{item}</span>)}</div>; }');
  const result = await verify(root, 'react-doctor-unstable-key', 'full');
  assert.notEqual(result.outcome, 'incomplete', result.errors.join(' '));
  assert.ok(result.findings.some((f) => f.rule.includes('no-array-index-as-key')));
  await put(root, 'src/List.tsx', 'export function List({items}) { return <div>{items.map((item)=><span key={item}>{item}</span>)}</div>; }');
  const fixed = await verify(root, 'react-doctor-stable-key', 'full');
  assert.notEqual(fixed.outcome, 'incomplete', fixed.errors.join(' '));
  assert.ok(!fixed.findings.some((f) => f.rule.includes('no-array-index-as-key')));
});

test('missing selected analyzer leaves successful analyzer findings visible; invalid config cannot disable checks', async (t) => {
  const root = await repository(t);
  await put(root, 'prooflane.json', '{"analyzers":["oxlint","vitest"]}');
  const result = await verify(root, 'partial-analyzer-failure', 'full');
  assert.equal(result.outcome, 'incomplete');
  assert.ok(result.findings.some((f) => f.source === 'oxlint'));
  assert.equal(result.analyzers.find((a) => a.name === 'vitest').status, 'failed');
  await put(root, 'prooflane.json', '{"analyzers":[]}');
  assert.equal((await verify(root, 'invalid-analyzer-config', 'full')).outcome, 'incomplete');
});

test('versions below the supported floors and prereleases fail before starting an analyzer', async (t) => {
  for (const [name, version] of [['oxlint', '1.73.9'], ['vitest', '4.9.9'], ['knip', '5.99.0'], ['react-doctor', '0.8.99'], ['oxlint', '1.87.0-rc.1']]) {
    const root = await repository(t, { tool: 'missing' });
    await put(root, 'prooflane.json', JSON.stringify({ analyzers: [name] }));
    await put(root, `node_modules/${name}/package.json`, JSON.stringify({ version, bin: { [name]: 'cli.cjs' } }));
    await put(root, `node_modules/${name}/cli.cjs`, "require('node:fs').writeFileSync('node_modules/started','yes'); console.log('{}');");
    const result = await verify(root, `unsupported-${name}-${version}`, 'full');
    assert.equal(result.outcome, 'incomplete');
    assert.match(result.errors.join(' '), /supported >=/);
    await assert.rejects(readFile(join(root, 'node_modules/started')), { code: 'ENOENT' });
  }
});
