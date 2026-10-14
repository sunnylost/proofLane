import assert from 'node:assert/strict';
import test from 'node:test';
import { repository, put, git, verify, project } from './helpers.mjs';

for (const extension of ['svelte', 'vue', 'astro']) {
  test(`${extension} changes receive the same real lint checks as full verification`, async (t) => {
    const root = await repository(t, { toolRoot: process.env.PROOFLANE_ANALYZER_ROOT ?? project });
    await put(root, 'src/history.ts', 'export {};\n');
    const file = `src/Reader.${extension}`;
    const component = (code) => extension === 'astro' ? `---\n${code}\n---\n<div />\n` : `<script lang="ts">\n${code}\n</script>\n<div />\n`;
    await put(root, file, component(''));
    git(root, 'add', '.'); git(root, 'commit', '-m', 'healthy component');
    await put(root, file, component('const = ;'));
    const full = await verify(root, `${extension}-full`, 'full');
    assert.equal(full.outcome, 'block');
    assert.ok(full.findings.some((finding) => finding.location.file === file && finding.rule === 'parse-error'));
    const changed = await verify(root, `${extension}-changed`);
    assert.equal(changed.outcome, 'block');
    assert.equal(changed.scope, 'files');
    assert.deepEqual(changed.findings, full.findings);
    await put(root, file, component('\n'));
    const fixed = await verify(root, `${extension}-fixed`);
    assert.equal(fixed.outcome, 'pass');
    assert.equal(fixed.analyzers[0].status, 'completed');
    assert.ok(fixed.analyzers[0].coverage.checked.includes(file));
  });
}
