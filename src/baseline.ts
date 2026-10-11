import { createHash } from 'node:crypto';
import { readFile, open, unlink } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { visibleFiles } from './git.js';
import { atomicJson, readJson, stateDirectory } from './storage.js';
import type { Finding, VerificationResult } from './types.js';

const entry = z.object({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/), contentDigest: z.string(), entity: z.string().optional(), source: z.enum(['oxlint', 'vitest', 'knip', 'react-doctor']), file: z.string().refine((file) => !isAbsolute(file) && !file.includes('\\') && !file.split('/').includes('..') && !file.includes('\0')), state: z.enum(['active', 'resolved']) });
const schema = z.object({ schemaVersion: z.literal(1), fingerprintVersion: z.literal(1), configuration: z.string(), versions: z.record(z.string(), z.string()), entries: z.array(entry) });
type Baseline = z.infer<typeof schema>;
export type BaselineAction = 'create' | 'update' | 'reset';

async function contentDigest(root: string, file: string): Promise<string> {
  try { return createHash('sha256').update(await readFile(join(root, file))).digest('hex'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'deleted'; throw error; }
}

export async function baselineChangedFiles(root: string, baseline: Baseline | undefined): Promise<string[]> {
  const files = new Map(baseline?.entries.map((item) => [item.file, item.contentDigest]));
  const changed = [];
  for (const [file, previous] of files) if (await contentDigest(root, file) !== previous) changed.push(file);
  return changed;
}

export function configurationFile(file: string): boolean {
  return /^(?:\.oxlintrc\.(?:json|jsonc)|oxlint\.config\.[cm]?[jt]s|\.eslintignore|\.gitignore|prooflane\.json|package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock|bun\.lockb?|tsconfig.*\.json|vitest\.config\..*|vite\.config\..*|knip\..*|react-doctor\.config\..*)$/.test(basename(file));
}

export async function configurationDigest(root: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  for (const file of (await visibleFiles(root, signal)).filter(configurationFile)) {
    hash.update(file); hash.update('\0');
    try { hash.update(await readFile(join(root, file))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return hash.digest('hex');
}

export async function fingerprints(root: string, findings: Finding[]): Promise<void> {
  const counts = new Map<string, number>();
  for (const finding of findings) {
    const content = await readFile(join(root, finding.location.file), 'utf8');
    const anchor = finding.location.line === undefined ? finding.message : (content.split(/\r?\n/)[finding.location.line - 1] ?? '').trim();
    const identity = JSON.stringify([finding.source, finding.rule, finding.location.file, finding.severity, finding.entity ?? finding.message, finding.entity ? '' : anchor]);
    const ordinal = (counts.get(identity) ?? 0) + 1;
    counts.set(identity, ordinal);
    finding.fingerprint = createHash('sha256').update(JSON.stringify([identity, ordinal])).digest('hex');
  }
}

export async function loadBaseline(root: string): Promise<Baseline | undefined> {
  try { return schema.parse(await readJson(join(await stateDirectory(root), 'baseline.json'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw new Error(`Invalid baseline: ${error instanceof Error ? error.message : String(error)}`); }
}

export async function lockBaseline(root: string): Promise<() => Promise<void>> {
  const path = join(await stateDirectory(root), 'baseline.lock');
  let handle;
  try { handle = await open(path, 'wx', 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Baseline is locked by another writer; remove a stale lock only after confirming that writer stopped'); throw error; }
  return async () => { await handle.close(); await unlink(path); };
}

export async function compareBaseline(root: string, result: VerificationResult, baseline: Baseline | undefined, action?: BaselineAction): Promise<void> {
  result.resolved = [];
  const versions = Object.fromEntries(result.analyzers.filter((a) => a.version).map((a) => [a.name, a.version!]));
  if (baseline && action !== 'reset') {
    if (baseline.configuration !== result.configuration || Object.entries(versions).some(([name, version]) => baseline.versions[name] !== version)) throw new Error('Baseline is incompatible with analyzer versions or configuration; review changes and run baseline reset explicitly');
  }
  const previous = new Map((action === 'reset' ? [] : baseline?.entries ?? []).map((item) => [item.fingerprint, item]));
  for (const finding of result.findings) {
    const old = previous.get(finding.fingerprint!);
    finding.status = baseline ? old?.state === 'active' ? 'existing' : old?.state === 'resolved' ? 'regression' : 'new' : 'unclassified';
  }
  const current = new Set(result.findings.map((f) => f.fingerprint));
  for (const old of previous.values()) {
    const analyzer = result.analyzers.find((a) => a.name === old.source);
    const covered = old.entity ? analyzer?.coverage?.entities?.includes(old.entity) : analyzer?.coverage?.kind === 'project' || analyzer?.coverage?.checked.includes(old.file);
    if (old.state === 'active' && !current.has(old.fingerprint) && analyzer?.status === 'completed' && analyzer.coverage?.complete && covered) result.resolved.push(old.fingerprint);
  }
  if (!action) return;
  if (action === 'create' && baseline) throw new Error('Baseline already exists; use update or reset explicitly');
  if (action === 'update' && !baseline) throw new Error('No baseline exists; use baseline create');
  if (result.errors.length || result.analyzers.some((a) => a.status !== 'completed' || !a.coverage?.complete)) throw new Error('Cannot write baseline without complete successful analyzer coverage');
  for (const id of result.resolved) previous.get(id)!.state = 'resolved';
  for (const finding of result.findings) {
    previous.set(finding.fingerprint!, { fingerprint: finding.fingerprint!, contentDigest: '', entity: finding.entity, source: finding.source, file: finding.location.file, state: 'active' });
    finding.status = 'existing';
  }
  for (const item of previous.values()) item.contentDigest = await contentDigest(root, item.file);
  await atomicJson(await stateDirectory(root), 'baseline.json', { schemaVersion: 1, fingerprintVersion: 1, configuration: result.configuration, versions, entries: [...previous.values()] });
}
