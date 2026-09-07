import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Octokit } from "@octokit/rest";
import { describe, expect, it, vi } from "vitest";
import { createDiskDiscoveryCache, discoverMigrationPullRequests, discoverRevisionMigrations, type DiscoveryCache } from "./discovery.js";
import { getTextFile, listMigrations, listSqlFiles } from "./index.js";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const NEXT = "c".repeat(40);
const MERGE_BASE = "d".repeat(40);
const sqlHash = (sql: string) => createHash("sha1").update(`blob ${Buffer.byteLength(sql)}\0`).update(sql).digest("hex");
const entry = (path: string, sql: string) => ({ path, type: "blob", sha: sqlHash(sql) });
const options = { owner: "team", repo: "app", baseSha: BASE, headSha: HEAD, directory: "db/migrations" };

function memoryCache(): DiscoveryCache {
  const entries = new Map<string, unknown>();
  return { get: async (key) => entries.get(key), set: async (key, value) => { entries.set(key, value); } };
}

function client(trees: Record<string, ReturnType<typeof entry>[]>, sources: string[] = []) {
  const blobs = new Map(sources.map((sql) => [sqlHash(sql), sql]));
  const api = {
    paginate: vi.fn(async () => [] as unknown[]),
    pulls: { list: vi.fn() },
    repos: { compareCommitsWithBasehead: vi.fn(async () => ({ data: { merge_base_commit: { sha: BASE } } })) },
    git: {
      getTree: vi.fn(async ({ tree_sha }: { tree_sha: string }) => ({ data: { truncated: false, tree: trees[tree_sha] ?? [] } })),
      getBlob: vi.fn(async ({ file_sha }: { file_sha: string }) => ({ data: { content: Buffer.from(blobs.get(file_sha) ?? "").toString("base64"), encoding: "base64" } }))
    }
  };
  return { api, octokit: api as unknown as Octokit };
}

describe("immutable migration discovery", () => {
  it("reads immutable blobs, sorts numeric migration order, and respects directory boundaries", async () => {
    const a = "CREATE TABLE a(id int);";
    const b = "DROP TABLE a;";
    const { api, octokit } = client({ [BASE]: [], [HEAD]: [entry("db/migrations/020_a.down.sql", b), entry("db/migrations/003_a.up.sql", a), entry("db/migrations-copy/001_skip.up.sql", a), entry("src/app.ts", a)] }, [a, b]);
    const result = await discoverRevisionMigrations(octokit, { ...options, directory: "./db/migrations/" });
    expect(result.issues).toEqual([]);
    expect(result.migrations.map((file) => [file.order, file.direction])).toEqual([[3, "up"], [20, "down"]]);
    expect(api.repos.compareCommitsWithBasehead).toHaveBeenCalledWith({ owner: "team", repo: "app", basehead: `${BASE}...${HEAD}`, per_page: 1 });
    expect(api.git.getBlob).toHaveBeenCalledWith({ owner: "team", repo: "app", file_sha: sqlHash(a) });
  });

  it("fails closed for modified, removed, and renamed committed migrations", async () => {
    const old = "CREATE TABLE a(id int);";
    const edited = "CREATE TABLE a(id bigint);";
    const { octokit } = client({ [BASE]: [entry("db/migrations/001_old.up.sql", old), entry("db/migrations/002_removed.up.sql", old)], [HEAD]: [entry("db/migrations/001_old.up.sql", edited), entry("db/migrations/003_renamed.up.sql", old)] }, [old, edited]);
    const result = await discoverRevisionMigrations(octokit, options);
    expect(result.issues).toEqual([{ code: "MIGRATION_HISTORY_CHANGED", message: expect.stringContaining("new forward migration"), files: ["db/migrations/001_old.up.sql", "db/migrations/002_removed.up.sql"], headSha: HEAD }]);
  });

  it("reports unsupported SQL instead of silently treating the PR as migration-free", async () => {
    const { octokit } = client({ [BASE]: [], [HEAD]: [entry("db/migrations/001_unclassified.sql", "SELECT 1;")] });
    const result = await discoverRevisionMigrations(octokit, options);
    expect(result.migrations).toEqual([]);
    expect(result.issues[0]?.code).toBe("UNSUPPORTED_MIGRATION_NAME");
  });

  it("uses the pinned current base, skipping identical already-applied additions and rejecting divergent ones", async () => {
    const old = "CREATE TABLE a(id int);";
    const edited = "CREATE TABLE a(id bigint);";
    const { api, octokit } = client({ [MERGE_BASE]: [], [BASE]: [entry("db/migrations/001_a.up.sql", old), entry("db/migrations/002_b.up.sql", old)], [HEAD]: [entry("db/migrations/001_a.up.sql", old), entry("db/migrations/002_b.up.sql", edited)] }, [old, edited]);
    api.repos.compareCommitsWithBasehead.mockResolvedValue({ data: { merge_base_commit: { sha: MERGE_BASE } } });
    const result = await discoverRevisionMigrations(octokit, options);
    expect(result.migrations).toEqual([]);
    expect(result.issues[0]?.files).toEqual(["db/migrations/002_b.up.sql"]);
    expect(api.git.getBlob).not.toHaveBeenCalled();
  });

  it("retains immutable cache entries when only one PR head changes", async () => {
    const sql = "SELECT 1;";
    const { api, octokit } = client({ [BASE]: [], [HEAD]: [entry("db/migrations/001_a.up.sql", sql)], [NEXT]: [entry("db/migrations/001_a.up.sql", sql)] }, [sql]);
    const cache = memoryCache();
    await discoverRevisionMigrations(octokit, { ...options, cache });
    const second = await discoverRevisionMigrations(octokit, { ...options, cache });
    expect(second.stats.cacheMisses).toBe(0);
    expect(second.stats.cacheHits).toBe(4);
    await discoverRevisionMigrations(octokit, { ...options, headSha: NEXT, cache });
    expect(api.git.getBlob).toHaveBeenCalledTimes(1);
    expect(api.git.getTree).toHaveBeenCalledTimes(3);
    expect(api.repos.compareCommitsWithBasehead).toHaveBeenCalledTimes(2);
  });

  it("treats corrupted cached SQL as a cache miss and verifies the replacement", async () => {
    const sql = "SELECT 1;";
    const { api, octokit } = client({ [BASE]: [], [HEAD]: [entry("db/migrations/001_a.up.sql", sql)] }, [sql]);
    const cache = memoryCache();
    await cache.set(`localmesh-discovery-v1:blob:team/app:${sqlHash(sql)}`, "SELECT 'corrupt';");
    const result = await discoverRevisionMigrations(octokit, { ...options, cache });
    expect(result.migrations[0]?.sql).toBe(sql);
    expect(api.git.getBlob).toHaveBeenCalledTimes(1);
  });

  it("reads fork objects from the source repository using an immutable comparison", async () => {
    const sql = "SELECT 1;";
    const { api, octokit } = client({ [BASE]: [], [HEAD]: [entry("db/migrations/001_a.up.sql", sql)] }, [sql]);
    await discoverRevisionMigrations(octokit, { ...options, headOwner: "contributor", headRepo: "fork" });
    expect(api.repos.compareCommitsWithBasehead).toHaveBeenCalledWith(expect.objectContaining({ basehead: `${BASE}...contributor:${HEAD}` }));
    expect(api.git.getTree).toHaveBeenCalledWith({ owner: "contributor", repo: "fork", tree_sha: HEAD, recursive: "true" });
    expect(api.git.getBlob).toHaveBeenCalledWith({ owner: "contributor", repo: "fork", file_sha: sqlHash(sql) });
  });

  it("refuses truncated trees and unverifiable blob content", async () => {
    const first = client({});
    first.api.git.getTree.mockResolvedValue({ data: { truncated: true, tree: [] } });
    await expect(discoverRevisionMigrations(first.octokit, options)).rejects.toThrow("discovery is incomplete");
    const second = client({ [BASE]: [], [HEAD]: [entry("db/migrations/001_a.up.sql", "SELECT 1;")] });
    await expect(discoverRevisionMigrations(second.octokit, options)).rejects.toThrow("does not match its immutable SHA");
  });

  it("rejects mutable refs and directory traversal", async () => {
    const { octokit } = client({});
    await expect(discoverRevisionMigrations(octokit, { ...options, headSha: "feature" })).rejects.toThrow("immutable");
    await expect(discoverRevisionMigrations(octokit, { ...options, directory: "../db" })).rejects.toThrow("relative repository path");
  });

  it("paginates open PRs and filters target branch, drafts, excluded PRs, and non-migration changes", async () => {
    const sql = "SELECT 1;";
    const { api, octokit } = client({ [BASE]: [], [HEAD]: [entry("db/migrations/001_a.up.sql", sql)], [NEXT]: [entry("README.md", sql)] }, [sql]);
    const pr = (number: number, headSha: string = HEAD, baseRef = "main", draft = false) => ({ number, draft, title: `PR ${number}`, user: { login: "author" }, head: { sha: headSha, repo: { owner: { login: "team" }, name: "app" } }, base: { sha: MERGE_BASE, ref: baseRef } });
    api.paginate.mockResolvedValue([pr(1), pr(2, NEXT), pr(3, HEAD, "release"), pr(4, HEAD, "main", true), pr(5)]);
    const result = await discoverMigrationPullRequests(octokit, { ...options, baseRef: "main", excludePr: 5 });
    expect(api.paginate).toHaveBeenCalledWith(api.pulls.list, { owner: "team", repo: "app", state: "open", per_page: 100, base: "main" });
    expect(result.pullRequests).toEqual([{ number: 1, title: "PR 1", author: "author", baseSha: BASE, headSha: HEAD, migrations: [{ path: "db/migrations/001_a.up.sql", sql, order: 1, direction: "up" }] }]);
    expect(result.stats.candidatePullRequests).toBe(2);
    expect(result.stats.migrationPullRequests).toBe(1);
  });

  it("includes migration PRs with discovery errors so callers cannot silently drop them", async () => {
    const { api, octokit } = client({ [BASE]: [entry("db/migrations/001_a.up.sql", "SELECT 1;")], [HEAD]: [] });
    api.paginate.mockResolvedValue([{ number: 7, draft: false, title: "Remove history", user: { login: "author" }, head: { sha: HEAD, repo: { owner: { login: "team" }, name: "app" } }, base: { sha: BASE, ref: "main" } }]);
    const result = await discoverMigrationPullRequests(octokit, options);
    expect(result.pullRequests.map((pr) => pr.number)).toEqual([7]);
    expect(result.issues[0]?.prNumber).toBe(7);
  });
});

describe("trusted baseline and fixture completeness", () => {
  it("rejects truncated trees for both migrations and fixture SQL", async () => {
    const { api, octokit } = client({});
    api.git.getTree.mockResolvedValue({ data: { truncated: true, tree: [] } });
    await expect(listMigrations(octokit, "team", "app", BASE, "db/migrations")).rejects.toThrow("incomplete baseline");
    await expect(listSqlFiles(octokit, "team", "app", BASE, ".localmesh/fixtures")).rejects.toThrow("incomplete fixtures");
  });

  it("fails when a tree-listed baseline or fixture cannot be fetched", async () => {
    const octokit = {
      git: { getTree: vi.fn(async () => ({ data: { truncated: false, tree: [entry("db/migrations/001_a.up.sql", "SELECT 1;")] } })) },
      repos: { getContent: vi.fn(async () => { throw Object.assign(new Error("Not Found"), { status: 404 }); }) }
    } as unknown as Octokit;
    await expect(listMigrations(octokit, "team", "app", BASE, "db/migrations")).rejects.toThrow("Could not read baseline migration");
    await expect(listSqlFiles(octokit, "team", "app", BASE, "db/migrations")).rejects.toThrow("Could not read SQL file");
  });

  it("does not interpret the Contents API's omitted large-file content as empty SQL", async () => {
    const octokit = { repos: { getContent: vi.fn(async () => ({ data: { type: "file", encoding: "none", content: "", size: 2_000_000 } })) } } as unknown as Octokit;
    await expect(getTextFile(octokit, "team", "app", "schema.sql", BASE)).rejects.toThrow("complete contents");
  });
});

describe("disk discovery cache", () => {
  it("persists keyed JSON and treats malformed or mismatched cache entries as misses", async () => {
    const directory = await mkdtemp(join(tmpdir(), "localmesh-discovery-"));
    try {
      const cache = createDiskDiscoveryCache(directory);
      expect(await cache.get("missing")).toBeUndefined();
      await cache.set("one", { value: 42 });
      expect(await createDiskDiscoveryCache(directory).get("one")).toEqual({ value: 42 });
      const filename = (await readdir(directory))[0]!;
      expect(JSON.parse(await readFile(join(directory, filename), "utf8")).key).toBe("one");
      await writeFile(join(directory, filename), "not JSON");
      expect(await cache.get("one")).toBeUndefined();
      await writeFile(join(directory, filename), JSON.stringify({ version: 1, key: "other", value: 1 }));
      expect(await cache.get("one")).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
