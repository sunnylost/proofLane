#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { verify } from './verify.js';
import type { VerificationResult } from './types.js';

const help = `ProofLane — verify the current repository with its local Oxlint installation

Usage: prooflane verify <changed|full> [options]
  --root <path>          Repository or a directory inside it (default: cwd)
  --base <revision>      Compare working tree with this commit (changed only)
  --timeout-ms <number>  Analyzer timeout (default: 60000)
  --json                Emit one structured result
  --help                Show usage

Exit codes: 0 pass, 1 blocked by findings, 2 incomplete verification.
P1 covers lint only. Baseline, other analyzers and MCP are not implemented.`;

function compact(result: VerificationResult): string {
  const lines = [`${result.outcome.toUpperCase()} ${result.profile} (${result.scope}) — ${result.findings.length} findings`];
  for (const analyzer of result.analyzers) lines.push(`${analyzer.name} ${analyzer.status}${analyzer.filesChecked === undefined ? '' : `: ${analyzer.filesChecked} files`} — ${analyzer.reason}`);
  for (const finding of result.findings.slice(0, 20)) {
    lines.push(`${finding.severity.toUpperCase()} ${finding.rule} ${JSON.stringify(finding.location.file)}:${finding.location.line ?? '?'}:${finding.location.column ?? '?'} ${finding.message.replace(/\s+/g, ' ').slice(0, 300)}`);
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
  if (positionals.length !== 2 || positionals[0] !== 'verify' || !['changed', 'full'].includes(positionals[1]!)) throw new Error('Expected: prooflane verify <changed|full>; use --help');
  if (values.base !== undefined && (positionals[1] !== 'changed' || !values.base)) throw new Error('--base requires the changed profile and a non-empty revision');
  const timeoutMs = Number(values['timeout-ms'] ?? 60_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new Error('--timeout-ms must be an integer between 1 and 2147483647');
  result = await verify({ root: resolve(values.root ?? '.'), profile: positionals[1] as 'changed' | 'full', base: values.base, timeoutMs, signal: controller.signal });
} catch (error) {
  result = { schemaVersion: 1, outcome: 'incomplete', profile: 'changed', scope: 'none', files: [], analyzers: [], findings: [], errors: [error instanceof Error ? error.message : String(error)] };
} finally {
  process.off('SIGINT', cancel);
  process.off('SIGTERM', cancel);
}
console.log(json ? JSON.stringify(result) : compact(result));
process.exitCode = { pass: 0, block: 1, incomplete: 2 }[result.outcome];
