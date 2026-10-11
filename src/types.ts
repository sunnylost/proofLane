export type AnalyzerName = 'oxlint' | 'vitest' | 'knip' | 'react-doctor';
export interface Finding {
  id: string;
  source: AnalyzerName;
  fingerprint?: string;
  rule: string;
  category: 'lint' | 'test' | 'dead-code' | 'react';
  severity: 'error' | 'warning' | 'info';
  confidence: 'medium';
  status: 'unclassified' | 'new' | 'existing' | 'regression';
  message: string;
  location: { file: string; line?: number; column?: number };
}

export interface AnalyzerResult {
  name: AnalyzerName;
  status: 'completed' | 'skipped' | 'failed';
  reason: string;
  version?: string;
  filesChecked?: number;
  durationMs?: number;
  coverage?: { requested: string[]; checked: string[]; excluded: string[]; complete: boolean; reason?: string };
  evidence?: { stdout: string; stderr: string; exitCode: number | null; truncated: boolean };
}

export interface VerificationResult {
  schemaVersion: 1;
  outcome: 'pass' | 'block' | 'incomplete';
  profile: 'changed' | 'full';
  root?: string;
  base?: string;
  snapshot?: string;
  scope: 'files' | 'project' | 'none';
  files: string[];
  analyzers: AnalyzerResult[];
  findings: Finding[];
  errors: string[];
  resolved?: string[];
  runId?: string;
  configuration?: string;
}
