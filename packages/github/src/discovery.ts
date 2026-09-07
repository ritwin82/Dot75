import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Octokit } from "@octokit/rest";
import type { MigrationAdapterName,MigrationFile, PullRequestRef } from "@localmesh/shared";

/** Store only immutable Git objects here; PR listings and branch names are never cached. */
export interface DiscoveryCache {
  get(key: string): Promise<unknown | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

export interface DiscoveryStats {
  candidatePullRequests: number;
  migrationPullRequests: number;
  cacheHits: number;
  cacheMisses: number;
}

export interface DiscoveryIssue {
  code: "MIGRATION_HISTORY_CHANGED" | "UNSUPPORTED_MIGRATION_NAME";
  message: string;
  files: string[];
  headSha: string;
  prNumber?: number;
}

interface RepositoryOptions {
  owner: string;
  repo: string;
  /** The trusted, immutable target branch revision used by the validator. */
  baseSha: string;
  directory: string;
  adapter?: MigrationAdapterName;
  cache?: DiscoveryCache;
}

export interface RevisionDiscoveryOptions extends RepositoryOptions {
  headSha: string;
  headOwner?: string;
  headRepo?: string;
}

export interface PullRequestDiscoveryOptions extends RepositoryOptions {
  baseRef?: string;
  excludePr?: number;
  includeDrafts?: boolean;
}

export interface RevisionDiscoveryResult {
  migrations: MigrationFile[];
  /** Every issue must fail validation; an empty migrations list alone is not a safe verdict. */
  issues: DiscoveryIssue[];
  stats: DiscoveryStats;
}

export interface PullRequestDiscoveryResult {
  pullRequests: PullRequestRef[];
  issues: DiscoveryIssue[];
  stats: DiscoveryStats;
}

interface TreeFile { path: string; sha: string }
const shaPattern = /^[a-f0-9]{40}$/i;
const emptyStats = (): DiscoveryStats => ({ candidatePullRequests: 0, migrationPullRequests: 0, cacheHits: 0, cacheMisses: 0 });

export const migrationAdapters:Record<MigrationAdapterName,{version:1;execution:"sql"|"project-container";extensions:string[]}>= {
  "raw-sql":{version:1,execution:"sql",extensions:[".sql"]},prisma:{version:1,execution:"sql",extensions:[".sql"]},drizzle:{version:1,execution:"sql",extensions:[".sql"]},
  flyway:{version:1,execution:"sql",extensions:[".sql"]},liquibase:{version:1,execution:"sql",extensions:[".sql"]},
  rails:{version:1,execution:"project-container",extensions:[".rb"]},django:{version:1,execution:"project-container",extensions:[".py"]},alembic:{version:1,execution:"project-container",extensions:[".py"]}
};

const flywayOrder=(version:string)=>version.split(/[._]/).reduce((value,part)=>value*1000+Number(part),0);
export function migrationDescriptor(path:string,adapter:MigrationAdapterName="raw-sql"):{direction:"up"|"down";order:number}|undefined{
  const name=path.split("/").at(-1)??"";
  if(adapter==="raw-sql"){
    const direction=path.endsWith(".up.sql")?"up":path.endsWith(".down.sql")?"down":undefined;if(!direction)return undefined;
    const order=name.match(/^(\d+)/)?.[1];return {direction,order:order?Number(order):Number.MAX_SAFE_INTEGER};
  }
  if(adapter==="prisma"){
    if(name!=="migration.sql")return undefined;const directory=path.split("/").at(-2)??"";const order=directory.match(/^(\d+)/)?.[1];
    return {direction:"up",order:order?Number(order):Number.MAX_SAFE_INTEGER};
  }
  if(adapter==="drizzle") {const order=name.match(/^(\d+)[_-].*\.sql$/)?.[1];return order?{direction:"up",order:Number(order)}:undefined;}
  if(adapter==="flyway") {
    const versioned=name.match(/^V([0-9][0-9._]*)__.+\.sql$/i);if(versioned)return {direction:"up",order:flywayOrder(versioned[1]!)};
    const undo=name.match(/^U([0-9][0-9._]*)__.+\.sql$/i);if(undo)return {direction:"down",order:flywayOrder(undo[1]!)};
    return /^R__.+\.sql$/i.test(name)?{direction:"up",order:Number.MAX_SAFE_INTEGER}:undefined;
  }
  if(adapter==="liquibase"&&name.endsWith(".sql")) {const order=name.match(/^(\d+)/)?.[1];return {direction:"up",order:order?Number(order):Number.MAX_SAFE_INTEGER};}
  return undefined;
}

export function migrationFilesFromSource(path:string,sql:string,adapter:MigrationAdapterName="raw-sql"):MigrationFile[] {
  const descriptor=migrationDescriptor(path,adapter);if(!descriptor)return [];
  const files:MigrationFile[]=[{path,sql,...descriptor}];
  if(adapter==="liquibase"&&/--\s*liquibase\s+formatted\s+sql/i.test(sql)) {
    const rollback=sql.split(/\r?\n/).map((line)=>line.match(/^\s*--\s*rollback\s+(.+)$/i)?.[1]).filter((line):line is string=>Boolean(line));
    if(rollback.length)files.push({path:`${path}#rollback`,sql:`${rollback.join("\n")}\n`,direction:"down",order:descriptor.order});
  }
  return files;
}

export function createDiskDiscoveryCache(directory: string): DiscoveryCache {
  const filePath = (key: string) => join(directory, `${createHash("sha256").update(key).digest("hex")}.json`);
  return {
    async get(key) {
      try {
        const envelope: unknown = JSON.parse(await readFile(filePath(key), "utf8"));
        if (!isRecord(envelope) || envelope.version !== 1 || envelope.key !== key) return undefined;
        return envelope.value;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return undefined;
        throw error;
      }
    },
    async set(key, value) {
      await mkdir(directory, { recursive: true });
      const destination = filePath(key);
      const temporary = `${destination}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify({ version: 1, key, value }), "utf8");
      await rename(temporary, destination);
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTreeFiles(value: unknown): value is TreeFile[] {
  return Array.isArray(value) && value.every((entry: unknown) => isRecord(entry) && typeof entry.path === "string" && typeof entry.sha === "string" && shaPattern.test(entry.sha));
}

export function migrationDirectoryPrefix(directory: string): string {
  const normalized = directory.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (normalized === ".") return "";
  if (!normalized || normalized.startsWith("/") || normalized.split("/").some((part) => !part || part === "." || part === ".." || part.includes(":"))) {
    throw new Error("The migrations directory must be a relative repository path without parent traversal.");
  }
  return `${normalized}/`;
}

async function cached<T>(cache: DiscoveryCache | undefined, stats: DiscoveryStats, key: string, valid: (value: unknown) => value is T, read: () => Promise<T>): Promise<T> {
  const existing = await cache?.get(key);
  if (valid(existing)) {
    stats.cacheHits++;
    return existing;
  }
  stats.cacheMisses++;
  const value = await read();
  if (!valid(value)) throw new Error(`GitHub returned invalid discovery data for ${key}.`);
  await cache?.set(key, value);
  return value;
}

async function treeFiles(octokit: Octokit, owner: string, repo: string, sha: string, cache: DiscoveryCache | undefined, stats: DiscoveryStats): Promise<TreeFile[]> {
  return cached(cache, stats, `localmesh-discovery-v1:tree:${owner}/${repo}:${sha}`, isTreeFiles, async () => {
    const { data } = await octokit.git.getTree({ owner, repo, tree_sha: sha, recursive: "true" });
    if (data.truncated) throw new Error(`GitHub truncated the file tree for ${owner}/${repo}@${sha}; migration discovery is incomplete and cannot pass.`);
    return data.tree.filter((entry) => entry.type === "blob" && entry.path && entry.sha).map((entry) => ({ path: entry.path!, sha: entry.sha! }));
  });
}

/**
 * Diff immutable trees at the merge base and head, then check the trusted current
 * baseline. This avoids the mutable pulls.listFiles race and its 3,000-file cap.
 * Existing migrations are append-only: changing/removing them cannot be modeled
 * as applying a new migration and therefore fails closed.
 */
export async function discoverRevisionMigrations(octokit: Octokit, options: RevisionDiscoveryOptions): Promise<RevisionDiscoveryResult> {
  const { owner, repo, baseSha, headSha, cache } = options;
  if (!shaPattern.test(baseSha) || !shaPattern.test(headSha)) throw new Error("Migration discovery requires full immutable base and head commit SHAs.");
  const prefix = migrationDirectoryPrefix(options.directory);
  const headOwner = options.headOwner ?? owner;
  const headRepo = options.headRepo ?? repo;
  const stats = emptyStats();
  const mergeBase = await cached(cache, stats, `localmesh-discovery-v1:merge-base:${owner}/${repo}:${baseSha}:${headOwner}/${headRepo}:${headSha}`, (value): value is string => typeof value === "string" && shaPattern.test(value), async () => {
    const head = headOwner === owner && headRepo === repo ? headSha : `${headOwner}:${headSha}`;
    const { data } = await octokit.repos.compareCommitsWithBasehead({ owner, repo, basehead: `${baseSha}...${head}`, per_page: 1 });
    return data.merge_base_commit.sha;
  });
  const before = new Map((await treeFiles(octokit, owner, repo, mergeBase, cache, stats)).map((file) => [file.path, file.sha]));
  const after = new Map((await treeFiles(octokit, headOwner, headRepo, headSha, cache, stats)).map((file) => [file.path, file.sha]));
  const baseline = mergeBase === baseSha ? before : new Map((await treeFiles(octokit, owner, repo, baseSha, cache, stats)).map((file) => [file.path, file.sha]));
  const adapter=options.adapter??"raw-sql";const extensions=migrationAdapters[adapter].extensions;
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter((path) => path.startsWith(prefix) && extensions.some((extension)=>path.endsWith(extension)) && before.get(path) !== after.get(path)).sort();
  const historyChanges: string[] = [];
  const unsupported: string[] = [];
  const migrations: MigrationFile[] = [];
  for (const path of changed) {
    const headBlob = after.get(path);
    if (before.has(path) || (baseline.has(path) && baseline.get(path) !== headBlob)) {
      historyChanges.push(path);
      continue;
    }
    // A branch addition already applied identically on the target is not pending.
    if (baseline.get(path) === headBlob) continue;
    const descriptor=migrationDescriptor(path,options.adapter);
    if (!descriptor) {
      unsupported.push(path);
      continue;
    }
    if (!headBlob) throw new Error(`Missing immutable blob for ${path} at ${headSha}.`);
    const sql = await cached(cache, stats, `localmesh-discovery-v1:blob:${headOwner}/${headRepo}:${headBlob}`, (value): value is string => typeof value === "string" && createHash("sha1").update(`blob ${Buffer.byteLength(value)}\0`).update(value).digest("hex") === headBlob.toLowerCase(), async () => {
      const { data } = await octokit.git.getBlob({ owner: headOwner, repo: headRepo, file_sha: headBlob });
      if (data.encoding !== "base64") throw new Error(`Unsupported blob encoding for ${path} at ${headSha}.`);
      const decoded = Buffer.from(data.content, "base64");
      // Verify content-addressed reads before caching them for another PR.
      const actual = createHash("sha1").update(`blob ${decoded.length}\0`).update(decoded).digest("hex");
      if (actual !== headBlob.toLowerCase()) throw new Error(`GitHub blob content does not match its immutable SHA for ${path}.`);
      return decoded.toString("utf8");
    });
    migrations.push(...migrationFilesFromSource(path,sql,adapter));
  }
  const issues: DiscoveryIssue[] = [];
  if (historyChanges.length) issues.push({ code: "MIGRATION_HISTORY_CHANGED", message: "Previously committed migrations were changed, removed, or renamed. Add a new forward migration and its rollback instead; replaying edited history would not model the deployed database.", files: historyChanges, headSha });
  if (unsupported.length) issues.push({ code: "UNSUPPORTED_MIGRATION_NAME", message: `SQL files do not match the configured ${options.adapter??"raw-sql"} migration adapter.`, files: unsupported, headSha });
  return { migrations: migrations.sort((a, b) => a.order - b.order || a.path.localeCompare(b.path)), issues, stats };
}

/** Discover all open migration PRs at one trusted base revision, without checkout. */
export async function discoverMigrationPullRequests(octokit: Octokit, options: PullRequestDiscoveryOptions): Promise<PullRequestDiscoveryResult> {
  const { owner, repo, baseSha, directory, cache } = options;
  const prs = await octokit.paginate(octokit.pulls.list, { owner, repo, state: "open", per_page: 100, ...(options.baseRef ? { base: options.baseRef } : {}) });
  const pullRequests: PullRequestRef[] = [];
  const issues: DiscoveryIssue[] = [];
  const stats = emptyStats();
  for (const pr of prs) {
    if (pr.number === options.excludePr || (!options.includeDrafts && pr.draft) || (options.baseRef && pr.base.ref !== options.baseRef)) continue;
    stats.candidatePullRequests++;
    if (!pr.head.repo) throw new Error(`The source repository for open PR #${pr.number} is unavailable; discovery cannot safely omit it.`);
    const result = await discoverRevisionMigrations(octokit, { owner, repo, baseSha, headSha: pr.head.sha, directory, ...(options.adapter?{adapter:options.adapter}:{}), headOwner: pr.head.repo.owner.login, headRepo: pr.head.repo.name, ...(cache ? { cache } : {}) });
    stats.cacheHits += result.stats.cacheHits;
    stats.cacheMisses += result.stats.cacheMisses;
    if (!result.migrations.length && !result.issues.length) continue;
    stats.migrationPullRequests++;
    pullRequests.push({ number: pr.number, title: pr.title, author: pr.user?.login ?? "unknown", baseSha, headSha: pr.head.sha, migrations: result.migrations });
    issues.push(...result.issues.map((issue) => ({ ...issue, prNumber: pr.number })));
  }
  return { pullRequests, issues, stats };
}
