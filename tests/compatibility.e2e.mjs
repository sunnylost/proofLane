import assert from 'node:assert/strict';
import { readFile, rm, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { repository, put, verify, project, cli, artifacts } from './helpers.mjs';
import { analyzerVersions } from '../dist/tools.js';

const minimum = resolve(process.env.PROOFLANE_ANALYZER_ROOT);
for (const name of Object.keys(analyzerVersions)) {
  test(`${name}: real version upgrade refuses the old baseline until explicit reset`, { timeout: 30000 }, async (t) => {
    const root = await repository(t, { tool: 'missing' });
    if (name === 'react-doctor') await rm(join(root, '.oxlintrc.json'));
    await put(root, '.gitignore', 'node_modules\nignored.ts\n');
    await put(root, 'package.json', '{"private":true,"name":"compatibility-fixture","type":"module","dependencies":{"react":"19.2.5"}}');
    await put(root, 'prooflane.json', JSON.stringify({ analyzers: [name] }));
    await put(root, 'knip.json', '{"entry":["src/main.ts"],"project":["src/**/*.{ts,tsx}"]}');
    await put(root, 'vitest.config.mjs', "export default {test:{include:['src/math.test.ts']}};");
    await put(root, 'src/math.test.ts', "import {test,expect} from 'vitest'; test('contract',()=>expect(1).toBe(1));");
    await put(root, 'src/List.tsx', 'export function List({items}) { return <div>{items.map((item,index)=><span key={index}>{item}</span>)}</div>; }');
    await symlink(join(minimum, 'node_modules'), join(root, 'node_modules'), 'junction');
    if (name === 'oxlint') {
      const broken = await verify(root, 'oxlint-minimum-error', 'full');
      assert.equal(broken.outcome, 'block');
      assert.ok(broken.findings.some((finding) => finding.rule.includes('no-debugger')));
      assert.equal(broken.analyzers[0].coverage.complete, true);
    }
    const baseline = async (action) => {
      const result = spawnSync(process.execPath, [cli, 'baseline', action, '--root', root, '--json'], { encoding: 'utf8', timeout: 20000 });
      await put(artifacts, `${name}-${action}.json`, result.stdout);
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr + result.stdout);
      return JSON.parse(result.stdout);
    };
    const created = await baseline('create');
    assert.equal(created.analyzers[0].version, analyzerVersions[name].minimum);
    assert.equal(created.analyzers[0].coverage.complete, true);
    const accepted = await readFile(join(root, '.prooflane/baseline.json'), 'utf8');
    await rm(join(root, 'node_modules'), { recursive: true, force: true });
    await symlink(join(project, 'node_modules'), join(root, 'node_modules'), 'junction');
    const changed = await verify(root, `${name}-upgrade`, 'full');
    assert.equal(changed.analyzers[0].version, analyzerVersions[name].recommended);
    assert.equal(changed.outcome, 'incomplete');
    assert.match(changed.errors.join(' '), /Baseline is incompatible/);
    assert.equal(await readFile(join(root, '.prooflane/baseline.json'), 'utf8'), accepted);
    await baseline('reset');
    assert.equal((await verify(root, `${name}-after-reset`, 'full')).outcome, 'pass');
  });
}
