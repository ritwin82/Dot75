import { describe, expect, it } from "vitest";
import { signActionIngestion } from "@localmesh/shared";
import { ActionIngestionError, authenticateActionIngestion } from "./action-ingestion.js";

const now = Date.parse("2026-09-07T10:00:00.000Z");
const sha = "a".repeat(40);
function body(repository = "acme/store"): Buffer {
  return Buffer.from(JSON.stringify({
    version: 1,
    repository,
    delivery: { event: "workflow_run", runId: 42, runAttempt: 2, publishedAt: new Date(now).toISOString() },
    results: [{
      externalId: "localmesh:42:2:17",
      result: { jobId: "job", repository: "acme/store", currentPr: 17, headSha: sha, baseSha: sha, status: "failed", startedAt: new Date(now).toISOString(), affectedObjects: [], dependencies: [], comparedPullRequests: [], orders: [], contracts: [], rollbacks: [], performance: [] }
    }]
  }));
}

describe("Action ingestion authentication", () => {
  it("accepts a fresh body signed over its exact bytes", () => {
    const raw = body();
    expect(authenticateActionIngestion(raw, signActionIngestion(raw, "secret"), "secret", now).results[0]?.result.currentPr).toBe(17);
  });

  it("rejects invalid signatures, stale deliveries, and identity mismatches", () => {
    const raw = body();
    expect(() => authenticateActionIngestion(raw, "sha256=bad", "secret", now)).toThrow(ActionIngestionError);
    const staleNow = now + 16 * 60 * 1000;
    expect(() => authenticateActionIngestion(raw, signActionIngestion(raw, "secret"), "secret", staleNow)).toThrow("timestamp");
    const mismatch = body("other/store");
    expect(() => authenticateActionIngestion(mismatch, signActionIngestion(mismatch, "secret"), "secret", now)).toThrow("identity");
  });
});
