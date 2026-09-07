import { describe, expect, it } from "vitest";
import { parseActionIngestionPayload, signActionIngestion, verifyActionIngestionSignature } from "./action-ingestion.js";

const sha = "a".repeat(40);
const payload = {
  version: 1 as const,
  repository: "acme/store",
  delivery: { event: "workflow_run" as const, runId: 42, runAttempt: 2, publishedAt: "2026-09-07T10:00:00.000Z" },
  results: [{
    externalId: "localmesh:42:2:17",
    result: {
      jobId: "job-17", repository: "acme/store", currentPr: 17, headSha: sha, baseSha: sha, status: "passed" as const,
      startedAt: "2026-09-07T09:59:00.000Z", completedAt: "2026-09-07T10:00:00.000Z", affectedObjects: [], dependencies: [],
      comparedPullRequests: [], orders: [{ order: [17], passed: true, findings: [], durationMs: 10 }], contracts: [], rollbacks: [], performance: [],
      pullRequestChanges: [{ pr: 17, migrationFiles: ["db/migrations/002_status.up.sql"], affectedObjects: [{ id: "column:public.orders.status", kind: "column" as const }],
        operations: [{ file: "db/migrations/002_status.up.sql", action: "add" as const, objectKind: "column" as const, objectName: "public.orders.status", description: "Adds column status to public.orders." }] }]
    }
  }]
};

describe("Action result ingestion contract", () => {
  it("signs the exact serialized body and rejects any mutation", () => {
    const body = JSON.stringify(payload);
    const signature = signActionIngestion(body, "shared-secret");
    expect(verifyActionIngestionSignature(body, signature, "shared-secret")).toBe(true);
    expect(verifyActionIngestionSignature(`${body} `, signature, "shared-secret")).toBe(false);
  });

  it("accepts a complete result and rejects mismatched transport shapes", () => {
    expect(parseActionIngestionPayload(payload).results[0]?.result.currentPr).toBe(17);
    expect(parseActionIngestionPayload(payload).results[0]?.result.pullRequestChanges?.[0]?.operations[0]?.action).toBe("add");
    expect(() => parseActionIngestionPayload({ ...payload, repository: "invalid" })).toThrow();
    expect(() => parseActionIngestionPayload({ ...payload, results: [] })).toThrow();
  });
});
