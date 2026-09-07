import type { Octokit } from "@octokit/rest";
import { z } from "zod";
import { getTextFile, updateCheck, upsertStickyComment } from "@localmesh/github";
import { ENGINE_VERSION, type AiExplanation, type PublishedActionResult, type ValidationResult } from "@localmesh/shared";
import type { ActionEnvelope } from "./types.js";

const sha = z.string().regex(/^[a-f0-9]{40}$/i);
const boundedText = z.string().max(65_000);
const prNumber = z.number().int().nonnegative();
const filePath = z.string().min(1).max(4096).refine((value) => !value.startsWith("/") && !value.includes("\\") && !value.split("/").includes("..") && !value.includes(":"), "Expected a repository-relative path");
const finding = z.object({ code: boundedText, severity: z.enum(["info", "warning", "error"]), title: boundedText, message: boundedText,
  file: filePath.optional(), line: z.number().int().positive().optional(), evidence: z.record(z.string(), z.unknown()).optional() });
const findings = z.array(finding).max(5000);
const dataTableState = z.object({ table: boundedText, rowCount: z.number().int().nonnegative(), fingerprint: boundedText, sampleRows: z.array(z.record(z.string(), z.unknown())).max(5).optional() });
const dataState = z.object({ fingerprint: boundedText, tables: z.array(dataTableState).max(20_000), sequences: z.array(z.object({ sequence: boundedText, lastValue: boundedText.optional(), isCalled: z.boolean() })).max(20_000).optional() });
const object = z.object({ id: boundedText, kind: z.enum(["table", "partition", "column", "constraint", "index", "view", "materialized_view", "sequence", "domain", "composite", "function", "procedure", "trigger", "policy", "collation", "extension", "enum", "publication"]),
  schema: boundedText.optional(), relation: boundedText.optional(), name: boundedText, definition: boundedText });
const operation = z.object({ file: filePath, action: z.enum(["create", "alter", "add", "drop", "rename", "insert", "update", "delete", "execute"]),
  objectKind: z.enum(["table", "column", "index", "constraint", "type", "view", "function", "data", "statement"]), objectName: boundedText, description: boundedText });
const explanation = z.object({ cause: boundedText, conflictingObjects: z.array(boundedText).max(100), forwardFix: boundedText, rollbackFix: boundedText,
  confidence: z.enum(["low", "medium", "high"]), assumptions: z.array(boundedText).max(100), source: z.enum(["ollama", "deterministic"]), model: boundedText.optional(),
  durationMs: z.number().nonnegative().optional(), fallbackReason: boundedText.optional(), cached: z.boolean().optional() });
const resultSchema = z.object({
  jobId: boundedText, repository: boundedText, currentPr: prNumber, baseSha: sha, headSha: sha,
  status: z.enum(["passed", "failed", "cancelled"]), startedAt: boundedText, completedAt: boundedText.optional(),
  affectedObjects: z.array(object).max(20_000), dependencies: z.array(z.object({ from: boundedText, to: boundedText, type: boundedText })).max(50_000),
  comparedPullRequests: z.array(prNumber).max(2000),
  orders: z.array(z.object({ order: z.array(prNumber).min(1).max(2000), passed: z.boolean(), findings,
    durationMs: z.number().nonnegative(), sqlPassed: z.boolean().optional(), contractsChecked: z.boolean().optional(), finalFingerprint: boundedText.optional(), dataState: dataState.optional(),
    affectedObjects: z.array(object).max(20_000).optional() })).max(10_000),
  contracts: findings, performance: findings,
  rollbacks: z.array(z.object({ migration: boundedText, status: z.enum(["safe", "unsafe", "non_reversible"]), schemaRestored: z.boolean(), dataRestored: z.boolean().optional(), findings })).max(5000),
  compatibility: z.array(z.object({ pullRequests: z.tuple([prNumber, prNumber]), status: z.enum(["compatible", "conflict", "order_sensitive", "independent", "standalone_invalid", "untested"]),
    testedOrders: z.array(z.array(prNumber).max(2000)).max(2000), passingOrder: z.array(prNumber).max(2000).optional(), findingCodes: z.array(boundedText).max(5000), reason: boundedText,
    sourceJobId: boundedText.optional(), observedAt: boundedText.optional() })).max(5000).optional(),
  dataDifferences: z.array(z.object({ table: boundedText, first: dataTableState.optional(), second: dataTableState.optional() })).max(20_000).optional(),
  groupCoverage: z.object({ tested: z.array(z.array(prNumber).max(3)).max(1000), untested: z.array(z.array(prNumber).max(3)).max(1000), permutationBudget: z.number().int().nonnegative() }).optional(),
  pullRequestChanges: z.array(z.object({ pr: prNumber, migrationFiles: z.array(filePath).max(5000), operations: z.array(operation).max(100),
    affectedObjects: z.array(z.object({ id: boundedText, kind: object.shape.kind })).max(20_000) })).max(2000).optional(),
  explanation: explanation.optional(), explanationStatus: z.enum(["pending", "complete"]).optional(),
  provenance: z.object({ pullRequests: z.array(z.object({ number: prNumber, author: boundedText, headSha: sha, title: boundedText.optional() })).max(2000),
    currentPrFiles: z.array(filePath).max(5000), trigger: boundedText.optional(), inputDigest: boundedText.optional(), engineVersion: boundedText.optional() }).optional(),
  scope: z.object({ candidatePrs: z.array(prNumber).max(2000), skippedPrs: z.array(prNumber).max(2000), contractMappings: z.number().int().nonnegative(), fixtureFiles: z.number().int().nonnegative(), rollbackChecked: z.boolean(),
    decisions: z.array(z.object({ pr: prNumber, decision: z.enum(["tested", "skipped"]), reason: boundedText })).max(2000).optional() }).optional(),
  links: z.object({ check: boundedText.optional(), investigation: boundedText.optional(), replay: boundedText.optional() }).optional()
});

const envelopeSchema = z.object({ version: z.literal(1), repository: boundedText, runId: z.number().int().positive(), runAttempt: z.number().int().positive(),
  event: z.enum(["pull_request", "push", "merge_group"]), baseRef: z.string().min(1).max(1024), baseSha: sha, queueBaseSha: sha.optional(),
  targets: z.array(z.object({ prNumber, headSha: sha, baseSha: sha, result: resultSchema })).max(2000), error: boundedText.optional() });

export interface PublishContext { owner: string; repo: string; runId: number; runAttempt: number; workflowPath: string }
export interface PublishOptions {
  onPublished?: (published: PublishedActionResult) => void | Promise<void>;
  explain?: (result: ValidationResult) => Promise<AiExplanation | undefined>;
}
interface TargetIdentity { prNumber: number; headSha: string; baseSha: string }

function requireMatch(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`LocalMesh publication refused: ${message}`);
}

function failureResult(repository: string, target: TargetIdentity, runId: number, message: string): ValidationResult {
  return { jobId: `workflow-${runId}`, repository, currentPr: target.prNumber, headSha: target.headSha, baseSha: target.baseSha,
    status: "failed", startedAt: new Date().toISOString(), affectedObjects: [], dependencies: [], comparedPullRequests: [], orders: [], rollbacks: [], performance: [],
    contracts: [{ code: "ANALYSIS_INCOMPLETE", severity: "error", title: "Automatic migration validation did not complete", message }] };
}

export async function publishResults(octokit: Octokit, context: PublishContext, artifact: unknown, options: PublishOptions = {}): Promise<{ published: number; skipped: number }> {
  // An artifact carries data only. No shell, SQL, or artifact-supplied code runs in this privileged process.
  let envelope = artifact === undefined ? undefined : envelopeSchema.parse(artifact) as ActionEnvelope;
  const { owner, repo, runId, runAttempt } = context;
  const repository = `${owner}/${repo}`;
  if (envelope) requireMatch(envelope.repository === repository && envelope.runId === runId && envelope.runAttempt === runAttempt, "artifact repository or originating run identity does not match the workflow_run event.");
  const { data: run } = await octokit.actions.getWorkflowRun({ owner, repo, run_id: runId });
  const runPrs = run.pull_requests ?? [];
  requireMatch(run.id === runId && run.run_attempt === runAttempt && run.repository.full_name === repository, "the API did not confirm the originating repository and run attempt.");
  requireMatch(run.status === "completed", "the originating analysis run is incomplete.");
  requireMatch(run.path?.split("@")[0] === context.workflowPath, "the originating workflow path is not the configured analyzer.");
  const { data: repoInfo } = await octokit.repos.get({ owner, repo });
  const [executedWorkflow, trustedWorkflow] = await Promise.all([
    getTextFile(octokit, run.head_repository?.owner?.login ?? owner, run.head_repository?.name ?? repo, context.workflowPath, run.head_sha),
    getTextFile(octokit, owner, repo, context.workflowPath, repoInfo.default_branch)
  ]);
  requireMatch(executedWorkflow && trustedWorkflow && executedWorkflow === trustedWorkflow, "the analysis workflow differs from the trusted default-branch workflow.");

  if (!envelope) {
    requireMatch(run.event === "pull_request" || run.event === "push", "a missing merge queue artifact cannot establish the tested base; rerun queue analysis.");
    let baseRef = repoInfo.default_branch;
    if (run.event === "pull_request") {
      const associated = runPrs.length ? runPrs
        : await octokit.paginate(octokit.repos.listPullRequestsAssociatedWithCommit, { owner, repo, commit_sha: run.head_sha, per_page: 100 });
      const matching = associated.filter((pr) => pr.head.sha === run.head_sha);
      requireMatch(matching.length > 0, "no authoritative PR association exists for the missing analysis artifact.");
      const sourcePr = (await octokit.pulls.get({ owner, repo, pull_number: matching[0]!.number })).data;
      requireMatch(sourcePr.base.repo.full_name === repository, "the missing artifact is associated with another base repository.");
      baseRef = sourcePr.base.ref;
    }
    const baseSha = (await octokit.repos.getBranch({ owner, repo, branch: baseRef })).data.commit.sha;
    envelope = { version: 1, repository, runId, runAttempt, event: run.event, baseRef, baseSha, targets: [], error: "Analysis result artifact is missing or unreadable. Rerun analysis to produce a verified result." };
  }
  requireMatch(run.event === envelope.event, "the originating analysis run used another event.");

  const { data: branch } = await octokit.repos.getBranch({ owner, repo, branch: envelope.baseRef });
  if (branch.commit.sha !== envelope.baseSha) return { published: 0, skipped: envelope.targets.length || 1 };
  if (envelope.event === "push") requireMatch(run.head_sha === envelope.baseSha && run.head_branch === repoInfo.default_branch && envelope.baseRef === repoInfo.default_branch, "push fan-out is not bound to the default-branch commit.");

  const prCache = new Map<number, Awaited<ReturnType<Octokit["pulls"]["get"]>>["data"]>();
  const currentPr = async (number: number) => {
    let pr = prCache.get(number);
    if (!pr) { pr = (await octokit.pulls.get({ owner, repo, pull_number: number })).data; prCache.set(number, pr); }
    return pr;
  };
  const freshPr = async (number: number, headSha: string) => {
    const pr = await currentPr(number);
    return pr.state === "open" && pr.head.sha === headSha && pr.base.ref === envelope.baseRef && pr.base.repo.full_name === repository;
  };

  let associated = runPrs.map((pr) => ({ number: pr.number, headSha: pr.head.sha }));
  if (envelope.event === "pull_request" && associated.length === 0) {
    // Fork workflow runs can omit pull_requests. Resolve commit associations from GitHub, never from the artifact.
    const prs = await octokit.paginate(octokit.repos.listPullRequestsAssociatedWithCommit, { owner, repo, commit_sha: run.head_sha, per_page: 100 });
    associated = prs.filter((pr) => pr.head.sha === run.head_sha && pr.base.repo.full_name === repository).map((pr) => ({ number: pr.number, headSha: pr.head.sha }));
  }
  if (envelope.event === "pull_request") requireMatch(associated.length > 0 && associated.every((pr) => pr.headSha === run.head_sha), "GitHub did not associate the analysis head with a pull request.");

  if (envelope.event === "merge_group") {
    requireMatch(envelope.queueBaseSha, "the artifact is missing the queue parent SHA.");
    const { data: queueCommit } = await octokit.git.getCommit({ owner, repo, commit_sha: run.head_sha });
    requireMatch(queueCommit.parents.some((parent) => parent.sha === envelope.queueBaseSha), "the reported queue base is not a parent of GitHub's merge queue commit.");
    const queueBranch = run.head_branch?.replace(/^refs\/heads\//, "");
    requireMatch(queueBranch && queueBranch.startsWith(`gh-readonly-queue/${envelope.baseRef}/`), "GitHub did not identify an active merge queue branch for this base.");
    try {
      const queue = await octokit.repos.getBranch({ owner, repo, branch: queueBranch });
      if (queue.data.commit.sha !== run.head_sha) return { published: 0, skipped: 1 };
    } catch (error) {
      if ((error as { status?: number }).status === 404) return { published: 0, skipped: 1 };
      throw error;
    }
  }

  const failedRun = run.conclusion !== "success" || Boolean(envelope.error);
  let targets: Array<TargetIdentity & { result: ValidationResult }> = envelope.targets;
  if (failedRun) {
    let identities: TargetIdentity[];
    if (envelope.event === "pull_request") identities = associated.map((pr) => ({ prNumber: pr.number, headSha: pr.headSha, baseSha: envelope.baseSha }));
    else if (envelope.event === "merge_group") identities = [{ prNumber: 0, headSha: run.head_sha, baseSha: envelope.baseSha }];
    else {
      const prs = await octokit.paginate(octokit.pulls.list, { owner, repo, state: "open", base: envelope.baseRef, per_page: 100 });
      identities = prs.map((pr) => ({ prNumber: pr.number, headSha: pr.head.sha, baseSha: envelope.baseSha }));
    }
    targets = identities.map((target) => ({ ...target, result: failureResult(repository, target, runId, envelope.error || `The originating analysis workflow concluded ${run.conclusion ?? "without a verdict"}. Rerun analysis before merging.`) }));
  }

  const seen = new Set<number>();
  for (const target of targets) {
    requireMatch(!seen.has(target.prNumber), "duplicate PR target in the artifact."); seen.add(target.prNumber);
    requireMatch(target.baseSha === envelope.baseSha && target.result.baseSha === target.baseSha && target.result.headSha === target.headSha
      && target.result.currentPr === target.prNumber && target.result.repository === repository, "result identity does not match its target.");
    if (envelope.event === "pull_request") requireMatch(associated.some((pr) => pr.number === target.prNumber && pr.headSha === target.headSha), "the artifact targets a PR unrelated to the originating run.");
    if (envelope.event === "merge_group") requireMatch(target.prNumber === 0 && target.headSha === run.head_sha && targets.length === 1, "the artifact is not bound to the cumulative merge queue head.");
    else requireMatch(target.prNumber > 0, "PR publication requires a positive PR number.");
    if (target.result.status === "passed") {
      requireMatch(target.result.provenance && target.result.scope, "a passing artifact is missing discovery provenance or validation coverage.");
      requireMatch(target.result.provenance.engineVersion === ENGINE_VERSION, "the artifact engine version does not match this reviewed publisher.");
      requireMatch(/^[a-f0-9]{64}$/i.test(target.result.provenance.inputDigest ?? ""), "the passing artifact is missing a valid compatibility receipt digest.");
      requireMatch(target.result.provenance.pullRequests.some((pr) => pr.number === target.prNumber && pr.headSha === target.headSha), "the passing artifact does not identify the checked head.");
      requireMatch(target.result.comparedPullRequests.every((number) => target.result.provenance!.pullRequests.some((pr) => pr.number === number)), "a compared PR is missing its tested head.");
      requireMatch(target.result.orders.length > 0 || target.result.provenance.currentPrFiles.length === 0, "migration files were reported without any recorded execution.");
    }
  }

  let published = 0;
  let skipped = 0;
  for (const target of targets) {
    if (target.prNumber > 0 && !await freshPr(target.prNumber, target.headSha)) { skipped++; continue; }
    let stalePeer = false;
    for (const pr of target.result.provenance?.pullRequests ?? []) {
      if (pr.number === target.prNumber || pr.number === 0) continue;
      if (!await freshPr(pr.number, pr.headSha)) { stalePeer = true; break; }
    }
    if (stalePeer) { skipped++; continue; }
    // Recheck the base immediately before the write, after all potentially slow discovery requests.
    if ((await octokit.repos.getBranch({ owner, repo, branch: envelope.baseRef })).data.commit.sha !== envelope.baseSha) { skipped++; continue; }
    const externalId = `localmesh:${runId}:${runAttempt}:${target.prNumber}`;
    const enrichedExplanation = await options.explain?.(target.result);
    if (enrichedExplanation) {
      target.result.explanation = enrichedExplanation;
      target.result.explanationStatus = "complete";
    }
    const { data: existing } = await octokit.checks.listForRef({ owner, repo, ref: target.headSha, check_name: "LocalMesh Sensei", filter: "latest", per_page: 100 });
    const previous = existing.check_runs.find((check) => check.external_id === externalId && check.app?.slug === "github-actions");
    const created = previous ?? (await octokit.checks.create({ owner, repo, name: "LocalMesh Sensei", head_sha: target.headSha, external_id: externalId, status: "queued" })).data;
    const id = created.id;
    target.result.links = { ...target.result.links, check: created.html_url ?? `${(process.env.GITHUB_SERVER_URL ?? "https://github.com").replace(/\/$/, "")}/${owner}/${repo}/runs/${id}` };
    // A workflow_run delivery retry must not append a second copy of annotations.
    if (!previous || previous.status !== "completed") await updateCheck(octokit, owner, repo, id, target.result);
    if (envelope.event === "pull_request") await upsertStickyComment(octokit, owner, repo, target.result);
    await options.onPublished?.({ externalId, result: target.result });
    published++;
  }
  return { published, skipped };
}
