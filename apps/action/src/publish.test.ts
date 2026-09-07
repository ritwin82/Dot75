import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Octokit } from "@octokit/rest";
import { ENGINE_VERSION, type ValidationResult } from "@localmesh/shared";
import { getTextFile, updateCheck, upsertStickyComment } from "@localmesh/github";
import { publishResults } from "./publish.js";
import type { ActionEnvelope } from "./types.js";

vi.mock("@localmesh/github", () => ({ getTextFile: vi.fn(), updateCheck: vi.fn(), upsertStickyComment: vi.fn() }));
const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const peerSha = "c".repeat(40);
const context = { owner: "owner", repo: "repo", runId: 100, runAttempt: 1, workflowPath: ".github/workflows/localmesh-analysis.yml" };

function result(): ValidationResult {
  return { jobId: "job", repository: "owner/repo", currentPr: 1, baseSha, headSha, status: "passed", startedAt: "2026-09-07T00:00:00Z",
    affectedObjects: [], dependencies: [], comparedPullRequests: [], contracts: [], rollbacks: [], performance: [],
    orders: [{ order: [1], passed: true, sqlPassed: true, durationMs: 1, findings: [] }],
    provenance: { currentPrFiles: ["migrations/002_status.up.sql"], pullRequests: [{ number: 1, author: "alice", headSha }], inputDigest: "d".repeat(64), engineVersion: ENGINE_VERSION },
    scope: { candidatePrs: [], skippedPrs: [], contractMappings: 0, fixtureFiles: 0, rollbackChecked: false } };
}

function envelope(): ActionEnvelope {
  return { version: 1, repository: "owner/repo", runId: 100, runAttempt: 1, event: "pull_request", baseRef: "main", baseSha,
    targets: [{ prNumber: 1, headSha, baseSha, result: result() }] };
}

function client() {
  const run = { id: 100, run_attempt: 1, repository: { full_name: "owner/repo" }, head_repository: { name: "repo", owner: { login: "owner" } }, status: "completed", conclusion: "success", event: "pull_request",
    path: ".github/workflows/localmesh-analysis.yml@refs/heads/main", head_sha: headSha, head_branch: "migration", pull_requests: [{ number: 1, head: { sha: headSha } }] };
  const pull = (number: number) => ({ number, state: "open", head: { sha: number === 1 ? headSha : peerSha }, base: { ref: "main", repo: { full_name: "owner/repo" } } });
  const mock = {
    actions: { getWorkflowRun: vi.fn(async () => ({ data: run })) },
    repos: {
      get: vi.fn(async () => ({ data: { default_branch: "main" } })),
      getBranch: vi.fn(async ({ branch }: { branch: string }) => ({ data: { commit: { sha: branch.startsWith("gh-readonly-queue/") ? headSha : baseSha } } })),
      listPullRequestsAssociatedWithCommit: vi.fn()
    },
    pulls: { get: vi.fn(async ({ pull_number }: { pull_number: number }) => ({ data: pull(pull_number) })), list: vi.fn() },
    git: { getCommit: vi.fn().mockResolvedValue({ data: { parents: [{ sha: baseSha }] } }) },
    checks: { listForRef: vi.fn().mockResolvedValue({ data: { check_runs: [] } }), create: vi.fn().mockResolvedValue({ data: { id: 500 } }) },
    paginate: vi.fn()
  };
  mock.paginate.mockImplementation(async (method: unknown) => method === mock.repos.listPullRequestsAssociatedWithCommit ? [pull(1)] : [pull(1), pull(2)]);
  return { mock, run, pull, octokit: mock as unknown as Octokit };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getTextFile).mockResolvedValue("name: LocalMesh analysis\njobs: trusted-pinned-tool\n");
  vi.mocked(updateCheck).mockResolvedValue();
  vi.mocked(upsertStickyComment).mockResolvedValue();
});

describe("privileged workflow result publication", () => {
  it("publishes a proven, fresh PR result and one sticky comment", async () => {
    const { mock, octokit } = client();
    const onPublished = vi.fn();
    expect(await publishResults(octokit, context, envelope(), { onPublished })).toEqual({ published: 1, skipped: 0 });
    expect(mock.checks.create).toHaveBeenCalledWith(expect.objectContaining({ head_sha: headSha, external_id: "localmesh:100:1:1" }));
    expect(updateCheck).toHaveBeenCalledWith(octokit, "owner", "repo", 500, expect.objectContaining({ currentPr: 1, headSha, baseSha }));
    expect(upsertStickyComment).toHaveBeenCalledTimes(1);
    expect(getTextFile).toHaveBeenCalledWith(octokit, "owner", "repo", context.workflowPath, headSha);
    expect(getTextFile).toHaveBeenCalledWith(octokit, "owner", "repo", context.workflowPath, "main");
    expect(onPublished).toHaveBeenCalledWith({ externalId: "localmesh:100:1:1", result: expect.objectContaining({ currentPr: 1 }) });
  });

  it("adds an optional Ollama explanation without changing the verified verdict", async () => {
    const { octokit } = client();
    const explain = vi.fn().mockResolvedValue({
      cause: "PR #1 changes the account table.", conflictingObjects: ["table:public.accounts"], forwardFix: "Coordinate the migrations.",
      rollbackFix: "The recorded down migration restored the schema.", confidence: "high", assumptions: [], source: "ollama", model: "local-model"
    });
    await publishResults(octokit, context, envelope(), { explain });
    expect(explain).toHaveBeenCalledTimes(1);
    expect(updateCheck).toHaveBeenCalledWith(octokit, "owner", "repo", 500, expect.objectContaining({
      status: "passed", explanationStatus: "complete", explanation: expect.objectContaining({ source: "ollama" })
    }));
  });

  it("rejects malformed artifacts and cross-repository identity before any API call", async () => {
    const { mock, octokit } = client();
    await expect(publishResults(octokit, context, { ...envelope(), runId: "100" } as unknown as ActionEnvelope)).rejects.toThrow();
    await expect(publishResults(octokit, context, { ...envelope(), repository: "other/repo" })).rejects.toThrow("repository or originating run");
    expect(mock.actions.getWorkflowRun).not.toHaveBeenCalled();
  });

  it("rejects a different run attempt, event, or workflow path", async () => {
    for (const changed of [{ run_attempt: 2 }, { event: "push" }, { path: ".github/workflows/untrusted.yml" }]) {
      const { octokit, run } = client(); Object.assign(run, changed);
      await expect(publishResults(octokit, context, envelope())).rejects.toThrow("publication refused");
    }
    expect(updateCheck).not.toHaveBeenCalled();
  });

  it("refuses a PR-authored workflow change even when the artifact claims success", async () => {
    const { octokit, mock } = client();
    vi.mocked(getTextFile).mockResolvedValueOnce("untrusted workflow").mockResolvedValueOnce("trusted workflow");
    await expect(publishResults(octokit, context, envelope())).rejects.toThrow("differs from the trusted");
    expect(mock.checks.create).not.toHaveBeenCalled();
  });

  it("refuses an artifact targeting an unrelated PR or another result head", async () => {
    const { octokit } = client();
    const unrelated = envelope(); unrelated.targets[0]!.prNumber = 2; unrelated.targets[0]!.result.currentPr = 2;
    await expect(publishResults(octokit, context, unrelated)).rejects.toThrow("unrelated");
    const forged = envelope(); forged.targets[0]!.result.headSha = peerSha;
    await expect(publishResults(octokit, context, forged)).rejects.toThrow("result identity");
    expect(updateCheck).not.toHaveBeenCalled();
  });

  it("rejects duplicate targets before any check is written", async () => {
    const { octokit, mock } = client(); const value = envelope(); value.targets.push(value.targets[0]!);
    await expect(publishResults(octokit, context, value)).rejects.toThrow("duplicate");
    expect(mock.checks.create).not.toHaveBeenCalled();
  });

  it("rejects passing migration output without provenance or execution", async () => {
    const { octokit } = client();
    const missing = envelope(); delete missing.targets[0]!.result.provenance;
    await expect(publishResults(octokit, context, missing)).rejects.toThrow("missing discovery provenance");
    const unexecuted = envelope(); unexecuted.targets[0]!.result.orders = [];
    await expect(publishResults(octokit, context, unexecuted)).rejects.toThrow("without any recorded execution");
  });

  it("skips stale bases, changed PR heads, and closed PRs", async () => {
    const staleBase = client(); staleBase.mock.repos.getBranch.mockResolvedValue({ data: { commit: { sha: peerSha } } });
    expect(await publishResults(staleBase.octokit, context, envelope())).toEqual({ published: 0, skipped: 1 });
    for (const change of [{ state: "closed" }, { head: { sha: peerSha } }]) {
      const stalePr = client(); stalePr.mock.pulls.get.mockResolvedValue({ data: { ...stalePr.pull(1), ...change } });
      expect(await publishResults(stalePr.octokit, context, envelope())).toEqual({ published: 0, skipped: 1 });
    }
    expect(updateCheck).not.toHaveBeenCalled();
  });

  it("skips a result when a compared PR changed after analysis", async () => {
    const { octokit } = client(); const value = envelope();
    value.targets[0]!.result.provenance!.pullRequests.push({ number: 2, author: "bob", headSha: "d".repeat(40) });
    value.targets[0]!.result.comparedPullRequests = [2];
    expect(await publishResults(octokit, context, value)).toEqual({ published: 0, skipped: 1 });
    expect(updateCheck).not.toHaveBeenCalled();
  });

  it("rechecks the base after peer verification to prevent a stale publish", async () => {
    const { octokit, mock } = client();
    mock.repos.getBranch.mockResolvedValueOnce({ data: { commit: { sha: baseSha } } }).mockResolvedValueOnce({ data: { commit: { sha: peerSha } } });
    expect(await publishResults(octokit, context, envelope())).toEqual({ published: 0, skipped: 1 });
    expect(mock.checks.create).not.toHaveBeenCalled();
  });

  it("resolves fork PR association through GitHub when run.pull_requests is empty", async () => {
    const { octokit, mock, run } = client(); run.pull_requests = [];
    expect(await publishResults(octokit, context, envelope())).toEqual({ published: 1, skipped: 0 });
    expect(mock.paginate).toHaveBeenCalledWith(mock.repos.listPullRequestsAssociatedWithCommit, expect.objectContaining({ commit_sha: headSha }));
  });

  it("reads a fork workflow from its API-reported head repository before comparing with the trusted base", async () => {
    const { octokit, run } = client(); run.head_repository = { name: "fork-repo", owner: { login: "contributor" } };
    await publishResults(octokit, context, envelope());
    expect(getTextFile).toHaveBeenCalledWith(octokit, "contributor", "fork-repo", context.workflowPath, headSha);
    expect(getTextFile).toHaveBeenCalledWith(octokit, "owner", "repo", context.workflowPath, "main");
  });

  it("fails closed when GitHub cannot associate the analysis head with a fork PR", async () => {
    const { octokit, mock, run } = client(); run.pull_requests = []; mock.paginate.mockResolvedValue([]);
    await expect(publishResults(octokit, context, envelope())).rejects.toThrow("did not associate");
    expect(mock.checks.create).not.toHaveBeenCalled();
  });

  it("publishes an infrastructure failure from authoritative PR association after analysis fails", async () => {
    const { octokit, run } = client(); run.conclusion = "failure";
    const value = envelope(); value.targets = []; value.error = "Discovery could not fetch a migration.";
    expect(await publishResults(octokit, context, value)).toEqual({ published: 1, skipped: 0 });
    expect(updateCheck).toHaveBeenCalledWith(octokit, "owner", "repo", 500, expect.objectContaining({ status: "failed", currentPr: 1, contracts: [expect.objectContaining({ code: "ANALYSIS_INCOMPLETE" })] }));
  });

  it("cannot publish a passing artifact from a cancelled analysis run", async () => {
    const { octokit, run } = client(); run.conclusion = "cancelled";
    await publishResults(octokit, context, envelope());
    expect(vi.mocked(updateCheck).mock.calls[0]![4].status).toBe("failed");
  });

  it("publishes an explicit failure on the source PR when the artifact is missing", async () => {
    const { octokit } = client();
    expect(await publishResults(octokit, context, undefined)).toEqual({ published: 1, skipped: 0 });
    const published = vi.mocked(updateCheck).mock.calls[0]![4];
    expect(published.status).toBe("failed");
    expect(published.headSha).toBe(headSha);
    expect(published.contracts[0]!.message).toContain("missing or unreadable");
  });

  it("resolves a missing fork artifact from a GitHub commit association", async () => {
    const { octokit, run } = client(); run.pull_requests = [];
    expect(await publishResults(octokit, context, undefined)).toEqual({ published: 1, skipped: 0 });
    expect(vi.mocked(updateCheck).mock.calls[0]![4].status).toBe("failed");
  });

  it("fails closed on a missing merge queue artifact with an unprovable base", async () => {
    const { octokit, run } = client(); run.event = "merge_group";
    await expect(publishResults(octokit, context, undefined)).rejects.toThrow("cannot establish the tested base");
    expect(updateCheck).not.toHaveBeenCalled();
  });

  it("publishes push fan-out checks without PR comments", async () => {
    const { octokit, run } = client(); Object.assign(run, { event: "push", head_sha: baseSha, head_branch: "main", pull_requests: [] });
    await publishResults(octokit, context, { ...envelope(), event: "push" });
    expect(updateCheck).toHaveBeenCalledTimes(1);
    expect(upsertStickyComment).not.toHaveBeenCalled();
  });

  it("fails all current base PRs when push discovery fails, without trusting artifact target lists", async () => {
    const { octokit, run } = client(); Object.assign(run, { event: "push", head_sha: baseSha, head_branch: "main", pull_requests: [], conclusion: "failure" });
    const value: ActionEnvelope = { ...envelope(), event: "push", targets: [], error: "Discovery unavailable" };
    expect(await publishResults(octokit, context, value)).toEqual({ published: 2, skipped: 0 });
    expect(upsertStickyComment).not.toHaveBeenCalled();
  });

  it("validates an active cumulative merge queue head and never comments on PR #0", async () => {
    const { octokit, run } = client(); Object.assign(run, { event: "merge_group", head_branch: "gh-readonly-queue/main/pr-1-test", pull_requests: [] });
    const value = envelope(); value.event = "merge_group"; value.queueBaseSha = baseSha; value.targets[0]!.prNumber = 0; value.targets[0]!.result.currentPr = 0;
    value.targets[0]!.result.orders[0]!.order = [0]; value.targets[0]!.result.provenance!.pullRequests[0]!.number = 0;
    expect(await publishResults(octokit, context, value)).toEqual({ published: 1, skipped: 0 });
    expect(upsertStickyComment).not.toHaveBeenCalled();
  });

  it("refuses an unverified merge queue head", async () => {
    const { octokit, run } = client(); run.event = "merge_group";
    await expect(publishResults(octokit, context, { ...envelope(), event: "merge_group", queueBaseSha: baseSha })).rejects.toThrow("active merge queue branch");
    expect(updateCheck).not.toHaveBeenCalled();
  });

  it("accepts a later queue entry whose parent is another queue commit while the tested baseline is main", async () => {
    const { octokit, mock, run } = client(); Object.assign(run, { event: "merge_group", head_branch: "gh-readonly-queue/main/pr-2-test", pull_requests: [] });
    mock.git.getCommit.mockResolvedValue({ data: { parents: [{ sha: peerSha }] } });
    const value = envelope(); value.event = "merge_group"; value.queueBaseSha = peerSha; value.targets[0]!.prNumber = 0; value.targets[0]!.result.currentPr = 0;
    value.targets[0]!.result.orders[0]!.order = [0]; value.targets[0]!.result.provenance!.pullRequests[0]!.number = 0;
    expect(await publishResults(octokit, context, value)).toEqual({ published: 1, skipped: 0 });
    expect(mock.git.getCommit).toHaveBeenCalledWith({ owner: "owner", repo: "repo", commit_sha: headSha });
    expect(vi.mocked(updateCheck).mock.calls[0]![4].baseSha).toBe(baseSha);
  });

  it("refuses a merge queue artifact whose claimed queue parent is unrelated to the GitHub commit", async () => {
    const { octokit, run } = client(); Object.assign(run, { event: "merge_group", head_branch: "gh-readonly-queue/main/pr-1-test", pull_requests: [] });
    await expect(publishResults(octokit, context, { ...envelope(), event: "merge_group", queueBaseSha: peerSha })).rejects.toThrow("not a parent");
    expect(updateCheck).not.toHaveBeenCalled();
  });

  it("does not append duplicate annotations when a workflow_run delivery is retried", async () => {
    const { octokit, mock } = client();
    mock.checks.listForRef.mockResolvedValue({ data: { check_runs: [{ id: 500, external_id: "localmesh:100:1:1", status: "completed", app: { slug: "github-actions" } }] } });
    await publishResults(octokit, context, envelope());
    expect(mock.checks.create).not.toHaveBeenCalled();
    expect(updateCheck).not.toHaveBeenCalled();
    expect(upsertStickyComment).toHaveBeenCalledTimes(1);
  });
});
