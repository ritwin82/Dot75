import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PgBoss } from "pg-boss";
import { cancelStaleJobs, saveJob, setCheckRunId } from "@localmesh/db";
import { createCheck, discoverMigrationPullRequests, getTextFile, installationClient } from "@localmesh/github";
import { refreshRepository } from "./refresh.js";

vi.mock("@localmesh/db", () => ({ cancelStaleJobs: vi.fn(), saveJob: vi.fn(), setCheckRunId: vi.fn() }));
vi.mock("@localmesh/github", () => ({ cancelCheck: vi.fn(), createCheck: vi.fn(), discoverMigrationPullRequests: vi.fn(), getTextFile: vi.fn(), installationClient: vi.fn() }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(installationClient).mockResolvedValue({} as never);
  vi.mocked(getTextFile).mockResolvedValue(undefined);
  vi.mocked(cancelStaleJobs).mockResolvedValue([]);
  vi.mocked(saveJob).mockResolvedValue(true);
  vi.mocked(createCheck).mockResolvedValue(99);
  vi.mocked(setCheckRunId).mockResolvedValue();
});

describe("default-branch repository refresh", () => {
  it("queues every live migration PR against the pushed base without commenting", async () => {
    vi.mocked(discoverMigrationPullRequests).mockResolvedValue({
      pullRequests: [{ number: 7, title: "migration", author: "alice", headSha: "b".repeat(40), baseSha: "a".repeat(40), migrations: [] }],
      issues: [], stats: { candidatePullRequests: 1, migrationPullRequests: 1, cacheHits: 0, cacheMisses: 1 }
    });
    const boss = { send: vi.fn().mockResolvedValue("job") } as unknown as PgBoss;
    await expect(refreshRepository(boss, { installationId: 3, owner: "acme", repo: "store", baseRef: "main", baseSha: "a".repeat(40) })).resolves.toBe(1);
    expect(saveJob).toHaveBeenCalledWith(expect.objectContaining({ prNumber: 7, trigger: "push" }));
    expect(boss.send).toHaveBeenCalledWith("validate-pr", expect.objectContaining({ prNumber: 7 }), expect.any(Object));
  });
});
