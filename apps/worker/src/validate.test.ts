import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ValidationJob, ValidationResult } from "@localmesh/shared";

const state = vi.hoisted(() => ({
  getTextFile: vi.fn(), installationClient: vi.fn(), listMigrations: vi.fn(), listSqlFiles: vi.fn(),
  discoverRevisionMigrations: vi.fn(), discoverMigrationPullRequests: vi.fn(), createDiskDiscoveryCache: vi.fn(),
  markCheckInfrastructureFailure: vi.fn(), markCheckRunning: vi.fn(), updateCheck: vi.fn(),
  setJobStatus: vi.fn(), isJobCancelled: vi.fn(), runValidationInput: vi.fn(), explainWithOllama: vi.fn(),
  pullsGet: vi.fn(), calls: [] as string[]
}));

vi.mock("@localmesh/github", () => state);
vi.mock("@localmesh/db", () => ({ setJobStatus: state.setJobStatus, isJobCancelled: state.isJobCancelled }));
vi.mock("@localmesh/engine", () => ({
  parseValidationInput: (value: unknown) => value, runValidationInput: state.runValidationInput,
  validationPlanFromInput: (value: unknown) => value, explainWithOllama: state.explainWithOllama,
  explanationContext: () => ({}), resultFindings: (result: ValidationResult) => result.contracts
}));

import { validateJob } from "./validate.js";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const PEER = "c".repeat(40);
const file = { path: "db/migrations/002_a.up.sql", sql: "SELECT 1;", direction: "up" as const, order: 2 };
const job: ValidationJob = { id: "job-1", installationId: 9, owner: "team", repo: "app", prNumber: 11, baseSha: BASE, headSha: HEAD, checkRunId: 90 };
const result = (): ValidationResult => ({ jobId: job.id, repository: "team/app", currentPr: 11, baseSha: BASE, headSha: HEAD, status: "passed", startedAt: "2026-09-07T00:00:00Z", affectedObjects: [], dependencies: [], comparedPullRequests: [], orders: [], contracts: [], rollbacks: [], performance: [], explanationStatus: "complete" });

beforeEach(() => {
  vi.clearAllMocks();
  state.calls.length = 0;
  vi.stubEnv("OLLAMA_MODEL", "");
  state.installationClient.mockResolvedValue({ pulls: { get: state.pullsGet } });
  state.pullsGet.mockResolvedValue({ data: { title: "Add table", user: { login: "alice" }, head: { sha: HEAD, repo: { owner: { login: "alice" }, name: "fork" } }, base: { ref: "main" } } });
  state.getTextFile.mockResolvedValue(undefined);
  state.listMigrations.mockResolvedValue([]);
  state.listSqlFiles.mockResolvedValue([]);
  state.createDiskDiscoveryCache.mockReturnValue({});
  state.discoverRevisionMigrations.mockResolvedValue({ migrations: [file], issues: [] });
  state.discoverMigrationPullRequests.mockResolvedValue({ pullRequests: [{ number: 12, author: "bob", title: "Peer", headSha: PEER, baseSha: BASE, migrations: [file] }], issues: [] });
  state.isJobCancelled.mockResolvedValue(false);
  state.runValidationInput.mockImplementation(async () => { state.calls.push("engine"); return result(); });
  state.updateCheck.mockImplementation(async () => { state.calls.push("publish"); });
  state.explainWithOllama.mockImplementation(async () => { state.calls.push("ai"); return { source: "ollama" }; });
});

afterEach(() => vi.unstubAllEnvs());

describe("GitHub worker trusted discovery", () => {
  it("reads all policy inputs at the job base and passes immutable fork and peer snapshots to the shared engine", async () => {
    await validateJob(job);
    expect(state.getTextFile.mock.calls.every((args) => args[4] === BASE)).toBe(true);
    expect(state.listSqlFiles).toHaveBeenCalledWith(expect.anything(), "team", "app", BASE, ".localmesh/fixtures");
    expect(state.discoverRevisionMigrations).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ baseSha: BASE, headSha: HEAD, headOwner: "alice", headRepo: "fork" }));
    expect(state.discoverMigrationPullRequests).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ baseSha: BASE, baseRef: "main", excludePr: 11 }));
    expect(state.runValidationInput).toHaveBeenCalledWith(expect.objectContaining({
      version: 1, current: { pr: 11, files: [file] }, candidates: [{ pr: 12, files: [file] }],
      provenance: { trigger: "github_app", currentPrFiles: [file.path], pullRequests: [{ number: 11, author: "alice", headSha: HEAD, title: "Add table" }, { number: 12, author: "bob", headSha: PEER, title: "Peer" }] }
    }));
  });

  it("passes historical migration errors through the engine's fail-closed input path", async () => {
    state.discoverMigrationPullRequests.mockResolvedValue({ pullRequests: [], issues: [{ code: "MIGRATION_HISTORY_CHANGED", message: "Add a forward migration.", files: [file.path], headSha: PEER, prNumber: 12 }] });
    await validateJob(job);
    expect(state.runValidationInput).toHaveBeenCalledWith(expect.objectContaining({ discoveryFindings: [expect.objectContaining({ code: "MIGRATION_HISTORY_CHANGED", severity: "error", message: expect.stringContaining("PR #12"), evidence: { prNumber: 12, files: [file.path], headSha: PEER } })] }));
  });

  it("avoids peer and fixture discovery for a PR that changes no migrations", async () => {
    state.discoverRevisionMigrations.mockResolvedValue({ migrations: [], issues: [] });
    await validateJob(job);
    expect(state.discoverMigrationPullRequests).not.toHaveBeenCalled();
    expect(state.listMigrations).not.toHaveBeenCalled();
    expect(state.listSqlFiles).not.toHaveBeenCalled();
    expect(state.runValidationInput).toHaveBeenCalledWith(expect.objectContaining({ current: { pr: 11, files: [] }, candidates: [], fixtures: [], discoveryFindings: [] }));
  });

  it("validates the whole merge queue revision in the base repository without looking up a single PR", async () => {
    await validateJob({ ...job, prNumber: 0 });
    expect(state.pullsGet).not.toHaveBeenCalled();
    expect(state.discoverMigrationPullRequests).not.toHaveBeenCalled();
    expect(state.discoverRevisionMigrations).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ baseSha: BASE, headSha: HEAD, headOwner: "team", headRepo: "app" }));
    expect(state.runValidationInput).toHaveBeenCalledWith(expect.objectContaining({ current: { pr: 0, files: [file] }, candidates: [], provenance: expect.objectContaining({ trigger: "merge_group" }) }));
  });

  it("fails closed for configured patterns the SQL engine does not support", async () => {
    state.getTextFile.mockResolvedValue("version: 1\npostgres: {}\nmigrations:\n  up_pattern: '*.sql'\n");
    await expect(validateJob(job)).rejects.toThrow("custom patterns cannot be safely interpreted");
    expect(state.runValidationInput).not.toHaveBeenCalled();
  });

  it("publishes deterministic evidence before optional AI and publishes the completed explanation afterward", async () => {
    vi.stubEnv("OLLAMA_MODEL", "local-model");
    await validateJob(job);
    expect(state.calls).toEqual(["engine", "publish", "ai", "publish"]);
    expect(state.setJobStatus).toHaveBeenCalledWith(job.id, "passed", expect.objectContaining({ explanationStatus: "complete" }));
  });
});
