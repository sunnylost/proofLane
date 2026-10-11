import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, realpath, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJson, readJson, stateDirectory } from './storage.js';
import type { AnalyzerResult, VerificationResult } from './types.js';
import type { ProcessResult } from './process.js';

const runPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export function evidence(result: ProcessResult): NonNullable<AnalyzerResult['evidence']> {
  return { stdout: result.stdout.slice(0, 64_000), stderr: result.stderr.slice(0, 16_000), exitCode: result.code, truncated: result.stdout.length > 64_000 || result.stderr.length > 16_000 };
}

async function runsDirectory(root: string): Promise<string> {
  const directory = join(await stateDirectory(root), 'runs');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink() || await realpath(directory) !== directory) throw new Error('Evidence directory must not be a symbolic link');
  return directory;
}

export async function saveRun(result: VerificationResult): Promise<void> {
  if (!result.root) return;
  const directory = await runsDirectory(result.root);
  result.runId = randomUUID();
  await atomicJson(directory, `${result.runId}.json`, result);
  const records = [];
  for (const name of await readdir(directory)) {
    if (!runPattern.test(name.replace(/\.json$/, '')) || !name.endsWith('.json')) continue;
    try { const metadata = await stat(join(directory, name)); records.push({ name, time: metadata.mtimeMs, size: metadata.size }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  records.sort((a, b) => b.time - a.time);
  let bytes = 0;
  for (const [index, record] of records.entries()) {
    bytes += record.size;
    if (record.name !== `${result.runId}.json` && (index >= 20 || bytes > 64 * 1024 * 1024)) {
      await unlink(join(directory, record.name)).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    }
  }
}

export async function explain(root: string, runId: string, findingId?: string): Promise<unknown> {
  if (!runPattern.test(runId)) throw new Error('Invalid run ID');
  const value = await readJson(join(await runsDirectory(root), `${runId}.json`));
  if (!value || typeof value !== 'object' || !('schemaVersion' in value) || value.schemaVersion !== 1 || !('runId' in value) || value.runId !== runId || !('findings' in value) || !Array.isArray(value.findings) || !('analyzers' in value) || !Array.isArray(value.analyzers)) throw new Error('Invalid evidence record');
  const result = value as VerificationResult;
  if (!findingId) return { runId, outcome: result.outcome, errors: result.errors, findings: result.findings.slice(0, 20), totalFindings: result.findings.length, analyzers: result.analyzers.map(({ evidence: raw, ...analyzer }) => ({ ...analyzer, evidenceAvailable: Boolean(raw) })) };
  const finding = result.findings.find((item) => item.id === findingId);
  if (!finding) throw new Error('Finding does not exist in this run');
  const analyzer = result.analyzers.find((item) => item.name === finding.source);
  const raw = analyzer?.evidence;
  return { runId, finding, analyzer: analyzer?.name, version: analyzer?.version, evidence: raw ? { ...raw, stdout: raw.stdout.slice(0, 8000), stderr: raw.stderr.slice(0, 2000), truncated: raw.truncated || raw.stdout.length > 8000 || raw.stderr.length > 2000 } : undefined };
}
