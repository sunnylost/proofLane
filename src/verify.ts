import { basename } from 'node:path';
import { changedFiles, repositoryRoot, snapshot } from './git.js';
import { analyze } from './oxlint.js';
import type { VerificationResult } from './types.js';

export interface VerifyRequest {
  root: string;
  profile: 'changed' | 'full';
  base?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export async function verify(request: VerifyRequest): Promise<VerificationResult> {
  const result: VerificationResult = { schemaVersion: 1, outcome: 'incomplete', profile: request.profile, scope: 'none', files: [], analyzers: [], findings: [], errors: [] };
  try {
    const root = await repositoryRoot(request.root, request.signal);
    result.root = root;
    result.snapshot = await snapshot(root, request.signal);
    let paths = ['.'];
    let reason = 'Full project lint requested';
    result.scope = 'project';
    if (request.profile === 'changed') {
      const changes = await changedFiles(root, request.base, request.signal);
      result.files = changes.files;
      result.base = changes.base;
      const configurationChanged = changes.files.some((file) => /^(?:\.oxlintrc\.(?:json|jsonc)|oxlint\.config\.[cm]?[jt]s|\.eslintignore|\.gitignore|package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock|bun\.lockb?|tsconfig.*\.json)$/.test(basename(file)));
      if (configurationChanged || changes.deletedOrRenamed) {
        reason = configurationChanged ? 'Configuration or dependency changes require project lint' : 'Deleted, renamed or type-changed files require project lint';
      } else {
        paths = changes.files.filter((file) => /\.(?:[cm]?[jt]s|[jt]sx)$/.test(file)).map((file) => `./${file}`);
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
    result.outcome = result.errors.length ? 'incomplete' : result.findings.some((finding) => finding.severity === 'error') ? 'block' : 'pass';
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error));
  }
  return result;
}
