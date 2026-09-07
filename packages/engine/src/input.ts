import { createHash } from "node:crypto";
import { z } from "zod";
import { parseMappings } from "@localmesh/contracts";
import { parseConfig, parseOperationalMetadata, type Finding, type LocalMeshConfig, type ValidationJob, type ValidationResult } from "@localmesh/shared";
import { deterministicExplanation } from "./ollama.js";
import { PostgresValidationEnvironment } from "./runtime.js";
import { resultFindings, runValidationPlan, type ValidationPlan } from "./validation-plan.js";

const pathSchema = z.string().min(1).max(1024).refine((path) =>
  !path.startsWith("/") && !path.includes("\\") && !path.includes("\0") && !path.split("/").some((part) => part === ".." || part === "."),
"Use a repository-relative path without parent segments or backslashes");
const shaSchema = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i, "Expected an immutable Git commit SHA");
const migrationSchema = z.object({
  path: pathSchema, sql: z.string().max(2_000_000), direction: z.enum(["up", "down"]), order: z.number().int().nonnegative()
}).strict().refine((file) => file.path.endsWith(`.${file.direction}.sql`), "Migration direction must match its .up.sql or .down.sql suffix");
const migrationFilesSchema = z.array(migrationSchema).max(10_000).refine((files) => new Set(files.map((file) => file.path)).size === files.length, "Migration paths must be unique within each revision");
const groupSchema = z.object({ pr: z.number().int().nonnegative(), files: migrationFilesSchema }).strict();
const findingSchema = z.object({
  code: z.string().min(1).max(100), severity: z.enum(["info", "warning", "error"]), title: z.string().min(1).max(1000),
  message: z.string().min(1).max(20_000), evidence: z.record(z.string(), z.unknown()).optional(), file: pathSchema.optional(), line: z.number().int().positive().optional()
}).strict();

const validationInputSchema = z.object({
  version: z.literal(1),
  job: z.object({
    id: z.string().min(1).max(128), installationId: z.number().int().nonnegative(), owner: z.string().regex(/^[\w.-]+$/),
    repo: z.string().regex(/^[\w.-]+$/), prNumber: z.number().int().nonnegative(), headSha: shaSchema, baseSha: shaSchema,
    checkRunId: z.number().int().positive().optional()
  }).strict(),
  config: z.unknown().transform((value, context): LocalMeshConfig => {
    try { return parseConfig(JSON.stringify(value)); }
    catch (error) {
      const message = error instanceof z.ZodError ? error.issues.map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`).join("; ") : error instanceof Error ? error.message : String(error);
      context.addIssue({ code: "custom", message: `Invalid LocalMesh configuration: ${message}` }); return z.NEVER;
    }
  }),
  baseline: migrationFilesSchema,
  current: groupSchema,
  candidates: z.array(groupSchema).max(1000),
  fixtures: z.array(z.object({ path: pathSchema, sql: z.string().max(2_000_000) }).strict()).max(1000),
  mappingsText: z.string().max(2_000_000).optional(),
  metadataText: z.string().max(2_000_000).optional(),
  provenance: z.object({
    pullRequests: z.array(z.object({ number: z.number().int().nonnegative(), author: z.string().min(1).max(100), headSha: shaSchema, title: z.string().max(1000).optional() }).strict()).max(1000),
    currentPrFiles: z.array(pathSchema).max(10_000), trigger: z.string().max(100).optional(),
    inputDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(), engineVersion: z.string().max(100).optional()
  }).strict().optional(),
  discoveryFindings: z.array(findingSchema).max(10_000).optional()
}).strict().superRefine((input, context) => {
  if (input.current.pr !== input.job.prNumber) context.addIssue({ code: "custom", path: ["current", "pr"], message: "Current PR must match job.prNumber" });
  const numbers = input.candidates.map((candidate) => candidate.pr);
  if (numbers.includes(input.current.pr) || new Set(numbers).size !== numbers.length) context.addIssue({ code: "custom", path: ["candidates"], message: "Candidates must be unique and exclude the current PR" });
  if (new Set(input.fixtures.map((fixture) => fixture.path)).size !== input.fixtures.length) context.addIssue({ code: "custom", path: ["fixtures"], message: "Fixture paths must be unique" });
  if (input.provenance) {
    const expected = new Set([input.current.pr, ...numbers]);
    const references = input.provenance.pullRequests;
    if (references.length !== expected.size || new Set(references.map((pr) => pr.number)).size !== expected.size || references.some((pr) => !expected.has(pr.number))) {
      context.addIssue({ code: "custom", path: ["provenance", "pullRequests"], message: "Provenance must identify exactly the current PR and each candidate" });
    }
    if (references.find((pr) => pr.number === input.current.pr)?.headSha !== input.job.headSha) context.addIssue({ code: "custom", path: ["provenance", "pullRequests"], message: "Current PR provenance must match the immutable job head SHA" });
    const paths = new Set(input.current.files.map((file) => file.path));
    if (input.provenance.currentPrFiles.length !== paths.size || new Set(input.provenance.currentPrFiles).size !== paths.size || input.provenance.currentPrFiles.some((path) => !paths.has(path))) {
      context.addIssue({ code: "custom", path: ["provenance", "currentPrFiles"], message: "Annotation provenance must match the current migration files" });
    }
  }
});

export type ValidationInput = Omit<z.infer<typeof validationInputSchema>, "job" | "provenance" | "discoveryFindings"> & {
  job: ValidationJob;
  provenance?: NonNullable<ValidationResult["provenance"]>;
  discoveryFindings?: Finding[];
};

/** Parse an offline replay bundle. Repository code and local configuration are never executed. */
export function parseValidationInput(source: string | unknown): ValidationInput {
  return validationInputSchema.parse(typeof source === "string" ? JSON.parse(source) : source) as ValidationInput;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

/** Content receipt for the exact replay input, independent of JSON object key order. */
export function validationInputDigest(input: ValidationInput): string {
  const { inputDigest: _previousDigest, ...provenance } = input.provenance ?? {};
  return createHash("sha256").update(canonical({ ...input, ...(input.provenance ? { provenance } : {}) })).digest("hex");
}

export function validationPlanFromInput(input: ValidationInput): ValidationPlan {
  return {
    baseline: input.baseline, current: input.current, candidates: input.candidates,
    extensions: input.config.postgres.extensions, fixtures: input.fixtures.map((fixture) => fixture.sql),
    requireDataContracts: input.config.checks.require_data_contracts, verifyRollback: input.config.checks.verify_rollback,
    ...(input.mappingsText !== undefined ? { mappings: parseMappings(input.mappingsText) } : {}),
    ...(input.metadataText !== undefined ? { metadata: parseOperationalMetadata(input.metadataText) } : {})
  };
}

/** Both the Action and offline CLI use this engine entry point, with no GitHub or queue dependency. */
export async function runValidationInput(source: unknown): Promise<ValidationResult> {
  const input = parseValidationInput(source);
  const plan = validationPlanFromInput(input);
  let result: ValidationResult;
  if (!input.current.files.length || input.discoveryFindings?.some((finding) => finding.severity === "error")) {
    const now = new Date().toISOString();
    result = {
      jobId: input.job.id, repository: `${input.job.owner}/${input.job.repo}`, currentPr: input.job.prNumber,
      headSha: input.job.headSha, baseSha: input.job.baseSha, status: "passed", startedAt: now, completedAt: now,
      affectedObjects: [], dependencies: [], comparedPullRequests: [], orders: [], contracts: [], rollbacks: [], performance: [],
      scope: {
        candidatePrs: input.candidates.map((candidate) => candidate.pr), skippedPrs: input.candidates.map((candidate) => candidate.pr),
        contractMappings: plan.mappings?.mappings.filter((mapping) => mapping.enabled).length ?? 0, fixtureFiles: input.fixtures.length, rollbackChecked: false,
        decisions: input.candidates.map((candidate) => ({ pr: candidate.pr, decision: "skipped", reason: input.discoveryFindings?.some((finding) => finding.severity === "error") ? "Discovery failed; no partial SQL result can establish compatibility." : "The current revision changes no migration files." }))
      }
    };
  } else {
    const environment = await PostgresValidationEnvironment.start(input.config.postgres.version);
    try { result = await runValidationPlan(environment, input.job, plan); }
    finally { await environment.stop(); }
  }
  return completeValidationResult(input, result);
}

/** Attach the same deterministic receipt and explanation to service and standalone results. */
export function completeValidationResult(input: ValidationInput, result: ValidationResult): ValidationResult {
  result.contracts.push(...input.discoveryFindings ?? []);
  if (resultFindings(result).some((finding) => finding.severity === "error")) result.status = "failed";
  result.provenance = {
    ...input.provenance, pullRequests: input.provenance?.pullRequests ?? [], currentPrFiles: input.current.files.map((file) => file.path),
    inputDigest: validationInputDigest(input), engineVersion: "0.1.0"
  };
  result.explanation = deterministicExplanation(resultFindings(result));
  if (!result.orders.length && result.status === "passed") result.explanation.cause = "No migration files changed; PostgreSQL execution was not needed.";
  result.explanationStatus = "complete";
  return result;
}
