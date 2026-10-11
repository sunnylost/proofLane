export interface Finding {
  id: string;
  source: 'oxlint';
  rule: string;
  category: 'lint';
  severity: 'error' | 'warning' | 'info';
  confidence: 'medium';
  status: 'unclassified';
  message: string;
  location: { file: string; line?: number; column?: number };
}

export interface AnalyzerResult {
  name: 'oxlint';
  status: 'completed' | 'skipped' | 'failed';
  reason: string;
  version?: string;
  filesChecked?: number;
  durationMs?: number;
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
}
