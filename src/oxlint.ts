import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { run } from './process.js';
import type { AnalyzerResult, Finding } from './types.js';
import { sourceFile, visibleFiles } from './git.js';
import { evidence } from './evidence.js';
import { localTool } from './tools.js';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Oxlint JSON object');
  return value as Record<string, unknown>;
}

function positiveInteger(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error('Invalid Oxlint source position');
  return value as number;
}

function diagnostic(value: unknown, root: string): Finding {
  const item = object(value);
  if (typeof item.message !== 'string' || typeof item.filename !== 'string' || !item.filename || !['error', 'warning', 'info'].includes(String(item.severity))) {
    throw new Error('Invalid Oxlint diagnostic');
  }
  if (item.code !== undefined && typeof item.code !== 'string') throw new Error('Invalid Oxlint rule code');
  const file = relative(root, resolve(root, item.filename));
  if (file === '..' || file.startsWith(`..${sep}`) || isAbsolute(file)) throw new Error('Oxlint reported a file outside the repository');
  if (!Array.isArray(item.labels)) throw new Error('Invalid Oxlint source labels');
  const span = item.labels.length ? object(object(item.labels[0]).span) : {};
  const location = { file: file.split(sep).join('/'), line: positiveInteger(span.line), column: positiveInteger(span.column) };
  const rule = typeof item.code === 'string' ? item.code : 'parse-error';
  return {
    id: createHash('sha256').update(JSON.stringify([rule, location, item.message])).digest('hex').slice(0, 20),
    source: 'oxlint', category: 'lint', rule,
    severity: item.severity as Finding['severity'], confidence: 'medium', status: 'unclassified',
    message: item.message, location,
  };
}

export async function analyze(root: string, paths: string[], reason: string, timeoutMs: number, signal?: AbortSignal, toolRoot = root): Promise<{ analyzer: AnalyzerResult; findings: Finding[]; error?: string }> {
  const started = performance.now();
  let version: string | undefined;
  let findings: Finding[] = [];
  let raw: AnalyzerResult['evidence'];
  try {
    const tool = await localTool(root, 'oxlint', toolRoot);
    if (!tool.version.startsWith('1.')) throw new Error('Unsupported Oxlint version; expected 1.x');
    version = tool.version;
    const result = await run(process.execPath, [tool.bin, '--format', 'json', '--', ...paths], root, timeoutMs, signal);
    raw = evidence(result);
    if (result.failure) throw new Error(result.failure);
    let report: Record<string, unknown>;
    try { report = object(JSON.parse(result.stdout)); }
    catch { throw new Error(`Oxlint did not return a valid JSON report (exit ${result.code}); check its configuration with the project lint command`); }
    if (!Array.isArray(report.diagnostics) || !Number.isSafeInteger(report.number_of_files) || (report.number_of_files as number) < 0) throw new Error('Invalid Oxlint report schema');
    findings = report.diagnostics.map((item: unknown) => diagnostic(item, root));
    findings.sort((a, b) => a.location.file.localeCompare(b.location.file, 'en') || (a.location.line ?? 0) - (b.location.line ?? 0) || a.rule.localeCompare(b.rule, 'en') || a.id.localeCompare(b.id, 'en'));
    const hasErrors = findings.some((finding) => finding.severity === 'error');
    if ((result.code !== 0 && result.code !== 1) || (result.code === 1 && !hasErrors) || (result.code === 0 && hasErrors)) throw new Error(`Oxlint exit code ${result.code} contradicts its diagnostics`);
    if (report.number_of_files === 0) throw new Error('Oxlint checked zero files; verify paths and ignore configuration');
    const listing = await run(process.execPath, [tool.bin, '--debug', 'files', '--', ...paths], root, Math.max(1, timeoutMs - (performance.now() - started)), signal);
    const candidates = (await visibleFiles(root, signal)).filter(sourceFile);
    const listed = listing.stdout.split(/\r?\n/).filter(Boolean).map((file) => file.replace(/^\.\//, '').split(sep).join('/'));
    const visible = new Set(await visibleFiles(root, signal));
    const complete = !listing.failure && listing.code === 0 && listed.length === report.number_of_files && new Set(listed).size === listed.length && listed.every((file) => visible.has(file));
    const checked = complete ? listed.sort() : [];
    const requested = paths[0] === '.' ? candidates : paths.map((file) => file.replace(/^\.\//, ''));
    const coverage = { requested, checked, excluded: complete ? requested.filter((file) => !checked.includes(file)) : [], complete, ...(!complete ? { reason: 'Analyzer file listing is unavailable or ambiguous; resolved findings cannot be inferred' } : {}) };
    return { analyzer: { name: 'oxlint', status: 'completed', version, reason, filesChecked: report.number_of_files as number, coverage, evidence: raw, durationMs: Math.round(performance.now() - started) }, findings };
  } catch (error) {
    const message = (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'Oxlint is not installed in this repository; install it locally before verification'
      : error instanceof Error ? error.message : String(error);
    return { analyzer: { name: 'oxlint', status: 'failed', version, reason: message, evidence: raw, durationMs: Math.round(performance.now() - started) }, findings, error: message };
  }
}
