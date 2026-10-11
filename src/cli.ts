#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { verify } from './verify.js';
import type { VerificationResult } from './types.js';
import { explain } from './evidence.js';
import { repositoryRoot } from './git.js';

const help = `ProofLane — verify the repository with its configured local analyzers

Usage: prooflane verify <changed|full> [options]
       prooflane baseline <create|update|reset> [options]
       prooflane explain <runId> [findingId|analyzer] [options]
       prooflane mcp --root <repository>
  --root <path>          Repository or a directory inside it (default: cwd)
  --base <revision>      Compare working tree with this commit (changed only)
  --timeout-ms <number>  Analyzer timeout (default: 60000)
  --json                Emit one structured result
  --help                Show usage

Exit codes: 0 pass, 1 blocked by findings, 2 incomplete verification.
Configure analyzers in prooflane.json. Pass covers only the selected checks.`;

function compact(result: VerificationResult): string {
  const lines = [`${result.outcome.toUpperCase()} ${result.profile} (${result.scope}) — ${result.findings.length} findings`];
  if (result.runId) lines.push(`Run ${result.runId}; details: prooflane explain ${result.runId} [findingId|analyzer]`);
  for (const analyzer of result.analyzers) lines.push(`${analyzer.name} ${analyzer.status}${analyzer.filesChecked === undefined ? '' : `: ${analyzer.filesChecked} files`} — ${analyzer.reason}`);
  for (const finding of result.findings.slice(0, 20)) {
    lines.push(`${finding.severity.toUpperCase()} [${finding.id}] ${finding.rule} ${JSON.stringify(finding.location.file)}:${finding.location.line ?? '?'}:${finding.location.column ?? '?'} ${finding.message.replace(/\s+/g, ' ').slice(0, 300)}`);
  }
  if (result.findings.length > 20) lines.push(`${result.findings.length - 20} more findings; use --json for all results`);
  for (const error of result.errors) lines.push(`INCOMPLETE ${error.replace(/\s+/g, ' ')}`);
  return lines.join('\n');
}

const controller = new AbortController();
const cancel = () => controller.abort();
process.on('SIGINT', cancel);
process.on('SIGTERM', cancel);
let result: VerificationResult;
let json = process.argv.slice(2).includes('--json');
try {
  const { values, positionals } = parseArgs({ options: { root: { type: 'string' }, base: { type: 'string' }, 'timeout-ms': { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean' } }, allowPositionals: true, strict: true });
  json = values.json ?? false;
  if (values.help) {
    console.log(help);
    process.exit(0);
  }
  if (positionals[0] === 'mcp' && positionals.length === 1) {
    const { serve } = await import('./mcp.js');
    await serve(resolve(values.root ?? '.'), controller.signal);
    process.exit(0);
  }
  if (positionals[0] === 'explain' && positionals.length >= 2 && positionals.length <= 3) {
    console.log(JSON.stringify(await explain(await repositoryRoot(resolve(values.root ?? '.')), positionals[1]!, positionals[2]), null, json ? undefined : 2));
    process.exit(0);
  }
  const baselineAction = positionals[0] === 'baseline' && ['create', 'update', 'reset'].includes(positionals[1]!) ? positionals[1] as 'create' | 'update' | 'reset' : undefined;
  if (positionals.length !== 2 || (!baselineAction && (positionals[0] !== 'verify' || !['changed', 'full'].includes(positionals[1]!)))) throw new Error('Expected: prooflane verify <changed|full> or baseline <create|update|reset>; use --help');
  if (values.base !== undefined && (positionals[1] !== 'changed' || !values.base)) throw new Error('--base requires the changed profile and a non-empty revision');
  const timeoutMs = Number(values['timeout-ms'] ?? 60_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new Error('--timeout-ms must be an integer between 1 and 2147483647');
  result = await verify({ root: resolve(values.root ?? '.'), profile: baselineAction ? 'full' : positionals[1] as 'changed' | 'full', baselineAction, base: values.base, timeoutMs, signal: controller.signal });
} catch (error) {
  result = { schemaVersion: 1, outcome: 'incomplete', profile: 'changed', scope: 'none', files: [], analyzers: [], findings: [], errors: [error instanceof Error ? error.message : String(error)] };
} finally {
  process.off('SIGINT', cancel);
  process.off('SIGTERM', cancel);
}
console.log(json ? JSON.stringify(result) : compact(result));
process.exitCode = { pass: 0, block: 1, incomplete: 2 }[result.outcome];
