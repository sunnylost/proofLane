import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../dist/process.js';

const project = fileURLToPath(new URL('../', import.meta.url));

export function classifyOracle(process, report) {
  const incomplete = (reason) => ({ state: 'incomplete', reason });
  if (process.failure || ![0, 1].includes(process.code)) return incomplete(process.failure ?? `Oracle exit ${process.code}`);
  if (!report || !Array.isArray(report.testResults)) return incomplete('Missing oracle report');
  const assertions = report.testResults.flatMap((suite) => Array.isArray(suite.assertionResults) ? suite.assertionResults : []);
  if (assertions.length !== 1 || assertions[0].fullName !== 'contract') return incomplete('Oracle contract did not execute exactly once');
  const item = assertions[0];
  if (!['passed', 'failed'].includes(item.status)) return incomplete('Oracle contract was skipped');
  const failed = item.status === 'failed';
  if (report.numTotalTests !== 1 || report.numPassedTests !== Number(!failed) || report.numFailedTests !== Number(failed) || report.numPendingTests !== 0 || report.numTodoTests !== 0 || report.success !== !failed || process.code !== Number(failed) || report.testResults.length !== 1 || report.testResults[0].status !== (failed ? 'failed' : 'passed')) return incomplete('Oracle report and exit status disagree');
  if (failed && (!Array.isArray(item.failureMessages) || item.failureMessages.length !== 1 || !/^AssertionError\b/.test(item.failureMessages[0]))) return incomplete('Oracle failed without a contract assertion');
  return { state: failed ? 'defect' : 'pass', reason: failed ? item.failureMessages[0].split('\n')[0] : 'Contract passed' };
}

export async function runOracle(root, source, artifact, timeoutMs = 30000) {
  await mkdir(artifact, { recursive: true });
  const testFile = join(root, '.prooflane-oracle.test.ts');
  const config = join(artifact, 'vitest.config.mjs');
  await writeFile(config, "export default {test:{include:['.prooflane-oracle.test.ts']}};\n");
  await writeFile(testFile, source, { flag: 'wx' });
  try {
    const reportFile = join(artifact, 'report.json');
    await rm(reportFile, { force: true });
    const execution = await run(process.execPath, [join(project, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config, '--reporter=json', `--outputFile=${reportFile}`, '--maxWorkers=1', '--update=none', '--allowOnly=false', '--passWithNoTests=false', '--dangerouslyIgnoreUnhandledErrors=false'], root, timeoutMs);
    await writeFile(join(artifact, 'execution.json'), JSON.stringify(execution, null, 2));
    let report;
    try { report = JSON.parse(await readFile(reportFile, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    const result = classifyOracle(execution, report);
    await writeFile(join(artifact, 'result.json'), JSON.stringify(result, null, 2));
    return result;
  } finally { await rm(testFile, { force: true }); }
}

export function assessTrial({ phase, oracle, verdict, agentComplete, outOfScopeEdits }) {
  const scorable = Boolean(agentComplete && oracle.state !== 'incomplete' && ['pass', 'block', 'incomplete'].includes(verdict));
  const expected = oracle.state === 'pass' ? 'pass' : 'block';
  return {
    taskSuccess: scorable && outOfScopeEdits.length === 0 && verdict === expected && (phase === 'verification-only' || oracle.state === 'pass'),
    verificationEscape: scorable && oracle.state === 'defect' ? verdict === 'pass' : null,
    falseBlock: scorable && oracle.state === 'pass' ? verdict === 'block' : null,
    abstained: scorable ? verdict === 'incomplete' : null,
  };
}

function distribution(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const count = sorted.length;
  const percentile = (p) => count ? sorted[Math.max(0, Math.ceil(p * count) - 1)] : null;
  return { count, min: sorted[0] ?? null, median: count ? (sorted[Math.floor((count - 1) / 2)] + sorted[Math.floor(count / 2)]) / 2 : null, p90: percentile(0.9), max: sorted.at(-1) ?? null, total: count ? sorted.reduce((a, b) => a + b, 0) : null };
}

function rate(rows, key) {
  const eligible = rows.filter((row) => typeof row[key] === 'boolean');
  const numerator = eligible.filter((row) => row[key]).length;
  return { numerator, denominator: eligible.length, rate: eligible.length ? numerator / eligible.length : null };
}

const tokens = (row) => row.usage ? row.usage.input_tokens + row.usage.output_tokens : null;
export function summarize(rows) {
  const arms = Object.fromEntries(['control', 'harness'].map((arm) => {
    const selected = rows.filter((row) => row.arm === arm);
    return [arm, { trials: selected.length, completed: selected.filter((row) => row.agentComplete).length, oracleIncomplete: selected.filter((row) => row.oracle.state === 'incomplete').length, success: rate(selected, 'taskSuccess'), escape: rate(selected, 'verificationEscape'), falseBlock: rate(selected, 'falseBlock'), abstained: rate(selected, 'abstained'), tokens: distribution(selected.map(tokens)), agentMs: distribution(selected.map((row) => row.agentMs)), commands: distribution(selected.map((row) => row.commandCount)) }];
  }));
  const pairs = rows.filter((row) => row.arm === 'control').flatMap((control) => {
    const harness = rows.find((row) => row.arm === 'harness' && row.task === control.task && row.repetition === control.repetition);
    if (!harness?.agentComplete || !control.agentComplete || tokens(control) === null || tokens(harness) === null) return [];
    return [{ task: control.task, repetition: control.repetition, deltaTokens: tokens(harness) - tokens(control), deltaAgentMs: harness.agentMs - control.agentMs }];
  });
  return { arms, pairs, pairedTokens: distribution(pairs.map((p) => p.deltaTokens)), pairedAgentMs: distribution(pairs.map((p) => p.deltaAgentMs)) };
}
