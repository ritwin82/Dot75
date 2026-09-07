import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyActionIngestionSignature } from "@localmesh/shared";
import { sendPlatformResults } from "./platform.js";

const sha = "a".repeat(40);
const results = [{
  externalId: "localmesh:42:2:17",
  result: { jobId: "job", repository: "acme/store", currentPr: 17, headSha: sha, baseSha: sha, status: "passed" as const, startedAt: new Date().toISOString(), affectedObjects: [], dependencies: [], comparedPullRequests: [], orders: [], contracts: [], rollbacks: [], performance: [] }
}];

afterEach(() => vi.unstubAllGlobals());

describe("platform result delivery", () => {
  it("posts a signed workflow result batch to the ingestion endpoint", async () => {
    const fetchMock = vi.fn(async (_url: URL, init: RequestInit) => {
      const body = String(init.body);
      const headers = init.headers as Record<string, string>;
      expect(verifyActionIngestionSignature(body, headers["x-localmesh-signature-256"], "secret")).toBe(true);
      return new Response("{}", { status: 202 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(sendPlatformResults("http://localmesh.internal:4100", "secret", { repository: "acme/store", runId: 42, runAttempt: 2, results })).resolves.toBe(1);
    expect(fetchMock.mock.calls[0]?.[0].toString()).toBe("http://localmesh.internal:4100/api/action-results");
  });

  it("fails visibly when the platform refuses a delivery", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad signature", { status: 401 })));
    await expect(sendPlatformResults("https://localmesh.example", "secret", { repository: "acme/store", runId: 42, runAttempt: 2, results })).rejects.toThrow("401");
  });
});
