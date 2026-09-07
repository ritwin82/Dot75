import { randomUUID } from "node:crypto";
import { explainWithOllama, parseValidationInput, runValidationInput, validationPlanFromInput } from "@localmesh/engine";
import { createDiskDiscoveryCache, discoverMigrationPullRequests, discoverRevisionMigrations, getTextFile, installationClient, listMigrations, listSqlFiles, markCheckInfrastructureFailure, markCheckRunning, updateCheck, upsertStickyComment, type DiscoveryIssue } from "@localmesh/github";
import { defaultConfig, parseConfig, type Finding, type ValidationJob, type ValidationResult } from "@localmesh/shared";
import { isJobCancelled, setJobStatus } from "@localmesh/db";
import { explanationContext, resultFindings } from "./validation-plan.js";

function discoveryFindings(issues: DiscoveryIssue[], currentPr: number): Finding[] {
  return issues.map((issue) => ({
    code: issue.code, severity: "error", title: "Migration discovery needs a reviewed fix",
    message: `${(issue.prNumber ?? currentPr) === 0 ? "Merge queue" : `PR #${issue.prNumber ?? currentPr}`}: ${issue.message} Affected files: ${issue.files.join(", ")}.`,
    evidence: { prNumber: issue.prNumber ?? currentPr, files: issue.files, headSha: issue.headSha }
  }));
}

export async function validateJob(job: ValidationJob): Promise<ValidationResult> {
  try {
    const octokit = await installationClient(job.installationId);
    if (job.checkRunId) await markCheckRunning(octokit, job.owner, job.repo, job.checkRunId);
    await setJobStatus(job.id, "running");
    // PR SQL is untrusted input; policies, fixtures and metadata come from the exact target revision.
    const read = (path: string) => getTextFile(octokit, job.owner, job.repo, path, job.baseSha);
    const configText = await read("localmesh.yml");
    const config = configText !== undefined ? parseConfig(configText) : defaultConfig;
    if (["rails", "django", "alembic"].includes(config.migrations.adapter)) throw new Error(`The ${config.migrations.adapter} adapter requires an isolated project runner and is not enabled.`);
    if (config.migrations.adapter === "raw-sql" && (config.migrations.up_pattern !== "*.up.sql" || config.migrations.down_pattern !== "*.down.sql")) throw new Error("The raw SQL adapter requires migration patterns *.up.sql and *.down.sql; custom patterns cannot be safely interpreted.");
    const pr = job.prNumber === 0 ? {
      title: "Merge queue", user: { login: "github-merge-queue" }, base: { ref: "" },
      head: { repo: { owner: { login: job.owner }, name: job.repo } }
    } : (await octokit.pulls.get({ owner: job.owner, repo: job.repo, pull_number: job.prNumber })).data;
    if (!pr.head.repo) throw new Error(`The source repository for PR #${job.prNumber} is unavailable.`);
    const cache = createDiskDiscoveryCache(process.env.LOCALMESH_DISCOVERY_CACHE ?? ".localmesh-cache/github");
    const revisionOptions = { owner: job.owner, repo: job.repo, baseSha: job.baseSha, directory: config.migrations.directory, adapter: config.migrations.adapter, cache };
    const current = await discoverRevisionMigrations(octokit, { ...revisionOptions, headSha: job.headSha, headOwner: pr.head.repo.owner.login, headRepo: pr.head.repo.name });
    const hasChanges = current.migrations.length > 0 || current.issues.length > 0;
    const [baseline, peers, fixtures, mappingText, metadataText] = hasChanges ? await Promise.all([
      listMigrations(octokit, job.owner, job.repo, job.baseSha, config.migrations.directory, config.migrations.adapter),
      job.prNumber !== 0 && config.checks.compare_open_pull_requests ? discoverMigrationPullRequests(octokit, { ...revisionOptions, baseRef: pr.base.ref, excludePr: job.prNumber, includeDrafts: true }) : Promise.resolve({ pullRequests: [], issues: [] }),
      listSqlFiles(octokit, job.owner, job.repo, job.baseSha, config.contracts.fixtures_directory),
      read(config.contracts.mappings_file), read(config.performance.metadata_file)
    ]) : [[], { pullRequests: [], issues: [] }, [], undefined, undefined];
    const input = parseValidationInput({
      version: 1, job, config, baseline, current: { pr: job.prNumber, files: current.migrations },
      candidates: peers.pullRequests.map((peer) => ({ pr: peer.number, files: peer.migrations })), fixtures,
      ...(mappingText !== undefined ? { mappingsText: mappingText } : {}), ...(metadataText !== undefined ? { metadataText } : {}),
      discoveryFindings: discoveryFindings([...current.issues, ...peers.issues], job.prNumber),
      provenance: {
        trigger: job.trigger ?? (job.prNumber === 0 ? "merge_group" : "github_app"), currentPrFiles: current.migrations.map((file) => file.path),
        pullRequests: [{ number: job.prNumber, author: pr.user?.login ?? "unknown", headSha: job.headSha, title: pr.title }, ...peers.pullRequests.map((peer) => ({ number: peer.number, author: peer.author, headSha: peer.headSha, title: peer.title }))]
      }
    });
    const result = await runValidationInput(input);
    if (await isJobCancelled(job.id)) { result.status = "cancelled"; return result; }
    const findings = resultFindings(result);
    const model = process.env.OLLAMA_MODEL || config.ai?.model;
    result.explanationStatus = model ? "pending" : "complete";
    // Make verified evidence available before waiting on local inference.
    await setJobStatus(job.id, result.status, result);
    if (job.checkRunId) await updateCheck(octokit, job.owner, job.repo, job.checkRunId, result);
    if (job.prNumber > 0 && job.trigger !== "push") {
      const botLogin = process.env.GITHUB_APP_BOT_LOGIN ?? (process.env.GITHUB_APP_SLUG ? `${process.env.GITHUB_APP_SLUG}[bot]` : undefined);
      await upsertStickyComment(octokit, job.owner, job.repo, result, botLogin ? { botLogin } : {});
    }
    if (model) {
      result.explanation = await explainWithOllama(findings, explanationContext(validationPlanFromInput(input), result), {
        url: process.env.OLLAMA_URL ?? "http://localhost:11434", model, timeoutMs: Number(process.env.OLLAMA_TIMEOUT_MS ?? 120000)
      });
      result.explanationStatus = "complete";
      if (await isJobCancelled(job.id)) { result.status = "cancelled"; return result; }
      await setJobStatus(job.id, result.status, result);
      if (job.checkRunId) await updateCheck(octokit, job.owner, job.repo, job.checkRunId, result);
      if (job.prNumber > 0 && job.trigger !== "push") {
        const botLogin = process.env.GITHUB_APP_BOT_LOGIN ?? (process.env.GITHUB_APP_SLUG ? `${process.env.GITHUB_APP_SLUG}[bot]` : undefined);
        await upsertStickyComment(octokit, job.owner, job.repo, result, botLogin ? { botLogin } : {});
      }
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    await setJobStatus(job.id, "failed", undefined, message);
    if (job.checkRunId) {
      try { await markCheckInfrastructureFailure(await installationClient(job.installationId), job.owner, job.repo, job.checkRunId, message); } catch { /* Keep the original failure. */ }
    }
    throw error;
  }
}

export function demoJob(): ValidationJob { return { id: randomUUID(), installationId: 0, owner: "demo", repo: "demo", prNumber: 1, headSha: "demo", baseSha: "demo" }; }
