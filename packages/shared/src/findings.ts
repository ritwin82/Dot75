import { createHash } from "node:crypto";
import type { Finding } from "./types.js";

export function findingFingerprint(finding: Finding): string {
  const objects = Array.isArray(finding.evidence?.objects) ? finding.evidence.objects.filter((value): value is string => typeof value === "string").sort() : [];
  const contract = typeof finding.evidence?.template === "string" ? finding.evidence.template : "";
  const relation = typeof finding.evidence?.relation === "string" ? finding.evidence.relation : "";
  return createHash("sha256").update(JSON.stringify([finding.code, findingCategory(finding.code), objects, contract, relation])).digest("hex");
}

export function uniqueFindings(findings: Finding[]): Finding[] {
  return [...new Map(findings.map((f) => [JSON.stringify([f.code, f.severity, f.message, f.file, f.evidence]), f])).values()];
}

export function findingCategory(code: string): string {
  if (code.startsWith("DATA_") || code === "FIXTURES_REQUIRED") return "Data contract";
  if (code.startsWith("CONTRACT_") || code === "RLS_POLICY_MISSING") return "Schema contract";
  if (code.startsWith("ROLLBACK_") || code === "NO_DOWN_MIGRATION") return "Rollback";
  if (code === "ORDER_SCHEMA_DIVERGENCE") return "Merge order";
  if (code === "ORDER_DATA_DIVERGENCE" || code === "GROUP_DATA_DIVERGENCE") return "Data compatibility";
  if (code.startsWith("CUSTOM_")) return "Custom contract";
  if (/^[0-9A-Z]{5}$/.test(code)) return "PostgreSQL";
  return "Migration risk";
}

export interface FindingGuidance {
  cause: string;
  impact: string;
  action: string;
  steps: string[];
  verification: string;
}

const guidance = (cause: string, impact: string, action: string, steps: string[], verification: string): FindingGuidance => ({ cause, impact, action, steps, verification });

export function findingGuidance(code: string): FindingGuidance {
  if (code === "42701") return guidance(
    "Two pull requests define a column with the same table and column name. PostgreSQL accepts the first definition and rejects the second as a duplicate.",
    "The second migration stops immediately, so later statements in that file do not run and the combined deployment cannot complete.",
    "Choose one owner and one final definition for the column, then remove or rename the duplicate operation in the other pull request.",
    ["Compare the column type, nullability, default, and constraints in both PRs.", "Move the agreed definition into the PR that should create the column.", "Change the other PR to depend on that column instead of creating it again.", "Update its down migration so it only removes objects that PR still owns."],
    "Rerun both PR orders. Both SQL executions must pass and the final schema fingerprints must match."
  );
  if (code === "42703") return guidance(
    "One pull request removes or renames a column while another pull request still references that original column.",
    "The dependent index, constraint, view, or data statement fails in the order where the column disappears first.",
    "Keep the original column available until every dependent migration and application release has moved to its replacement.",
    ["Open the failing SQL file and identify the statement that references the missing column.", "Find the PR that drops or renames that column.", "Use an expand-and-contract rollout: add the replacement, migrate consumers, then remove the old column in a later PR.", "Add matching down migrations for each stage."],
    "Test both orders again and confirm the dependent object exists after each order and each rollback restores the starting state."
  );
  if (code === "ORDER_SCHEMA_DIVERGENCE") return guidance(
    "Both merge orders execute, but overlapping schema changes use last-writer-wins behavior and leave different database definitions.",
    "The final database depends on which PR merges first. Two environments can therefore run the same migrations and end with different defaults, constraints, indexes, or types.",
    "Agree on one intended final definition and encode it in a single authoritative migration.",
    ["Expand the database evidence to compare the exact object definition produced by each order.", "Ask the two PR owners to choose the intended final definition.", "Keep that definition in one migration and remove or revise the competing statement.", "Align both down migrations with the ownership of the final change."],
    "Rerun both orders. SQL must pass, the final schema fingerprints must be identical, and the rollback check must restore schema and fixture data."
  );
  if (code === "ORDER_DATA_DIVERGENCE" || code === "GROUP_DATA_DIVERGENCE") return guidance(
    "The SQL succeeds, but the data updates produce different rows or sequence positions depending on execution order.",
    "Application behavior can vary between environments even though deployment reports no PostgreSQL error.",
    "Rewrite the data changes so repeated or reordered execution reaches the same intended data state.",
    ["Inspect the recorded table and row fingerprints for each order.", "Replace relative or destructive updates with guarded, idempotent statements where possible.", "If order is required, encode an explicit dependency and merge sequence.", "Add representative fixture rows for boundary and repeated-run cases."],
    "Rerun all recorded orders and confirm identical row counts, row fingerprints, sequence state, and contract results."
  );
  if (code.startsWith("CUSTOM_")) return guidance(
    "A repository-defined SQL assertion returned a failing result.",
    "The database violates an invariant that this repository explicitly requires.",
    "Correct the migration or update the invariant through a separately reviewed contract change.",
    ["Read the assertion name and evidence.", "Determine which migration changed the asserted object or data.", "Correct that migration without weakening unrelated checks.", "Only change the contract when the application requirement itself has intentionally changed."],
    "Rerun the assertion against the same fixtures and confirm it passes in every tested merge order."
  );
  if (code === "DATA_CONTRACT_FAILED") return guidance(
    "A migration produced fixture-backed rows that violate a configured business rule.",
    "The SQL is syntactically valid, but the resulting rows violate a business rule and the application could receive invalid inventory, status, ownership, or relationship data.",
    "Correct the data-changing migration or its guard conditions while preserving the committed contract.",
    ["Inspect the failing contract and fixture rows.", "Identify which PR changed the violating values.", "Add bounds, predicates, or a staged backfill that preserves the invariant.", "Extend fixtures to include the failing edge case."],
    "Rerun the contract for each individual PR and every combined order; all must pass against the committed fixtures."
  );
  if (code.startsWith("CONTRACT_") || code === "RLS_POLICY_MISSING") return guidance(
    "The resulting schema no longer contains an object or property required by a committed application contract.",
    "Application code may fail after deployment even when PostgreSQL accepts every migration statement.",
    "Restore the required schema object or coordinate the schema and contract change with the application release.",
    ["Open the contract binding and identify the required table, column, constraint, or policy.", "Find the migration that removes or changes it.", "Stage a compatible replacement before removing the old object.", "Update the contract only alongside the application change that consumes the new schema."],
    "Rerun schema and data contracts in each order and verify the application-facing binding resolves successfully."
  );
  if (code.startsWith("ROLLBACK_") || code === "NO_DOWN_MIGRATION") return guidance(
    "The down migration is missing, fails to execute, or leaves schema or fixture data different from the state before the up migration.",
    "A failed release cannot be safely reversed using the recorded rollback procedure.",
    "Provide a matching down migration that reverses the objects and data owned by the up migration.",
    ["Compare the recorded before and after fingerprints.", "Inspect changed objects or rows that remain after the down migration.", "Correct the down SQL without removing pre-existing objects or data.", "Include fixtures that prove important data can be restored or explicitly document an irreversible operation."],
    "Apply baseline and fixtures, run the up migration, run its down migration, and confirm both schema and data fingerprints return to their original values."
  );
  if (code === "FIXTURES_REQUIRED" || code === "DATA_CONTRACT_ERROR") return guidance(
    "The configured data check could not execute with a valid fixture and contract setup.",
    "The result cannot establish that migrated data satisfies application rules.",
    "Correct the fixture SQL and contract bindings before relying on the data verdict.",
    ["Confirm at least one representative fixture file is discovered.", "Validate table and column bindings against the baseline schema.", "Run the contract query directly against the isolated test database.", "Commit the corrected fixtures and mapping with the migration."],
    "Rerun until the dashboard reports fixture files loaded and configured contracts checked for each successful SQL order."
  );
  return guidance(
    "A deterministic database check reported a problem in the recorded migration order.",
    "The tested deployment cannot be considered safe until the recorded evidence is resolved.",
    "Correct the reported operation and rerun the same PR order before merging.",
    ["Open the migration location and database evidence.", "Identify the PR and object responsible for the finding.", "Make the smallest coordinated schema or data correction.", "Update rollback SQL and fixtures when the change affects them."],
    "Repeat the exact failing order and confirm SQL, contracts, final state, and rollback checks all pass."
  );
}
