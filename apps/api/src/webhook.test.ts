import { describe, expect, it, vi } from "vitest";
import { extractPullRequest, resolveValidationBase } from "./webhook.js";

const repository = { owner: { login: "team" }, name: "app" };

describe("webhook validation targets", () => {
  it("preserves the current pull request's immutable revisions", () => {
    expect(extractPullRequest("pull_request", { action: "synchronize", repository, pull_request: { number: 12, head: { sha: "head" }, base: { sha: "base" } } })).toEqual({ owner: "team", repo: "app", prNumber: 12, headSha: "head", baseSha: "base" });
  });

  it.each(["refs/heads/gh-readonly-queue/main/pr-12-head", "refs/heads/queue/group-with-many-prs"])("treats the complete merge group as the target regardless of its ref name: %s", (head_ref) => {
    expect(extractPullRequest("merge_group", { action: "checks_requested", repository, merge_group: { head_ref, head_sha: "group-head", base_sha: "group-base" } })).toEqual({ owner: "team", repo: "app", prNumber: 0, headSha: "group-head", baseSha: "group-base" });
  });

  it("ignores merge group destruction and closed pull requests", () => {
    expect(extractPullRequest("merge_group", { action: "destroyed" })).toBeNull();
    expect(extractPullRequest("pull_request", { action: "closed" })).toBeNull();
  });
});

describe("trusted merge queue baseline", () => {
  const target = { owner: "team", repo: "app", prNumber: 0, headSha: "b".repeat(40), baseSha: "c".repeat(40) };

  it("replaces a previous queued parent with the live protected target branch revision", async () => {
    const mainSha = "a".repeat(40);
    const client = { repos: { getBranch: vi.fn(async () => ({ data: { commit: { sha: mainSha } } })) } };
    const resolved = await resolveValidationBase(client, target, "merge_group", { merge_group: { base_ref: "refs/heads/main", base_sha: target.baseSha } });
    expect(client.repos.getBranch).toHaveBeenCalledWith({ owner: "team", repo: "app", branch: "main" });
    expect(resolved).toEqual({ ...target, baseSha: mainSha });
    expect(target.baseSha).toBe("c".repeat(40));
  });

  it.each([undefined, "main", "refs/tags/main", "refs/heads/"])("rejects a queue target that is not a branch ref: %s", async (base_ref) => {
    const client = { repos: { getBranch: vi.fn() } };
    await expect(resolveValidationBase(client, target, "merge_group", { merge_group: { base_ref } })).rejects.toThrow("target branch ref");
    expect(client.repos.getBranch).not.toHaveBeenCalled();
  });

  it("preserves ordinary pull request snapshots without another branch lookup", async () => {
    const client = { repos: { getBranch: vi.fn() } };
    expect(await resolveValidationBase(client, { ...target, prNumber: 12 }, "pull_request", {})).toEqual({ ...target, prNumber: 12 });
    expect(client.repos.getBranch).not.toHaveBeenCalled();
  });
});
