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

export type ObjectKind = "table" | "partition" | "column" | "constraint" | "index" | "view" | "materialized_view" | "sequence" | "domain" | "composite" | "function" | "procedure" | "trigger" | "policy" | "collation" | "extension" | "enum" | "publication";

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

export interface DataTableState { table: string; rowCount: number; fingerprint: string; sampleRows?: Array<Record<string,unknown>> }
export interface DataSequenceState { sequence:string;lastValue?:string;isCalled:boolean }
export interface DataStateSnapshot { fingerprint: string; tables: DataTableState[];sequences?:DataSequenceState[] }
export interface DataStateDifference { table: string; first?: DataTableState; second?: DataTableState }

export interface Finding {
  code: string;
  severity: Severity;
  title: string;
  message: string;
  evidence?: Record<string, unknown>;
  file?: string;
  line?: number;
}

export type CompatibilityStatus = "compatible" | "conflict" | "order_sensitive" | "independent" | "standalone_invalid" | "untested";

export interface CompatibilityRelationship {
  pullRequests: [number, number];
  status: CompatibilityStatus;
  testedOrders: number[][];
  passingOrder?: number[];
  findingCodes: string[];
  reason: string;
  sourceJobId?: string;
  observedAt?: string;
}

export interface CompatibilityNode {
  pr: number;
  title?: string;
  author?: string;
  headSha?: string;
  standalone: "passed" | "failed" | "unknown";
}

export interface CompatibilityGraphSnapshot {
  repository: string;
  baseSha: string;
  generatedAt: string;
  nodes: CompatibilityNode[];
  edges: CompatibilityRelationship[];
  coverage: { possiblePairs: number; classifiedPairs: number; missingPairs: number };
}

export interface FindingRecurrence {
  fingerprint: string;
  code: string;
  title: string;
  category: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  active: boolean;
  pullRequests: number[];
  jobIds: string[];
}

export interface RecurrenceSnapshot { repository: string; generatedAt: string; findings: FindingRecurrence[] }

export interface OrderResult {
  order: number[];
  passed: boolean;
  findings: Finding[];
  finalFingerprint?: string;
  durationMs: number;
  sqlPassed?: boolean;
  contractsChecked?: boolean;
  snapshot?: SchemaSnapshot;
  affectedObjects?: SchemaObject[];
  dataState?: DataStateSnapshot;
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
  dataDifferences?: DataStateDifference[];
  groupCoverage?: { tested: number[][]; untested: number[][]; permutationBudget: number };
  compatibility?: CompatibilityRelationship[];
  explanation?: AiExplanation;
  explanationStatus?: "pending" | "complete";
  provenance?: {
    pullRequests: Array<{ number: number; author: string; headSha: string; title?: string }>;
    currentPrFiles: string[];
    trigger?: string;
    inputDigest?: string;
    engineVersion?: string;
  };
  scope?: { candidatePrs: number[]; skippedPrs: number[]; contractMappings: number; fixtureFiles: number; rollbackChecked: boolean; decisions?: Array<{ pr: number; decision: "tested" | "skipped"; reason: string }> };
  links?: { check?: string; investigation?: string; replay?: string };
}

export interface AiExplanation {
  cause: string;
  conflictingObjects: string[];
  forwardFix: string;
  rollbackFix: string;
  confidence: "low" | "medium" | "high";
  assumptions: string[];
  source: "ollama" | "deterministic";
  model?: string;
  durationMs?: number;
  fallbackReason?: string;
  cached?: boolean;
}

export interface RemediationPatch { path: string; sql: string }
export interface RemediationCandidate {
  id: string;
  title: string;
  rationale: string;
  patches: RemediationPatch[];
  assumptions: string[];
  status: "pending" | "verified" | "rejected" | "invalid";
  verification?: ValidationResult;
  rejectionReason?: string;
}
export interface RemediationAttempt {
  status: "complete" | "not_needed" | "unavailable";
  sourceDigest: string;
  promptVersion: string;
  model?: string;
  durationMs: number;
  candidates: RemediationCandidate[];
  error?: string;
}

export interface ValidationJob {
  id: string;
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  engineVersion?: string;
  checkRunId?: number;
}
