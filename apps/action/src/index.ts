import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { Octokit } from "@octokit/rest";
import { createDiskDiscoveryCache, checkSummary } from "@localmesh/github";
import { explainWithOllama } from "@localmesh/engine";
import { uniqueFindings, type PublishedActionResult, type ValidationJob, type ValidationResult } from "@localmesh/shared";
import { eventTarget, prepareRun } from "./discover.js";
import { publishResults } from "./publish.js";
import { sendPlatformResults } from "./platform.js";
import type { ActionEnvelope } from "./types.js";

const argument = (name: string): string | undefined => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const required = (value: string | undefined, name: string): string => { if (!value) throw new Error(`${name} is required.`); return value; };
const readJson = async (path: string): Promise<unknown> => { const text = await readFile(path, "utf8"); if (Buffer.byteLength(text) > 32 * 1024 * 1024) throw new Error("Input exceeds the 32 MiB artifact limit."); return JSON.parse(text); };
function infrastructureFailure(job: ValidationJob, error: unknown): ValidationResult {
  return { jobId: job.id, repository: `${job.owner}/${job.repo}`, currentPr: job.prNumber, headSha: job.headSha, baseSha: job.baseSha, status: "failed", startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), affectedObjects: [], dependencies: [], comparedPullRequests: [], orders: [], rollbacks: [], performance: [],
    contracts: [{ code: "INFRASTRUCTURE_ERROR", severity: "error", title: "Validation did not complete", message: error instanceof Error ? error.message : String(error) }] };
}
async function invokeCli(cli: string, inputPath: string, outputPath: string): Promise<number> {
  // Do not give the SQL analysis process the GitHub publication/discovery token.
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "Path", "HOME", "USERPROFILE", "SystemRoot", "TEMP", "TMP", "DOCKER_HOST", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH", "TESTCONTAINERS_HOST_OVERRIDE", "TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE"]) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  return new Promise((resolveExit, reject) => {
    const child = spawn(process.execPath, [cli, "--input", inputPath, "--output", outputPath], { env: environment, stdio: ["ignore", "ignore", "pipe"] });
    let errorText = "";
    child.stderr.on("data", (data: Buffer) => { errorText = (errorText + data.toString()).slice(-4000); });
    child.on("error", reject);
    child.on("close", (code) => { if (code === 0 || code === 1) resolveExit(code); else reject(new Error(`CLI exited with ${code}: ${errorText}`)); });
  });
}
async function main(): Promise<void> {
  const octokit = new Octokit({ auth: required(process.env.GITHUB_TOKEN, "GITHUB_TOKEN") });
  const payload = await readJson(required(process.env.GITHUB_EVENT_PATH, "GITHUB_EVENT_PATH"));
  const command = process.argv[2];
  if (command === "publish") {
    const event = payload as { workflow_run?: { id: number; run_attempt: number; path: string }; repository?: { name: string; owner: { login: string } } };
    if (process.env.GITHUB_EVENT_NAME !== "workflow_run" || !event.workflow_run || !event.repository) throw new Error("Publication requires a workflow_run event.");
    const envelope = await readJson(required(argument("--results"), "--results")).catch(() => undefined);
    const publishedResults: PublishedActionResult[] = [];
    const ollamaModel = process.env.OLLAMA_MODEL?.trim();
    await publishResults(octokit, { owner: event.repository.owner.login, repo: event.repository.name, runId: event.workflow_run.id, runAttempt: event.workflow_run.run_attempt, workflowPath: ".github/workflows/localmesh-analysis.yml" }, envelope, {
      onPublished: (published) => { publishedResults.push(published); },
      ...(ollamaModel ? { explain: async (result: ValidationResult) => explainWithOllama(uniqueFindings([
        ...result.orders.flatMap((order) => order.findings), ...result.contracts, ...result.rollbacks.flatMap((rollback) => rollback.findings), ...result.performance
      ]), JSON.stringify({
        pullRequests: result.provenance?.pullRequests,
        changes: result.pullRequestChanges,
        executionOrders: result.orders.map(({ order, passed, sqlPassed, executionSteps, findings }) => ({ order, passed, sqlPassed, executionSteps, findingCodes: findings.map((finding) => finding.code) })),
        compatibility: result.compatibility,
        rollbackResults: result.rollbacks,
        dataDifferences: result.dataDifferences
      }), { url: process.env.OLLAMA_URL ?? "http://127.0.0.1:11434", model: ollamaModel, timeoutMs: Number(process.env.OLLAMA_TIMEOUT_MS ?? 120000) }) } : {})
    });
    const platformUrl = process.env.LOCALMESH_PLATFORM_URL?.trim();
    const ingestionSecret = process.env.LOCALMESH_INGESTION_SECRET?.trim();
    if (Boolean(platformUrl) !== Boolean(ingestionSecret)) throw new Error("Set both LOCALMESH_PLATFORM_URL and LOCALMESH_INGESTION_SECRET to enable dashboard ingestion.");
    if (platformUrl && ingestionSecret && publishedResults.length) {
      await sendPlatformResults(platformUrl, ingestionSecret, {
        repository: `${event.repository.owner.login}/${event.repository.name}`,
        runId: event.workflow_run.id,
        runAttempt: event.workflow_run.run_attempt,
        results: publishedResults
      });
    }
    return;
  }
  if (command !== "analyze") throw new Error("Usage: action analyze --cli <trusted-cli.js> --output-directory <dir> | publish --results <file>");
  const event = process.env.GITHUB_EVENT_NAME;
  if (event !== "pull_request" && event !== "push" && event !== "merge_group") throw new Error("Unsupported analysis event.");
  const cli = resolve(required(argument("--cli"), "--cli"));
  const outputDirectory = resolve(required(argument("--output-directory"), "--output-directory"));
  await mkdir(outputDirectory, { recursive: true });
  const run = { id: Number(required(process.env.GITHUB_RUN_ID, "GITHUB_RUN_ID")), attempt: Number(required(process.env.GITHUB_RUN_ATTEMPT, "GITHUB_RUN_ATTEMPT")) };
  let envelope: ActionEnvelope;
  try {
    const cachePath = argument("--cache-directory");
    const prepared = await prepareRun(octokit, event, payload, run, cachePath ? createDiskDiscoveryCache(resolve(cachePath)) : undefined);
    envelope = prepared.envelope;
    for (const target of prepared.targets) {
      const inputPath = join(outputDirectory, `input-${target.job.prNumber}.json`);
      const outputPath = join(outputDirectory, `result-${target.job.prNumber}.json`);
      await writeFile(inputPath, JSON.stringify(target.input, null, 2));
      let result: ValidationResult;
      try {
        const exitCode = await invokeCli(cli, inputPath, outputPath);
        result = await readJson(outputPath) as ValidationResult;
        if ((exitCode === 0) !== (result.status === "passed")) throw new Error("CLI verdict does not match its exit code.");
      } catch (error) { result = infrastructureFailure(target.job, error); }
      envelope.targets.push({ prNumber: target.job.prNumber, headSha: target.job.headSha, baseSha: target.job.baseSha, result });
      if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, `${checkSummary(result)}\n\n`, { flag: "a" });
    }
  } catch (error) {
    const target = eventTarget(event, payload);
    const baseSha = event === "merge_group" || !target.baseSha ? (await octokit.repos.getBranch({ owner: target.owner, repo: target.repo, branch: target.baseRef })).data.commit.sha : target.baseSha;
    envelope = { version: 1, repository: `${target.owner}/${target.repo}`, runId: run.id, runAttempt: run.attempt, event, baseRef: target.baseRef, baseSha, ...(event === "merge_group" ? { queueBaseSha: target.baseSha! } : {}), targets: [], error: error instanceof Error ? error.message : String(error) };
    process.exitCode = 2;
  }
  await writeFile(join(outputDirectory, "localmesh-results.json"), JSON.stringify(envelope, null, 2));
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2; });
