import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
assert.equal(process.argv.length, 3, 'Usage: npm run package:release -- <new output directory>');
assert.match(process.env.npm_config_user_agent ?? '', /^npm\//, 'Run through npm run package:release');
const command = (binary, args) => spawnSync(binary, args, { cwd: project, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
const git = (...args) => {
  const result = command('git', args);
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
};
assert.equal(git('status', '--porcelain=v1'), '', 'Release only a committed, clean checkout');
const manifest = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'));
const output = resolve(process.argv[2]);
await mkdir(dirname(output), { recursive: true });
await mkdir(output);
const record = { schemaVersion: 1, complete: false, name: manifest.name, version: manifest.version, sourceRevision: git('rev-parse', 'HEAD'), node: process.version, registryPublished: false };
try {
  const packed = command(process.execPath, [process.env.npm_execpath, 'pack', '--json', '--pack-destination', output]);
  await writeFile(join(output, 'pack.stdout.log'), packed.stdout ?? '');
  await writeFile(join(output, 'pack.stderr.log'), packed.stderr ?? '');
  assert.equal(packed.status, 0, packed.stderr || packed.error?.message);
  const artifact = JSON.parse(packed.stdout)[0];
  assert.equal(artifact.version, manifest.version);
  assert.equal(artifact.name, manifest.name);
  record.filename = artifact.filename;
  record.integrity = artifact.integrity;
  const bytes = await readFile(join(output, artifact.filename));
  record.sha256 = createHash('sha256').update(bytes).digest('hex');
  record.bytes = bytes.length;
  assert.equal(git('status', '--porcelain=v1'), '', 'Packaging changed tracked or unignored files');
  assert.equal(git('rev-parse', 'HEAD'), record.sourceRevision);
  record.complete = true;
} catch (error) { record.error = String(error); process.exitCode = 1; }
await writeFile(join(output, 'release.json'), JSON.stringify(record, null, 2) + '\n');
console.log(JSON.stringify(record, null, 2));
