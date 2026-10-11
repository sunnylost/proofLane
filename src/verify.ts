import { changedFiles, repositoryRoot, snapshot, sourceFile } from './git.js';
import { analyze } from './oxlint.js';
import type { VerificationResult } from './types.js';
import { saveRun } from './evidence.js';
import { baselineChangedFiles, compareBaseline, configurationDigest, configurationFile, fingerprints, loadBaseline, lockBaseline, type BaselineAction } from './baseline.js';

export interface VerifyRequest {
  root: string;
  profile: 'changed' | 'full';
  base?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  baselineAction?: BaselineAction;
}

export async function verify(request: VerifyRequest): Promise<VerificationResult> {
  const result: VerificationResult = { schemaVersion: 1, outcome: 'incomplete', profile: request.profile, scope: 'none', files: [], analyzers: [], findings: [], errors: [] };
  let unlock: (() => Promise<void>) | undefined;
  try {
    const root = await repositoryRoot(request.root, request.signal);
    result.root = root;
    if (request.baselineAction) unlock = await lockBaseline(root);
    const baseline = request.baselineAction === 'reset' ? undefined : await loadBaseline(root);
    result.snapshot = await snapshot(root, request.signal);
    result.configuration = await configurationDigest(root, request.signal);
    let paths = ['.'];
    let reason = 'Full project lint requested';
    result.scope = 'project';
    if (request.profile === 'changed') {
      const changes = await changedFiles(root, request.base, request.signal);
      changes.files = [...new Set([...changes.files, ...await baselineChangedFiles(root, baseline)])].sort();
      result.files = changes.files;
      result.base = changes.base;
      const configurationChanged = changes.files.some(configurationFile);
      if (configurationChanged || changes.deletedOrRenamed) {
        reason = configurationChanged ? 'Configuration or dependency changes require project lint' : 'Deleted, renamed or type-changed files require project lint';
      } else {
        paths = changes.files.filter(sourceFile).map((file) => `./${file}`);
        result.scope = paths.length ? 'files' : 'none';
        reason = paths.length ? 'Lint changed JavaScript and TypeScript files' : 'No changed JavaScript or TypeScript files';
      }
    }
    if (paths.length === 0) {
      result.analyzers.push({ name: 'oxlint', status: 'skipped', reason });
    } else {
      const report = await analyze(root, paths, reason, request.timeoutMs, request.signal);
      result.analyzers.push(report.analyzer);
      result.findings = report.findings;
      if (report.error) result.errors.push(report.error);
    }
    if (await snapshot(root, request.signal) !== result.snapshot) result.errors.push('Repository changed during verification; rerun against a stable working tree');
    await fingerprints(root, result.findings);
    await compareBaseline(root, result, baseline, request.baselineAction);
    result.outcome = result.errors.length ? 'incomplete' : result.findings.some((finding) => finding.status === 'regression' || (finding.severity === 'error' && finding.status !== 'existing')) ? 'block' : 'pass';
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error));
  } finally {
    if (unlock) await unlock();
  }
  try { await saveRun(result); }
  catch (error) { result.outcome = 'incomplete'; result.errors.push(`Could not save evidence: ${String(error)}`); delete result.runId; }
  for (const analyzer of result.analyzers) delete analyzer.evidence;
  return result;
}
