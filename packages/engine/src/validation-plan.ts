import { runDataContracts, validateSchemaContracts, type ContractMappings } from "@localmesh/contracts";
import { analyzePerformance } from "./performance.js";
import { areRelated } from "./relations.js";
import { PostgresValidationEnvironment } from "./runtime.js";
import { uniqueFindings, type Finding, type MigrationFile, type OperationalMetadata, type OrderResult, type ValidationJob, type ValidationResult } from "@localmesh/shared";

export interface MigrationGroup { pr: number; files: MigrationFile[] }
export interface ValidationPlan {
  baseline: MigrationFile[];
  current: MigrationGroup;
  candidates: MigrationGroup[];
  extensions: string[];
  mappings?: ContractMappings;
  fixtures: string[];
  requireDataContracts: boolean;
  verifyRollback: boolean;
  metadata?: OperationalMetadata;
}

// The GitHub worker and local demo execute this same plan. Each single-PR run
// supplies both dependency inspection and validation, avoiding a duplicate replay.
export async function runValidationPlan(environment: PostgresValidationEnvironment, job: ValidationJob, plan: ValidationPlan): Promise<ValidationResult> {
  const startedAt = new Date().toISOString();
  const options: Parameters<PostgresValidationEnvironment["executeOrder"]>[3] = { fixtures: plan.fixtures };
  const enabledMappings = plan.mappings?.mappings.filter((mapping) => mapping.enabled).length ?? 0;
  if (enabledMappings) options.verify = async (pool, snapshot) => {
    const schema = validateSchemaContracts(snapshot.objects, plan.mappings!);
    // Missing schema objects already explain why data checks cannot run.
    if (schema.some((finding) => finding.severity === "error")) return schema;
    return [...schema, ...await runDataContracts(pool, plan.mappings!)];
  };
  const current = await environment.executeOrder(plan.baseline, [plan.current], plan.extensions, options);
  const orders: OrderResult[] = [current];
  const compared: number[] = [];
  const skipped: number[] = [];
  const decisions: Array<{ pr: number; decision: "tested" | "skipped"; reason: string }> = [];
  const affected = new Map((current.affectedObjects ?? []).map((object) => [object.id, object]));
  for (const candidate of plan.candidates) {
    const single = await environment.executeOrder(plan.baseline, [candidate], plan.extensions, options);
    const related = enabledMappings > 0 || !current.passed || !single.passed || areRelated(
      { pr: plan.current.pr, objects: current.affectedObjects ?? [], edges: current.snapshot?.edges ?? [] },
      { pr: candidate.pr, objects: single.affectedObjects ?? [], edges: single.snapshot?.edges ?? [] }
    );
    const reason = enabledMappings > 0 ? "Committed contracts require combined validation."
      : !current.passed || !single.passed ? "A single-PR run failed; compare conservatively to expose the interaction."
      : !(current.affectedObjects?.length) || !(single.affectedObjects?.length) ? "Catalog changes alone cannot establish independence, including data-only migrations."
      : related ? "Changed schema objects share a relation or an inspected dependency."
      : "Both PRs passed alone and their inspected schema objects and dependencies do not overlap.";
    decisions.push({ pr: candidate.pr, decision: related ? "tested" : "skipped", reason });
    if (!related) { skipped.push(candidate.pr); continue; }
    compared.push(candidate.pr);
    orders.push(single);
    for (const object of single.affectedObjects ?? []) affected.set(object.id, object);
    // Bounded concurrency: at most two independent databases per comparison.
    const [ab, ba] = await Promise.all([
      environment.executeOrder(plan.baseline, [plan.current, candidate], plan.extensions, options),
      environment.executeOrder(plan.baseline, [candidate, plan.current], plan.extensions, options)
    ]);
    if (ab.sqlPassed && ba.sqlPassed && ab.finalFingerprint !== ba.finalFingerprint) {
      const abObjects = new Map((ab.snapshot?.objects ?? []).map((object) => [object.id, object.definition]));
      const baObjects = new Map((ba.snapshot?.objects ?? []).map((object) => [object.id, object.definition]));
      const finding: Finding = { code: "ORDER_SCHEMA_DIVERGENCE", severity: "error", title: "Migration order changes the final schema",
        message: `PR #${plan.current.pr} and PR #${candidate.pr} both execute, but produce different catalog fingerprints.`,
        evidence: { objects: [...affected.keys()], ab: ab.finalFingerprint, ba: ba.finalFingerprint,
          differences: [...new Set([...abObjects.keys(), ...baObjects.keys()])].map((id) => ({ id, ab: abObjects.get(id), ba: baObjects.get(id) })).filter((object) => object.ab !== object.ba) } };
      ab.findings.push(finding); ba.findings.push(finding); ab.passed = false; ba.passed = false;
    }
    orders.push(ab, ba);
  }
  const contracts: Finding[] = [];
  if (plan.requireDataContracts && !enabledMappings) contracts.push({ code: "CONTRACT_BINDING_MISSING", severity: "error", title: "Data contracts were required but not configured", message: "Commit at least one enabled contract mapping before validation can pass." });
  if (plan.requireDataContracts && !plan.fixtures.length) contracts.push({ code: "FIXTURES_REQUIRED", severity: "error", title: "Data fixtures are required", message: "No committed baseline fixtures were provided for the required data checks." });
  const rollbacks = [];
  if (plan.verifyRollback && current.sqlPassed) {
    const previous: MigrationFile[] = [];
    for (const up of plan.current.files.filter((file) => file.direction === "up").sort((a, b) => a.order - b.order || a.path.localeCompare(b.path))) {
      const down = plan.current.files.find((file) => file.path === up.path.replace(/\.up\.sql$/, ".down.sql"));
      rollbacks.push(await environment.verifyRollback(plan.baseline, up, down, plan.extensions, plan.fixtures, previous));
      previous.push(up);
    }
  }
  const failure = [...orders.flatMap((order) => order.findings), ...contracts, ...rollbacks.flatMap((rollback) => rollback.findings)].some((finding) => finding.severity === "error");
  return {
    jobId: job.id, repository: `${job.owner}/${job.repo}`, currentPr: job.prNumber, baseSha: job.baseSha, headSha: job.headSha,
    status: failure ? "failed" : "passed", startedAt, completedAt: new Date().toISOString(),
    affectedObjects: [...affected.values()], dependencies: current.snapshot?.edges ?? [], comparedPullRequests: compared,
    orders: orders.map(({ snapshot: _snapshot, affectedObjects: _affected, ...order }) => order), contracts, rollbacks,
    performance: analyzePerformance(plan.current.files, plan.metadata ?? []),
    scope: { candidatePrs: plan.candidates.map((candidate) => candidate.pr), skippedPrs: skipped, contractMappings: enabledMappings, fixtureFiles: plan.fixtures.length, rollbackChecked: plan.verifyRollback && !!current.sqlPassed, decisions }
  };
}

export function resultFindings(result: ValidationResult): Finding[] {
  return uniqueFindings([...result.orders.flatMap((order) => order.findings), ...result.contracts, ...result.rollbacks.flatMap((rollback) => rollback.findings), ...result.performance]);
}

export function explanationContext(plan: ValidationPlan, result: ValidationResult): string {
  const groups = [plan.current, ...plan.candidates.filter((candidate) => result.comparedPullRequests.includes(candidate.pr))];
  return JSON.stringify({ scope: result.scope, orders: result.orders.map(({ order, passed, sqlPassed }) => ({ order, passed, sqlPassed })), migrations: groups.map((group) => ({ pr: group.pr, files: group.files.map(({ path, sql }) => ({ path, sql })) })), baselineSql: plan.baseline.map((file) => file.sql).join("\n").slice(0, 4000), testFixtures: plan.fixtures.join("\n").slice(0, 2000), rollbackResults: result.rollbacks });
}
