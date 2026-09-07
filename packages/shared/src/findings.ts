import type { Finding } from "./types.js";

export function uniqueFindings(findings: Finding[]): Finding[] {
  return [...new Map(findings.map((f) => [JSON.stringify([f.code, f.severity, f.message, f.file, f.evidence]), f])).values()];
}

export function findingCategory(code: string): string {
  if (code.startsWith("DATA_") || code === "FIXTURES_REQUIRED") return "Data contract";
  if (code.startsWith("CONTRACT_") || code === "RLS_POLICY_MISSING") return "Schema contract";
  if (code.startsWith("ROLLBACK_") || code === "NO_DOWN_MIGRATION") return "Rollback";
  if (code === "ORDER_SCHEMA_DIVERGENCE") return "Merge order";
  if (/^[0-9A-Z]{5}$/.test(code)) return "PostgreSQL";
  return "Migration risk";
}

export function findingGuidance(code: string): { impact: string; action: string } {
  if (code === "42701") return { impact: "Both migrations try to own the same column. The second migration cannot run.", action: "Agree on one column definition and remove or rename the duplicate change." };
  if (code === "42703") return { impact: "A migration references a column that is missing in this merge order.", action: "Keep the old column until dependent migrations and application code have moved to its replacement." };
  if (code === "ORDER_SCHEMA_DIVERGENCE") return { impact: "SQL executes in both orders, but the resulting database definitions differ.", action: "Choose one intended definition, consolidate the overlapping changes, then test both orders again." };
  if (code === "DATA_CONTRACT_FAILED") return { impact: "The resulting test data violates a business rule, even if every SQL statement succeeds.", action: "Correct the data-changing migration or its guard conditions, then rerun with the committed fixtures." };
  if (code.startsWith("CONTRACT_") || code === "RLS_POLICY_MISSING") return { impact: "The schema no longer satisfies a committed application requirement.", action: "Restore the required object or coordinate a reviewed contract change with the application migration." };
  if (code.startsWith("ROLLBACK_") || code === "NO_DOWN_MIGRATION") return { impact: "Rollback is missing or does not restore the tested starting state.", action: "Provide a matching down migration and verify both schema and fixture data are restored." };
  if (code === "FIXTURES_REQUIRED" || code === "DATA_CONTRACT_ERROR") return { impact: "The data contract could not be verified.", action: "Check the fixture SQL and contract bindings; rerun before trusting the data checks." };
  return { impact: "Review the recorded database evidence and affected migration.", action: "Correct the reported operation and rerun the same PR order before merging." };
}
