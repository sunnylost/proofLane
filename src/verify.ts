import { changedFiles, repositoryRoot, snapshot, sourceFile } from './git.js';
import { analyze } from './oxlint.js';
import { analyzeTool } from './analyzers.js';
import { readConfig } from './config.js';
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
    result.snapshot = await snapshot(root, request.signal);
    const config = await readConfig(root);
    const baseline = request.baselineAction === 'reset' ? undefined : await loadBaseline(root);
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
      const historicalProjectFindings = baseline?.entries.some((item) => item.source !== 'oxlint');
      if (configurationChanged || changes.deletedOrRenamed || historicalProjectFindings) {
        reason = configurationChanged ? 'Configuration or dependency changes require project lint' : changes.deletedOrRenamed ? 'Deleted, renamed or type-changed files require project lint' : 'Historical cross-file findings require project verification; diagnostic files do not capture all dependencies';
      } else {
        paths = changes.files.filter(sourceFile).map((file) => `./${file}`);
        result.scope = paths.length ? 'files' : 'none';
        reason = paths.length ? 'Check changed JavaScript, TypeScript and framework component files' : 'No changed JavaScript, TypeScript or supported framework component files';
      }
    }
    let next = 0;
    const reports: Awaited<ReturnType<typeof analyze>>[] = [];
    const worker = async () => {
      while (next < config.analyzers.length) {
        const index = next++;
        const name = config.analyzers[index]!;
        const selected = paths.length > 0 && (name !== 'knip' || result.scope === 'project');
        if (!selected) {
          reports[index] = { analyzer: { name, status: 'skipped', reason: name === 'knip' && paths.length ? 'Knip graph analysis requires full profile or structural/configuration changes' : reason }, findings: [] };
          continue;
        }
        reports[index] = name === 'oxlint'
          ? await analyze(root, paths, reason, request.timeoutMs, request.signal, request.root)
          : await analyzeTool(name, root, name === 'vitest' && result.scope === 'files' ? paths.map((file) => file.slice(2)) : undefined, request.timeoutMs, request.signal, request.root);
      }
    };
    await Promise.all(Array.from({ length: Math.min(config.concurrency, config.analyzers.length) }, worker));
    for (const report of reports) {
      result.analyzers.push(report.analyzer);
      result.findings.push(...report.findings);
      if (report.error) result.errors.push(report.error);
    }
    await fingerprints(root, result.findings);
    if (await snapshot(root, request.signal) !== result.snapshot) result.errors.push('Repository changed during verification; rerun against a stable working tree');
    if (await configurationDigest(root, request.signal) !== result.configuration) result.errors.push('Analyzer configuration changed during verification');
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
