import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Octokit } from "@octokit/rest";
import { parseValidationInput } from "@localmesh/engine";
import { prepareRun } from "./discover.js";

const github = vi.hoisted(() => ({
  discoverMigrationPullRequests: vi.fn(), discoverRevisionMigrations: vi.fn(), getTextFile: vi.fn(), listMigrations: vi.fn(), listSqlFiles: vi.fn()
}));
vi.mock("@localmesh/github", () => github);

const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const repository = { name: "store", owner: { login: "acme" }, default_branch: "main" };
const migration = { path: "db/migrations/002.up.sql", sql: "ALTER TABLE orders ADD COLUMN status text;", direction: "up", order: 2 };
const peer = { number: 8, title: "Other migration", author: "bob", headSha: "c".repeat(40), baseSha, migrations: [{ ...migration, path: "db/migrations/003.up.sql", order: 3 }] };
const client = {
  repos: { getBranch: vi.fn() },
  pulls: { get: vi.fn() }
};
const octokit = client as unknown as Octokit;

beforeEach(() => {
  vi.clearAllMocks();
  github.getTextFile.mockResolvedValue(undefined);
  github.listMigrations.mockResolvedValue([]);
  github.listSqlFiles.mockResolvedValue([]);
  github.discoverRevisionMigrations.mockResolvedValue({ migrations: [migration], issues: [] });
  github.discoverMigrationPullRequests.mockResolvedValue({ pullRequests: [peer], issues: [] });
  client.repos.getBranch.mockResolvedValue({ data: { commit: { sha: baseSha } } });
  client.pulls.get.mockResolvedValue({ data: { number: 7, state: "open", title: "Add status", user: { login: "alice" }, head: { sha: headSha, repo: { owner: { login: "contributor" }, name: "store-fork" } }, base: { ref: "main" } } });
});

describe("Action discovery to offline replay contract", () => {
  it("creates a valid PR input with immutable fork reads, peers and trusted base configuration", async () => {
    const run = await prepareRun(octokit, "pull_request", { repository, pull_request: { number: 7, head: { sha: headSha }, base: { ref: "main" } } }, { id: 11, attempt: 1 });
    expect(run.targets).toHaveLength(1);
    const input = parseValidationInput(run.targets[0]!.input);
    expect(input.current.pr).toBe(7);
    expect(input.candidates.map((candidate) => candidate.pr)).toEqual([8]);
    expect(input.provenance?.pullRequests.map((pr) => pr.author)).toEqual(["alice", "bob"]);
    expect(github.getTextFile).toHaveBeenCalledWith(octokit, "acme", "store", "localmesh.yml", baseSha);
    expect(github.discoverRevisionMigrations).toHaveBeenCalledWith(octokit, expect.objectContaining({ headOwner: "contributor", headRepo: "store-fork", headSha, baseSha }));
  });

  it("creates valid check-only fan-out inputs at the pushed baseline", async () => {
    const run = await prepareRun(octokit, "push", { repository, ref: "refs/heads/main", after: baseSha }, { id: 12, attempt: 1 });
    const input = parseValidationInput(run.targets[0]!.input);
    expect(input.job.prNumber).toBe(8);
    expect(input.job.baseSha).toBe(baseSha);
    expect(input.provenance?.trigger).toBe("push");
    expect(client.repos.getBranch).not.toHaveBeenCalled();
  });

  it("represents the complete queue revision as synthetic PR zero", async () => {
    const run = await prepareRun(octokit, "merge_group", { repository, merge_group: { base_sha: baseSha, head_sha: headSha, base_ref: "refs/heads/main" } }, { id: 13, attempt: 1 });
    const input = parseValidationInput(run.targets[0]!.input);
    expect(input.job.prNumber).toBe(0);
    expect(input.provenance?.pullRequests[0]?.number).toBe(0);
    expect(input.current.files).toEqual([migration]);
    expect(input.candidates).toEqual([]);
    expect(github.discoverMigrationPullRequests).not.toHaveBeenCalled();
  });

  it("keeps queue parents separate from the trusted current-main baseline", async () => {
    const queueParent = "d".repeat(40);
    const run = await prepareRun(octokit, "merge_group", { repository, merge_group: { base_sha: queueParent, head_sha: headSha, base_ref: "refs/heads/main" } }, { id: 16, attempt: 1 });
    expect(run.envelope.queueBaseSha).toBe(queueParent);
    const input = parseValidationInput(run.targets[0]!.input);
    expect(input.job.baseSha).toBe(baseSha);
    expect(github.getTextFile).toHaveBeenCalledWith(octokit, "acme", "store", "localmesh.yml", baseSha);
    expect(github.discoverRevisionMigrations).toHaveBeenCalledWith(octokit, expect.objectContaining({ baseSha, headSha }));
  });

  it("keeps a no-migration success target without loading the baseline or peers", async () => {
    github.discoverRevisionMigrations.mockResolvedValue({ migrations: [], issues: [] });
    const run = await prepareRun(octokit, "pull_request", { repository, pull_request: { number: 7, head: { sha: headSha }, base: { ref: "main" } } }, { id: 14, attempt: 1 });
    expect(parseValidationInput(run.targets[0]!.input).current.files).toEqual([]);
    expect(github.listMigrations).not.toHaveBeenCalled();
    expect(github.discoverMigrationPullRequests).not.toHaveBeenCalled();
  });

  it("preserves incomplete discovery as a blocking input finding", async () => {
    github.discoverRevisionMigrations.mockResolvedValue({ migrations: [], issues: [{ code: "MIGRATION_HISTORY_CHANGED", message: "An applied migration was edited.", files: ["db/migrations/001.up.sql"], headSha }] });
    const run = await prepareRun(octokit, "pull_request", { repository, pull_request: { number: 7, head: { sha: headSha }, base: { ref: "main" } } }, { id: 15, attempt: 1 });
    expect(parseValidationInput(run.targets[0]!.input).discoveryFindings?.[0]?.severity).toBe("error");
  });
});
