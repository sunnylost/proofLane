import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { run } from './process.js';
import { evidence } from './evidence.js';
import { readJson } from './storage.js';
import type { AnalyzerName, AnalyzerResult, Finding } from './types.js';

const assertion = z.object({ fullName: z.string(), status: z.string(), failureMessages: z.array(z.string()), location: z.object({ line: z.number().int().positive(), column: z.number().int().positive() }).optional() });
const vitestReport = z.object({ success: z.boolean(), numPassedTests: z.number().int().nonnegative(), numFailedTests: z.number().int().nonnegative(), testResults: z.array(z.object({ name: z.string(), status: z.string(), message: z.string(), assertionResults: z.array(assertion) })) });
const knipReport = z.object({ issues: z.array(z.object({ file: z.string() }).catchall(z.array(z.object({ name: z.string().optional(), line: z.number().int().positive().optional(), col: z.number().int().positive().optional() }).passthrough()))) });
const reactDiagnostic = z.object({ filePath: z.string(), plugin: z.string(), rule: z.string(), severity: z.enum(['warning', 'error']), message: z.string(), line: z.number().int().nonnegative(), column: z.number().int().nonnegative() });
const reactReport = z.object({ schemaVersion: z.literal(3), reactDetected: z.boolean(), error: z.unknown(), projects: z.array(z.object({ directory: z.string(), complete: z.boolean(), analyzedFiles: z.array(z.string()), skippedChecks: z.array(z.unknown()), diagnostics: z.array(reactDiagnostic) })) });

function fileWithin(root: string, path: string): string {
  const file = relative(root, resolve(root, path));
  if (!file || file === '..' || file.startsWith(`..${sep}`) || isAbsolute(file)) throw new Error('Analyzer reported a path outside the repository');
  return file.split(sep).join('/');
}

function finding(root: string, source: AnalyzerName, rule: string, path: string, message: string, severity: Finding['severity'], line?: number, column?: number, entity?: string): Finding {
  const location = { file: fileWithin(root, path), line, column };
  return { id: createHash('sha256').update(JSON.stringify([source, rule, location, message])).digest('hex').slice(0, 20), source, category: source === 'vitest' ? 'test' : source === 'knip' ? 'dead-code' : 'react', rule, message, severity, confidence: 'medium', status: 'unclassified', location, entity };
}

export async function analyzeTool(name: Exclude<AnalyzerName, 'oxlint'>, root: string, related: string[] | undefined, timeoutMs: number, signal?: AbortSignal): Promise<{ analyzer: AnalyzerResult; findings: Finding[]; error?: string }> {
  const started = performance.now();
  let version: string | undefined;
  let raw: AnalyzerResult['evidence'];
  const findings: Finding[] = [];
  let temporary: string | undefined;
  try {
    const path = await realpath(join(root, 'node_modules', name, 'package.json'));
    const manifest = z.object({ version: z.string(), bin: z.union([z.string(), z.record(z.string(), z.string())]) }).parse(JSON.parse(await readFile(path, 'utf8')));
    version = manifest.version;
    const supported = name === 'vitest' ? version.startsWith('5.') : name === 'knip' ? version.startsWith('6.') : version.startsWith('0.9.');
    if (!supported) throw new Error(`Unsupported ${name} version ${version}`);
    const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin[name];
    if (!bin) throw new Error(`No ${name} executable in local package`);
    const execute = async (args: string[]) => {
      const remaining = timeoutMs - (performance.now() - started);
      if (remaining <= 0) throw new Error(`${name} timed out`);
      const result = await run(process.execPath, [resolve(dirname(path), bin), ...args], root, remaining, signal);
      raw = evidence(result);
      if (result.failure) throw new Error(result.failure);
      if (result.code !== 0 && result.code !== 1) throw new Error(`${name} execution failed with exit ${result.code}`);
      return result;
    };
    let coverage: NonNullable<AnalyzerResult['coverage']>;
    let reason = 'Full configured project analysis';
    if (name === 'vitest') {
      temporary = await mkdtemp(join(tmpdir(), 'prooflane-vitest-'));
      const reportPath = join(temporary, 'report.json');
      const perform = async (files?: string[]) => {
        await rm(reportPath, { force: true });
        const output = await execute([...(files ? ['related', ...files.map((file) => `./${file}`), '--run'] : ['run']), '--reporter=json', `--outputFile=${reportPath}`, '--includeTaskLocation', '--maxWorkers=1', '--update=none', '--allowOnly=false', '--passWithNoTests=false', '--dangerouslyIgnoreUnhandledErrors=false']);
        const report = vitestReport.parse(await readJson(reportPath, 8 * 1024 * 1024));
        raw = evidence({ ...output, stdout: JSON.stringify(report) });
        return { report, code: output.code };
      };
      let execution = await perform(related);
      if (related && execution.report.numPassedTests + execution.report.numFailedTests === 0) {
        execution = await perform(); reason = 'Related selection executed no tests; fell back to full suite';
      } else if (related) reason = 'Vitest related tests for changed source files';
      const { report, code } = execution;
      const checked: string[] = [];
      const entities: string[] = [];
      for (const suite of report.testResults) {
        const file = fileWithin(root, suite.name);
        for (const item of suite.assertionResults) {
          if (item.status !== 'passed' && item.status !== 'failed') continue;
          checked.push(file);
          const entity = JSON.stringify([file, item.fullName]);
          entities.push(entity);
          if (item.status === 'failed') findings.push(finding(root, name, 'vitest/test-failure', file, `Test failed: ${item.fullName}`, 'error', item.location?.line, item.location?.column, entity));
        }
        if (suite.status === 'failed' && !suite.assertionResults.some((a) => a.status === 'failed')) throw new Error(`Vitest suite could not execute: ${file}; inspect evidence`);
      }
      if (report.numPassedTests + report.numFailedTests === 0 || entities.length === 0) throw new Error('Vitest executed zero tests (missing, excluded or all skipped)');
      if (report.numFailedTests !== findings.length || report.success !== (findings.length === 0) || code !== (report.success ? 0 : 1)) throw new Error('Vitest exit status or summary contradicts test results');
      coverage = { requested: related ?? ['.'], checked: [...new Set(checked)].sort(), excluded: [], complete: true, entities };
    } else if (name === 'knip') {
      const output = await execute(['--reporter', 'json', '--no-progress']);
      const report = knipReport.parse(JSON.parse(output.stdout));
      for (const issue of report.issues) {
        for (const [kind, values] of Object.entries(issue)) {
          if (kind === 'file' || !Array.isArray(values)) continue;
          for (const item of values) findings.push(finding(root, name, `knip/${kind}`, issue.file, `${kind}: ${item.name ?? issue.file}`, ['unresolved', 'unlisted'].includes(kind) ? 'error' : 'warning', item.line, item.col));
        }
      }
      if (output.code !== (findings.length ? 1 : 0)) throw new Error('Knip exit status contradicts reported issues');
      coverage = { requested: ['.'], checked: [], excluded: [], complete: true, kind: 'project' };
    } else {
      const output = await execute(['.', '--json', '--json-compact', '--yes', '--no-score', '--no-supply-chain', '--no-cache', '--no-parallel', '--blocking', 'error']);
      const report = reactReport.parse(JSON.parse(output.stdout));
      if (!report.reactDetected || report.error || report.projects.length === 0) throw new Error('React Doctor did not complete a React project scan');
      const checked: string[] = [];
      for (const project of report.projects) {
        if (!project.complete || project.skippedChecks.length) throw new Error('React Doctor reported incomplete or skipped checks');
        for (const file of project.analyzedFiles) checked.push(fileWithin(root, resolve(project.directory, file)));
        for (const item of project.diagnostics) findings.push(finding(root, name, `${item.plugin}/${item.rule}`, resolve(project.directory, item.filePath), item.message, item.severity, item.line || undefined, item.column || undefined));
      }
      if (!checked.length) throw new Error('React Doctor checked zero files');
      if (output.code !== (findings.some((f) => f.severity === 'error') ? 1 : 0)) throw new Error('React Doctor exit status contradicts diagnostics');
      coverage = { requested: ['.'], checked: [...new Set(checked)].sort(), excluded: [], complete: true };
    }
    findings.sort((a, b) => a.location.file.localeCompare(b.location.file, 'en') || (a.location.line ?? 0) - (b.location.line ?? 0) || a.id.localeCompare(b.id, 'en'));
    return { analyzer: { name, status: 'completed', version, reason, coverage, filesChecked: coverage.kind === 'project' ? undefined : coverage.checked.length, evidence: raw, durationMs: Math.round(performance.now() - started) }, findings };
  } catch (error) {
    const message = (error as NodeJS.ErrnoException).code === 'ENOENT' ? `${name} executable or report is missing; verify the local installation and inspect evidence` : error instanceof Error ? error.message : String(error);
    return { analyzer: { name, status: 'failed', version, reason: message, evidence: raw, durationMs: Math.round(performance.now() - started) }, findings, error: message };
  } finally { if (temporary) await rm(temporary, { recursive: true, force: true }); }
}
