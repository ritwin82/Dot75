import { randomUUID } from "node:crypto";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import { PgBoss } from "pg-boss";
import {
  cancelStaleJobs, databaseReady, ensureSchema, forgetWebhookDelivery, getGitHubUserCredential, getJob, getJobForUser, linkUserInstallation,
  listInstallationsForUser, listJobEvents, listJobs, listJobsForUser, listRepositoriesForUser, listRepositoryJobs,
  listRepositoryJobsForUser, recordWebhookDelivery,
  replaceInstallationRepositories, saveActionResults, saveJob, setCheckRunId, setGitHubInstallationStatus,
  updateInstallationRepositories, upsertGitHubInstallation, upsertGitHubUser, validationJobStatusCounts
} from "@localmesh/db";
import {
  cancelCheck, createCheck, getInstallationRecord, installationClient,
  listInstallationRepositories, verifyWebhookSignature
} from "@localmesh/github";
import { ENGINE_VERSION, formatValidationResult, type ReportFormat, type RepositoryRefreshJob, type ValidationJob, type ValidationResult } from "@localmesh/shared";
import { ActionIngestionError, authenticateActionIngestion } from "./action-ingestion.js";
import { defaultBranchPush, installationFromWebhook, repositoryFromWebhook } from "./account-webhook.js";
import {
  authConfiguration, createInstallationState, createOAuthState, createSession, oauthStateCookieName, openCredential,
  readCookie, readInstallationState, readSession, sealCredential, sessionCookie, shortCookie, verifyOAuthState, type SessionIdentity
} from "./auth.js";
import { exchangeGitHubCode, githubAuthorizationUrl, githubInstallationUrl, userCanAccessInstallation } from "./github-oauth.js";
import { extractPullRequest, resolveValidationBase } from "./webhook.js";
import { buildCompatibilityGraph, type CompatibilityJob } from "./compatibility.js";
import { renderMetrics } from "./metrics.js";
import { openApiDocument } from "./openapi.js";
import { buildRecurrenceSnapshot } from "./recurrence.js";

const server = Fastify({ logger: true, bodyLimit: 2_000_000 });
const auth = authConfiguration();
await server.register(cors, { origin: process.env.WEB_ORIGIN ?? "http://localhost:3000", credentials: true });
server.addContentTypeParser("application/json", { parseAs: "buffer" }, (_request, body, done) => done(null, body));

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
await ensureSchema();
const boss = new PgBoss({ connectionString: databaseUrl });
await boss.start();
await boss.createQueue("validate-pr");
await boss.createQueue("refresh-repository");

function identity(request: FastifyRequest): SessionIdentity | undefined {
  return auth ? readSession(request.headers.cookie, auth.sessionSecret) : undefined;
}

function requireIdentity(request: FastifyRequest, reply: FastifyReply): SessionIdentity | undefined {
  const current = identity(request);
  if (!current) void reply.code(401).send({ error: "GitHub sign-in is required" });
  return current;
}

async function enqueueValidation(
  client: Awaited<ReturnType<typeof installationClient>>,
  installationId: number,
  input: Omit<ValidationJob, "id" | "installationId" | "checkRunId" | "trigger">,
  trigger: NonNullable<ValidationJob["trigger"]>
): Promise<{ accepted: boolean; jobId?: string; checkRunId?: number }> {
  const stale = input.prNumber === 0 ? [] : await cancelStaleJobs(input.owner, input.repo, input.prNumber, input.headSha);
  await Promise.all(stale.flatMap((old) => old.checkRunId ? [cancelCheck(client, input.owner, input.repo, old.checkRunId)] : []));
  const job: ValidationJob = { id: randomUUID(), installationId, ...input, trigger, engineVersion: ENGINE_VERSION };
  if (!await saveJob(job)) return { accepted: false };
  const checkRunId = await createCheck(client, input.owner, input.repo, input.headSha);
  job.checkRunId = checkRunId;
  await setCheckRunId(job.id, checkRunId);
  await boss.send("validate-pr", job, { singletonKey: `${input.owner}/${input.repo}#${input.prNumber}:${input.headSha}:${input.baseSha}` });
  return { accepted: true, jobId: job.id, checkRunId };
}

server.get("/health", async () => ({ status: "ok", service: "localmesh-api", accountConnection: auth ? "configured" : "disabled" }));
server.get("/health/live", async () => ({ status: "ok" }));
server.get("/health/ready", async (_request, reply) => await databaseReady()
  ? { status: "ready", database: true, queue: true }
  : reply.code(503).send({ status: "not_ready", database: false, queue: true }));
server.get("/metrics", async (_request, reply) => reply
  .header("content-type", "text/plain; version=0.0.4; charset=utf-8")
  .send(renderMetrics(await validationJobStatusCounts(), 0)));
server.get("/api/openapi.json", async () => openApiDocument(process.env.API_PUBLIC_ORIGIN ?? `http://localhost:${process.env.API_PORT ?? 4100}`));

server.get("/auth/github", async (_request, reply) => {
  if (!auth) return reply.code(503).send({ error: "GitHub account connection is not configured" });
  const state = createOAuthState(auth.sessionSecret);
  return reply.header("set-cookie", shortCookie(oauthStateCookieName, state, auth)).redirect(githubAuthorizationUrl(auth, state));
});

server.get("/auth/github/callback", async (request, reply) => {
  if (!auth) return reply.code(503).send({ error: "GitHub account connection is not configured" });
  const query = request.query as { code?: string; state?: string };
  const stateCookie = readCookie(request.headers.cookie, oauthStateCookieName);
  if (!query.code || !verifyOAuthState(query.state, stateCookie, auth.sessionSecret)) return reply.code(400).send({ error: "Invalid or expired GitHub sign-in state" });
  const user = await exchangeGitHubCode(auth, query.code);
  await upsertGitHubUser({ ...user, accessTokenCiphertext: sealCredential(user.accessToken, auth.sessionSecret) });
  const token = createSession({ userId: user.id, login: user.login }, auth.sessionSecret);
  return reply
    .headers({ "set-cookie": [sessionCookie(token, auth), shortCookie(oauthStateCookieName, "", auth, 0)] })
    .redirect(`${auth.webOrigin.replace(/\/$/, "")}/dashboard`);
});

server.post("/auth/logout", async (_request, reply) => {
  if (!auth) return reply.code(204).send();
  return reply.header("set-cookie", sessionCookie("", auth, 0)).code(204).send();
});

server.get("/api/session", async (request, reply) => {
  if (!auth) return { authEnabled: false };
  const current = requireIdentity(request, reply);
  if (!current) return;
  return { authEnabled: true, user: current };
});

server.get("/api/github/install-url", async (request, reply) => {
  if (!auth) return reply.code(503).send({ error: "GitHub account connection is not configured" });
  const current = requireIdentity(request, reply);
  if (!current) return;
  return { url: githubInstallationUrl(auth, createInstallationState(current, auth.sessionSecret)) };
});

server.get("/github/setup", async (request, reply) => {
  if (!auth) return reply.code(503).send({ error: "GitHub account connection is not configured" });
  const query = request.query as { installation_id?: string; state?: string };
  const current = requireIdentity(request, reply);
  if (!current) return;
  const stateIdentity = readInstallationState(query.state, auth.sessionSecret);
  const installationId = Number(query.installation_id);
  const stateMatches = query.state === undefined || (stateIdentity?.userId === current.userId && stateIdentity.login === current.login);
  if (!stateMatches || !Number.isSafeInteger(installationId) || installationId <= 0) {
    return reply.code(400).send({ error: "Invalid or expired GitHub installation state" });
  }
  const encryptedCredential = await getGitHubUserCredential(current.userId);
  if (!encryptedCredential || !await userCanAccessInstallation(openCredential(encryptedCredential, auth.sessionSecret), installationId)) {
    return reply.code(403).send({ error: "GitHub did not authorize this user for the requested installation" });
  }
  const installation = await getInstallationRecord(installationId);
  const repositories = await listInstallationRepositories(installationId);
  await upsertGitHubInstallation(installation);
  await linkUserInstallation(current.userId, installationId);
  await replaceInstallationRepositories(installationId, repositories);
  return reply.redirect(`${auth.webOrigin.replace(/\/$/, "")}/dashboard?connected=${encodeURIComponent(installation.accountLogin)}`);
});

server.get("/api/installations", async (request, reply) => {
  const current = requireIdentity(request, reply);
  if (!current) return;
  return { installations: await listInstallationsForUser(current.userId), repositories: await listRepositoriesForUser(current.userId) };
});

server.get("/api/jobs", async (request, reply) => {
  const query = request.query as { limit?: string };
  const requestedLimit = Number(query.limit ?? 50);
  const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0 ? requestedLimit : 50;
  if (!auth) return { jobs: await listJobs(limit) };
  const current = requireIdentity(request, reply);
  if (!current) return;
  return { jobs: await listJobsForUser(current.userId, limit) };
});

server.get("/api/jobs/:id", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const job = auth ? await (async () => {
    const current = requireIdentity(request, reply);
    return current ? getJobForUser(id, current.userId) : null;
  })() : await getJob(id);
  if (reply.sent) return;
  return job ?? reply.code(404).send({ error: "Job not found" });
});

server.get("/api/jobs/:id/export/:format", async (request, reply) => {
  const { id, format } = request.params as { id: string; format: string };
  const job = auth ? await (async () => {
    const current = requireIdentity(request, reply);
    return current ? getJobForUser(id, current.userId) : null;
  })() : await getJob(id);
  if (reply.sent) return;
  if (!job) return reply.code(404).send({ error: "Job not found" });
  const result = (job as { result?: ValidationResult }).result;
  if (!result) return reply.code(409).send({ error: "This validation does not have a completed result yet" });
  if (!["json", "markdown", "sarif", "junit"].includes(format)) return reply.code(400).send({ error: "Unsupported export format" });
  const selected = format as Exclude<ReportFormat, "human">;
  const extensions = { json: "json", markdown: "md", sarif: "sarif", junit: "xml" };
  const contentTypes = { json: "application/json", markdown: "text/markdown; charset=utf-8", sarif: "application/sarif+json", junit: "application/xml; charset=utf-8" };
  return reply.header("content-type", contentTypes[selected]).header("content-disposition", `attachment; filename=localmesh-${id}.${extensions[selected]}`).send(formatValidationResult(result, selected));
});

server.get("/api/jobs/:id/events", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const job = auth ? await (async () => {
    const current = requireIdentity(request, reply);
    return current ? getJobForUser(id, current.userId) : null;
  })() : await getJob(id);
  if (reply.sent) return;
  if (!job) return reply.code(404).send({ error: "Job not found" });
  const requestedAfter = Number((request.query as { after?: string }).after ?? 0);
  const after = Number.isSafeInteger(requestedAfter) && requestedAfter >= 0 ? requestedAfter : 0;
  if (!request.headers.accept?.includes("text/event-stream")) return { events: await listJobEvents(id, after) };
  reply.hijack();
  reply.raw.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
  let cursor = after;
  let active = true;
  const flush = async () => {
    try {
      for (const event of await listJobEvents(id, cursor)) {
        cursor = event.id;
        reply.raw.write(`id: ${event.id}\nevent: job-stage\ndata: ${JSON.stringify(event)}\n\n`);
      }
    } catch (error) {
      reply.raw.write(`event: error\ndata: ${JSON.stringify({ message: error instanceof Error ? error.message : String(error) })}\n\n`);
    }
  };
  await flush();
  const timer = setInterval(() => { if (active) void flush(); }, 1000);
  const heartbeat = setInterval(() => { if (active) reply.raw.write(": keep-alive\n\n"); }, 15000);
  request.raw.once("close", () => { active = false; clearInterval(timer); clearInterval(heartbeat); });
});

server.get("/api/repositories/:owner/:repo/compatibility", async (request, reply) => {
  const { owner, repo } = request.params as { owner: string; repo: string };
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return reply.code(400).send({ error: "Invalid repository" });
  const jobs = auth ? await (async () => {
    const current = requireIdentity(request, reply);
    return current ? listRepositoryJobsForUser(current.userId, owner, repo) : [];
  })() : await listRepositoryJobs(owner, repo);
  if (reply.sent) return;
  const graph = buildCompatibilityGraph(`${owner}/${repo}`, jobs as CompatibilityJob[]);
  return graph ?? reply.code(404).send({ error: "No completed validation snapshot exists for this repository" });
});

server.get("/api/repositories/:owner/:repo/recurrence", async (request, reply) => {
  const { owner, repo } = request.params as { owner: string; repo: string };
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return reply.code(400).send({ error: "Invalid repository" });
  const jobs = auth ? await (async () => {
    const current = requireIdentity(request, reply);
    return current ? listRepositoryJobsForUser(current.userId, owner, repo, 500) : [];
  })() : await listRepositoryJobs(owner, repo, 500);
  if (reply.sent) return;
  return buildRecurrenceSnapshot(`${owner}/${repo}`, jobs as CompatibilityJob[]);
});

server.post("/api/action-results", { bodyLimit: 32 * 1024 * 1024 }, async (request, reply) => {
  const secret = process.env.LOCALMESH_INGESTION_SECRET;
  if (!secret) return reply.code(503).send({ error: "Action ingestion is not configured" });
  try {
    const payload = authenticateActionIngestion(request.body as Buffer, request.headers["x-localmesh-signature-256"] as string | undefined, secret);
    const saved = await saveActionResults(payload.repository, payload.results);
    return reply.code(202).send({ accepted: true, repository: payload.repository, saved });
  } catch (error) {
    if (error instanceof ActionIngestionError) return reply.code(error.statusCode).send({ error: error.message });
    throw error;
  }
});

server.post("/webhooks/github", async (request, reply) => {
  const raw = request.body as Buffer;
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) return reply.code(503).send({ error: "Webhook secret is not configured" });
  if (!verifyWebhookSignature(raw, request.headers["x-hub-signature-256"] as string | undefined, secret)) return reply.code(401).send({ error: "Invalid webhook signature" });
  const event = request.headers["x-github-event"] as string | undefined;
  const deliveryId = request.headers["x-github-delivery"] as string | undefined;
  if (!event || !deliveryId) return reply.code(422).send({ error: "Missing GitHub event or delivery identity" });
  let payload: Record<string, any>;
  try { payload = JSON.parse(raw.toString("utf8")) as Record<string, any>; }
  catch { return reply.code(400).send({ error: "Invalid webhook JSON" }); }
  const parsedInstallationId = Number(payload.installation?.id);
  const installationId = Number.isSafeInteger(parsedInstallationId) && parsedInstallationId > 0 ? parsedInstallationId : undefined;
  if (!await recordWebhookDelivery(deliveryId, event, installationId)) return reply.code(202).send({ duplicate: true, deliveryId });

  try {
    if (event === "ping") return reply.send({ ok: true });
    if (event === "installation") {
      const action = String(payload.action);
      const status = action === "deleted" ? "deleted" : action === "suspended" ? "suspended" : "active";
      const installation = installationFromWebhook(payload, status);
      await upsertGitHubInstallation(installation);
      if (status === "active") await replaceInstallationRepositories(installation.id, await listInstallationRepositories(installation.id));
      else await setGitHubInstallationStatus(installation.id, status);
      return reply.code(202).send({ accepted: true, event, installationId: installation.id, status });
    }
    if (event === "installation_repositories") {
      const installation = installationFromWebhook(payload);
      await upsertGitHubInstallation(installation);
      await updateInstallationRepositories(
        installation.id,
        (payload.repositories_added ?? []).map(repositoryFromWebhook),
        (payload.repositories_removed ?? []).map((repository: unknown) => repositoryFromWebhook(repository).id)
      );
      return reply.code(202).send({ accepted: true, event, installationId: installation.id });
    }
    if (event === "repository" && installationId) {
      const installation = await getInstallationRecord(installationId);
      await upsertGitHubInstallation(installation);
      await replaceInstallationRepositories(installationId, await listInstallationRepositories(installationId));
      return reply.code(202).send({ accepted: true, event, installationId });
    }
    if (!installationId) return reply.code(422).send({ error: "Missing installation id" });
    const client = await installationClient(installationId);
    const extracted = extractPullRequest(event, payload);
    if (extracted) {
      const input = await resolveValidationBase(client, extracted, event, payload);
      return reply.code(202).send(await enqueueValidation(client, installationId, input, event === "merge_group" ? "merge_group" : "pull_request"));
    }
    if (event === "push") {
      const pushed = defaultBranchPush(payload);
      if (!pushed) return reply.code(202).send({ ignored: true, event, reason: "not a live default-branch push" });
      const refresh: RepositoryRefreshJob = { installationId, ...pushed };
      await boss.send("refresh-repository", refresh, { singletonKey: `${pushed.owner}/${pushed.repo}:${pushed.baseSha}` });
      return reply.code(202).send({ accepted: true, event, refreshQueued: true, baseSha: pushed.baseSha });
    }
    return reply.code(202).send({ ignored: true, event });
  } catch (error) {
    await forgetWebhookDelivery(deliveryId);
    throw error;
  }
});

const port = Number(process.env.API_PORT ?? 4100);
await server.listen({ host: "0.0.0.0", port });
async function shutdown(): Promise<void> { await server.close(); await boss.stop(); process.exit(0); }
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
