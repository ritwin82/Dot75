import { randomUUID } from "node:crypto";
import type { Octokit } from "@octokit/rest";
import { z } from "zod";
import { discoverMigrationPullRequests, discoverRevisionMigrations, getTextFile, listMigrations, listSqlFiles, type DiscoveryCache, type DiscoveryIssue } from "@localmesh/github";
import { defaultConfig, parseConfig, type Finding, type MigrationFile, type PullRequestRef, type ValidationJob } from "@localmesh/shared";
import type { ActionEnvelope } from "./types.js";

const sha = z.string().regex(/^[a-f0-9]{40}$/i);
const repository = z.object({ name: z.string().min(1), owner: z.object({ login: z.string().min(1) }), default_branch: z.string().min(1) });
const prEvent = z.object({ repository, pull_request: z.object({ number: z.number().int().positive(), head: z.object({ sha }), base: z.object({ ref: z.string().min(1) }) }) });
const pushEvent = z.object({ repository, ref: z.string().startsWith("refs/heads/"), after: sha, deleted: z.boolean().optional() });
const queueEvent = z.object({ repository, merge_group: z.object({ base_sha: sha, head_sha: sha, base_ref: z.string().startsWith("refs/heads/") }) });
export interface EventTarget { owner: string; repo: string; baseRef: string; baseSha?: string; headSha?: string; prNumber?: number }
export function eventTarget(event: ActionEnvelope["event"], payload: unknown): EventTarget {
  if (event === "pull_request") {
    const value = prEvent.parse(payload);
    return { owner: value.repository.owner.login, repo: value.repository.name, baseRef: value.pull_request.base.ref, headSha: value.pull_request.head.sha, prNumber: value.pull_request.number };
  }
  if (event === "push") {
    const value = pushEvent.parse(payload);
    if (value.deleted || value.ref !== `refs/heads/${value.repository.default_branch}`) throw new Error("Only pushes to the default branch can refresh open PR checks.");
    return { owner: value.repository.owner.login, repo: value.repository.name, baseRef: value.repository.default_branch, baseSha: value.after };
  }
  const value = queueEvent.parse(payload);
  return { owner: value.repository.owner.login, repo: value.repository.name, baseRef: value.merge_group.base_ref.slice("refs/heads/".length), baseSha: value.merge_group.base_sha, headSha: value.merge_group.head_sha, prNumber: 0 };
}
export interface PreparedTarget { job: ValidationJob; input: Record<string, unknown> }
export interface PreparedRun { envelope: ActionEnvelope; targets: PreparedTarget[] }
function discoveryFindings(issues: DiscoveryIssue[]): Finding[] {
  return issues.map((issue) => ({ code: issue.code, severity: "error", title: "Migration discovery requires attention", message: issue.message, evidence: { pr: issue.prNumber, files: issue.files, headSha: issue.headSha } }));
}

export async function prepareRun(octokit: Octokit, event: ActionEnvelope["event"], payload: unknown, run: { id: number; attempt: number }, cache?: DiscoveryCache): Promise<PreparedRun> {
  const target = eventTarget(event, payload);
  const { owner, repo, baseRef } = target;
  const baseSha = event === "merge_group" || !target.baseSha ? (await octokit.repos.getBranch({ owner, repo, branch: baseRef })).data.commit.sha : target.baseSha;
  const envelope: ActionEnvelope = { version: 1, repository: `${owner}/${repo}`, runId: run.id, runAttempt: run.attempt, event, baseRef, baseSha, ...(event === "merge_group" ? { queueBaseSha: target.baseSha! } : {}), targets: [] };
  const configText = await getTextFile(octokit, owner, repo, "localmesh.yml", baseSha);
  const config = configText !== undefined ? parseConfig(configText) : defaultConfig;
  if (["rails", "django", "alembic"].includes(config.migrations.adapter)) throw new Error(`The ${config.migrations.adapter} adapter requires an isolated project runner and is not enabled.`);
  if (config.migrations.adapter === "raw-sql" && (config.migrations.up_pattern !== "*.up.sql" || config.migrations.down_pattern !== "*.down.sql")) throw new Error("The raw SQL adapter requires *.up.sql and *.down.sql patterns; custom patterns cannot be safely interpreted.");
  const options = { owner, repo, baseSha, directory: config.migrations.directory, adapter: config.migrations.adapter, ...(cache ? { cache } : {}) };
  let current: PullRequestRef | undefined;
  let currentIssues: DiscoveryIssue[] = [];
  if (event === "pull_request") {
    const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number: target.prNumber! });
    if (pr.state !== "open" || pr.head.sha !== target.headSha || pr.base.ref !== baseRef) return { envelope, targets: [] };
    const revision = await discoverRevisionMigrations(octokit, { ...options, headSha: pr.head.sha, headOwner: pr.head.repo?.owner.login ?? owner, headRepo: pr.head.repo?.name ?? repo });
    current = { number: pr.number, title: pr.title, author: pr.user?.login ?? "unknown", headSha: pr.head.sha, baseSha, migrations: revision.migrations };
    currentIssues = revision.issues.map((issue) => ({ ...issue, prNumber: pr.number }));
  } else if (event === "merge_group") {
    const revision = await discoverRevisionMigrations(octokit, { ...options, headSha: target.headSha! });
    current = { number: 0, title: "Cumulative merge queue", author: "github-merge-queue", headSha: target.headSha!, baseSha, migrations: revision.migrations };
    currentIssues = revision.issues;
  }
  const hasCurrentChanges = current && (current.migrations.length > 0 || currentIssues.length > 0);
  const discoverPeers = event === "push" || (event === "pull_request" && hasCurrentChanges && config.checks.compare_open_pull_requests);
  const discovery = discoverPeers ? await discoverMigrationPullRequests(octokit, { ...options, baseRef, includeDrafts: true, ...(current ? { excludePr: current.number } : {}) }) : { pullRequests: [], issues: [] };
  const targets = current ? [current] : discovery.pullRequests;
  const anyChanges = targets.some((pr) => pr.migrations.length) || currentIssues.length || discovery.issues.length;
  const [baseline, fixtures, mappingsText, metadataText] = anyChanges ? await Promise.all([
    listMigrations(octokit, owner, repo, baseSha, config.migrations.directory, config.migrations.adapter),
    listSqlFiles(octokit, owner, repo, baseSha, config.contracts.fixtures_directory),
    getTextFile(octokit, owner, repo, config.contracts.mappings_file, baseSha),
    getTextFile(octokit, owner, repo, config.performance.metadata_file, baseSha)
  ]) : [[], [], undefined, undefined];
  return { envelope, targets: targets.map((pr) => {
    const peers = config.checks.compare_open_pull_requests && event !== "merge_group" && (pr.migrations.length || currentIssues.length)
      ? discovery.pullRequests.filter((peer) => peer.number !== pr.number) : [];
    const job: ValidationJob = { id: randomUUID(), installationId: 0, owner, repo, prNumber: pr.number, headSha: pr.headSha, baseSha };
    const issues = [...currentIssues, ...discovery.issues.filter((issue) => issue.prNumber === pr.number || peers.some((peer) => peer.number === issue.prNumber))];
    const input = { version: 1, job, config, baseline, current: { pr: pr.number, files: pr.migrations }, candidates: peers.map((peer) => ({ pr: peer.number, files: peer.migrations })), fixtures,
      ...(mappingsText !== undefined ? { mappingsText } : {}), ...(metadataText !== undefined ? { metadataText } : {}), discoveryFindings: discoveryFindings(issues),
      provenance: { trigger: event, currentPrFiles: pr.migrations.map((file: MigrationFile) => file.path), pullRequests: [pr, ...peers].map(({ number, author, headSha, title }) => ({ number, author, headSha, title })) } };
    return { job, input };
  }) };
}
