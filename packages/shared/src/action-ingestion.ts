import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { ValidationResult } from "./types.js";

const sha = z.string().regex(/^[a-f0-9]{40}$/i);
const boundedText = z.string().min(1).max(65_000);
const prNumber = z.number().int().nonnegative();
const finding = z.object({
  code: boundedText,
  severity: z.enum(["info", "warning", "error"]),
  title: boundedText,
  message: boundedText,
  evidence: z.record(z.string(), z.unknown()).optional(),
  file: z.string().min(1).max(4096).optional(),
  line: z.number().int().positive().optional()
});

export const ingestedValidationResultSchema = z.object({
  jobId: boundedText,
  status: z.enum(["passed", "failed", "cancelled"]),
  repository: boundedText,
  currentPr: prNumber,
  baseSha: sha,
  headSha: sha,
  startedAt: boundedText,
  completedAt: boundedText.optional(),
  affectedObjects: z.array(z.object({
    id: boundedText,
    kind: z.enum(["table", "column", "constraint", "index", "view", "function", "trigger", "policy", "extension", "enum"]),
    schema: boundedText.optional(),
    relation: boundedText.optional(),
    name: boundedText,
    definition: z.string().max(65_000)
  })).max(20_000),
  dependencies: z.array(z.object({ from: boundedText, to: boundedText, type: boundedText })).max(50_000),
  comparedPullRequests: z.array(prNumber).max(2_000),
  orders: z.array(z.object({
    order: z.array(prNumber).min(1).max(2_000),
    passed: z.boolean(),
    findings: z.array(finding).max(5_000),
    finalFingerprint: boundedText.optional(),
    durationMs: z.number().nonnegative(),
    sqlPassed: z.boolean().optional(),
    contractsChecked: z.boolean().optional()
  }).passthrough()).max(10_000),
  contracts: z.array(finding).max(5_000),
  rollbacks: z.array(z.object({
    migration: boundedText,
    status: z.enum(["safe", "unsafe", "non_reversible"]),
    schemaRestored: z.boolean(),
    dataRestored: z.boolean().optional(),
    findings: z.array(finding).max(5_000)
  })).max(5_000),
  performance: z.array(finding).max(5_000),
  provenance: z.object({
    pullRequests: z.array(z.object({ number: prNumber, author: boundedText, headSha: sha, title: boundedText.optional() })).max(2_000),
    currentPrFiles: z.array(z.string().min(1).max(4096)).max(5_000),
    trigger: boundedText.optional(),
    inputDigest: boundedText.optional(),
    engineVersion: boundedText.optional()
  }).optional(),
  scope: z.object({
    candidatePrs: z.array(prNumber).max(2_000),
    skippedPrs: z.array(prNumber).max(2_000),
    contractMappings: z.number().int().nonnegative(),
    fixtureFiles: z.number().int().nonnegative(),
    rollbackChecked: z.boolean(),
    decisions: z.array(z.object({ pr: prNumber, decision: z.enum(["tested", "skipped"]), reason: boundedText })).max(2_000).optional()
  }).optional()
}).passthrough();

export interface PublishedActionResult {
  externalId: string;
  result: ValidationResult;
}

export interface ActionIngestionPayload {
  version: 1;
  repository: string;
  delivery: {
    event: "workflow_run";
    runId: number;
    runAttempt: number;
    publishedAt: string;
  };
  results: PublishedActionResult[];
}

export const actionIngestionPayloadSchema = z.object({
  version: z.literal(1),
  repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/).max(512),
  delivery: z.object({
    event: z.literal("workflow_run"),
    runId: z.number().int().positive(),
    runAttempt: z.number().int().positive(),
    publishedAt: z.iso.datetime()
  }),
  results: z.array(z.object({
    externalId: z.string().regex(/^localmesh:\d+:\d+:\d+$/).max(256),
    result: ingestedValidationResultSchema
  })).min(1).max(2_000)
});

export function parseActionIngestionPayload(value: unknown): ActionIngestionPayload {
  return actionIngestionPayloadSchema.parse(value) as ActionIngestionPayload;
}

export function signActionIngestion(body: string | Buffer, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

export function verifyActionIngestionSignature(body: string | Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature || !secret) return false;
  const expected = signActionIngestion(body, secret);
  const received = Buffer.from(signature);
  const calculated = Buffer.from(expected);
  return received.length === calculated.length && timingSafeEqual(received, calculated);
}
