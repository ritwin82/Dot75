import type { ValidationResult } from "@localmesh/shared";
export interface ActionEnvelope {
  version: 1;
  repository: string;
  runId: number;
  runAttempt: number;
  event: "pull_request" | "push" | "merge_group";
  baseRef: string;
  baseSha: string;
  queueBaseSha?: string;
  targets: Array<{ prNumber: number; headSha: string; baseSha: string; result: ValidationResult }>;
  error?: string;
}
