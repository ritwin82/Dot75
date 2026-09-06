export type Severity = "info" | "warning" | "error";
export type CheckStatus = "queued" | "running" | "passed" | "failed" | "cancelled";

export interface MigrationFile {
  path: string;
  sql: string;
  direction: "up" | "down";
  order: number;
}

export interface PullRequestRef {
  number: number;
  title: string;
  headSha: string;
  baseSha: string;
  author: string;
  migrations: MigrationFile[];
}

export type ObjectKind = "table" | "column" | "constraint" | "index" | "view" | "function" | "trigger" | "policy" | "extension" | "enum";

export interface SchemaObject {
  id: string;
  kind: ObjectKind;
  schema?: string;
  relation?: string;
  name: string;
  definition: string;
}

export interface DependencyEdge { from: string; to: string; type: string }
export interface SchemaSnapshot { objects: SchemaObject[]; edges: DependencyEdge[]; fingerprint: string }

export interface Finding {
  code: string;
  severity: Severity;
  title: string;
  message: string;
  evidence?: Record<string, unknown>;
  file?: string;
  line?: number;
}

export interface OrderResult {
  order: number[];
  passed: boolean;
  findings: Finding[];
  finalFingerprint?: string;
  durationMs: number;
}

export interface RollbackResult {
  migration: string;
  status: "safe" | "unsafe" | "non_reversible";
  schemaRestored: boolean;
  dataRestored?: boolean;
  findings: Finding[];
}

export interface ValidationResult {
  jobId: string;
  status: CheckStatus;
  repository: string;
  currentPr: number;
  baseSha: string;
  headSha: string;
  startedAt: string;
  completedAt?: string;
  affectedObjects: SchemaObject[];
  dependencies: DependencyEdge[];
  comparedPullRequests: number[];
  orders: OrderResult[];
  contracts: Finding[];
  rollbacks: RollbackResult[];
  performance: Finding[];
  explanation?: AiExplanation;
}

export interface AiExplanation {
  cause: string;
  conflictingObjects: string[];
  forwardFix: string;
  rollbackFix: string;
  confidence: "low" | "medium" | "high";
  assumptions: string[];
  source: "ollama" | "deterministic";
}

export interface ValidationJob {
  id: string;
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  checkRunId?: number;
}
