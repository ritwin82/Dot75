import { runDataContracts, validateSchemaContracts, type ContractMappings } from "@localmesh/contracts";
import { analyzePerformance } from "./performance.js";
import { areRelated } from "./relations.js";
import { PostgresValidationEnvironment } from "./runtime.js";
import { summarizePullRequestChange } from "./migration-summary.js";
import { deriveCompatibilityRelationships, uniqueFindings, type DataStateDifference, type DataStateSnapshot, type Finding, type MigrationFile, type OperationalMetadata, type OrderResult, type ValidationJob, type ValidationResult } from "@localmesh/shared";

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
  compareDataState?: boolean;
  excludeDataColumns?: string[];
  maxDataDifferences?: number;
  maxGroupSize?: number;
  maxGroupPermutations?: number;
  metadata?: OperationalMetadata;
}

export function dataStateDifferences(first:DataStateSnapshot,second:DataStateSnapshot,limit=20):DataStateDifference[]{
  const sequenceTable=(state:NonNullable<DataStateSnapshot["sequences"]>[number])=>({table:`sequence:${state.sequence}`,rowCount:state.isCalled?1:0,fingerprint:state.lastValue??"not-called",sampleRows:[{lastValue:state.lastValue??null,isCalled:state.isCalled}]});
  const a=new Map([...first.tables,...(first.sequences??[]).map(sequenceTable)].map((table)=>[table.table,table]));const b=new Map([...second.tables,...(second.sequences??[]).map(sequenceTable)].map((table)=>[table.table,table]));
  return [...new Set([...a.keys(),...b.keys()])].filter((table)=>a.get(table)?.fingerprint!==b.get(table)?.fingerprint||a.get(table)?.rowCount!==b.get(table)?.rowCount)
    .slice(0,limit).map((table)=>({table,...(a.get(table)?{first:a.get(table)!}:{}),...(b.get(table)?{second:b.get(table)!}:{})}));
}

function permutations<T>(items:T[]):T[][]{return items.length<2?[items]:items.flatMap((item,index)=>permutations([...items.slice(0,index),...items.slice(index+1)]).map((rest)=>[item,...rest]));}

// The GitHub worker and local demo execute this same plan. Each single-PR run
// supplies both dependency inspection and validation, avoiding a duplicate replay.
export async function runValidationPlan(environment: PostgresValidationEnvironment, job: ValidationJob, plan: ValidationPlan): Promise<ValidationResult> {
  const startedAt = new Date().toISOString();
  const maxDataDifferences=plan.maxDataDifferences??20;const maxGroupSize=plan.maxGroupSize??3;const maxGroupPermutations=plan.maxGroupPermutations??20;
  const options: Parameters<PostgresValidationEnvironment["executeOrder"]>[3] = { fixtures: plan.fixtures, compareDataState:plan.compareDataState??true, excludeDataColumns:plan.excludeDataColumns??[] };
  const enabledMappings = (plan.mappings?.mappings?.filter((mapping) => mapping.enabled !== false).length ?? 0)
    + (plan.mappings?.schema_assertions?.length ?? 0) + (plan.mappings?.sql_assertions?.length ?? 0);
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
  const dataDifferences:DataStateDifference[]=[];
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
    if(ab.sqlPassed&&ba.sqlPassed&&ab.dataState&&ba.dataState&&ab.dataState.fingerprint!==ba.dataState.fingerprint){
      const differences=dataStateDifferences(ab.dataState,ba.dataState,maxDataDifferences);dataDifferences.push(...differences);
      const finding:Finding={code:"ORDER_DATA_DIVERGENCE",severity:"error",title:"Migration order changes fixture-backed data",message:`PR #${plan.current.pr} and PR #${candidate.pr} both execute, but produce different row state.`,evidence:{objects:differences.map((difference)=>`table:${difference.table}`),differences}};
      ab.findings.push(finding);ba.findings.push(finding);ab.passed=false;ba.passed=false;
    }
    orders.push(ab, ba);
  }
  const testedGroups:number[][]=[];const untestedGroups:number[][]=[];
  if(maxGroupSize>=3&&maxGroupPermutations>0){
    const related=plan.candidates.filter((candidate)=>compared.includes(candidate.pr));let remaining=maxGroupPermutations;
    for(let i=0;i<related.length;i++)for(let j=i+1;j<related.length;j++){
      const groupPermutations=permutations([plan.current,related[i]!,related[j]!]);const executed:OrderResult[]=[];
      for(const sequence of groupPermutations){if(remaining<=0){untestedGroups.push(sequence.map((group)=>group.pr));continue;}const outcome=await environment.executeOrder(plan.baseline,sequence,plan.extensions,options);orders.push(outcome);executed.push(outcome);testedGroups.push(outcome.order);remaining--;}
      const successful=executed.filter((outcome)=>outcome.sqlPassed);const schemaFingerprints=new Set(successful.map((outcome)=>outcome.finalFingerprint));const dataFingerprints=new Set(successful.map((outcome)=>outcome.dataState?.fingerprint));
      if(schemaFingerprints.size>1||dataFingerprints.size>1){const finding:Finding={code:schemaFingerprints.size>1?"GROUP_SCHEMA_DIVERGENCE":"GROUP_DATA_DIVERGENCE",severity:"error",title:"Three-PR order changes the final database state",message:`The tested permutations of PRs ${[plan.current,related[i]!,related[j]!].map((group)=>`#${group.pr}`).join(", ")} do not produce one deterministic final state.`};for(const outcome of executed){outcome.findings.push(finding);outcome.passed=false;}}
    }
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
  const result: ValidationResult = {
    jobId: job.id, repository: `${job.owner}/${job.repo}`, currentPr: job.prNumber, baseSha: job.baseSha, headSha: job.headSha,
    status: failure ? "failed" : "passed", startedAt, completedAt: new Date().toISOString(),
    affectedObjects: [...affected.values()], dependencies: current.snapshot?.edges ?? [], comparedPullRequests: compared,
    orders: orders.map(({ snapshot: _snapshot, ...order }) => order), contracts, rollbacks, dataDifferences,
    pullRequestChanges: [
      summarizePullRequestChange(plan.current.pr, plan.current.files, current.affectedObjects ?? []),
      ...plan.candidates.filter((candidate) => compared.includes(candidate.pr)).map((candidate) => {
        const standalone = orders.find((order) => order.order.length === 1 && order.order[0] === candidate.pr);
        return summarizePullRequestChange(candidate.pr, candidate.files, standalone?.affectedObjects ?? []);
      })
    ],
    performance: analyzePerformance(plan.current.files, plan.metadata ?? []),
    groupCoverage:{tested:testedGroups,untested:untestedGroups,permutationBudget:maxGroupPermutations},
    scope: { candidatePrs: plan.candidates.map((candidate) => candidate.pr), skippedPrs: skipped, contractMappings: enabledMappings, fixtureFiles: plan.fixtures.length, rollbackChecked: plan.verifyRollback && !!current.sqlPassed, decisions }
  };
  result.compatibility = deriveCompatibilityRelationships(result);
  return result;
}

export function resultFindings(result: ValidationResult): Finding[] {
  return uniqueFindings([...result.orders.flatMap((order) => order.findings), ...result.contracts, ...result.rollbacks.flatMap((rollback) => rollback.findings), ...result.performance]);
}

export function explanationContext(plan: ValidationPlan, result: ValidationResult): string {
  const groups = [plan.current, ...plan.candidates.filter((candidate) => result.comparedPullRequests.includes(candidate.pr))];
  return JSON.stringify({ scope: result.scope, orders: result.orders.map(({ order, passed, sqlPassed }) => ({ order, passed, sqlPassed })), pullRequestChanges: result.pullRequestChanges, migrations: groups.map((group) => ({ pr: group.pr, files: group.files.map(({ path, sql }) => ({ path, sql })) })), baselineSql: plan.baseline.map((file) => file.sql).join("\n").slice(0, 4000), testFixtures: plan.fixtures.join("\n").slice(0, 2000), rollbackResults: result.rollbacks });
}
