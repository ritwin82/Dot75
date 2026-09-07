import { afterEach, describe, expect, it, vi } from "vitest";
import { explainWithOllama } from "./ollama.js";
import type { Finding } from "@localmesh/shared";

const findings: Finding[] = [{ code: "42701", severity: "error", title: "Duplicate column", message: "column priority already exists" }];
const valid = { cause: "Two PRs add priority.", conflictingObjects: ["orders.priority"], forwardFix: "Use a single agreed definition.", rollbackFix: "Review the paired down migrations.", confidence: "medium", assumptions: [] };
afterEach(() => vi.unstubAllGlobals());
describe("local Ollama explanations", () => {
  it("does not ask the model to invent an issue when there are no findings", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const result = await explainWithOllama([], "valid SQL", { url: "http://localhost:11434", model: "unused" });
    expect(result.source).toBe("deterministic");
    expect(result.cause).toContain("No migration failure");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("validates structured output and reuses identical requests", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ response: JSON.stringify(valid) })));
    vi.stubGlobal("fetch", fetcher);
    const options = { url: "http://localhost:11434", model: "cache-test" };
    const result = await explainWithOllama(findings, "SQL", options);
    expect(result.source).toBe("ollama");
    const body = JSON.parse(fetcher.mock.calls[0]![1].body);
    expect(body.format.type).toBe("object");
    expect(body.options.temperature).toBe(0);
    expect((await explainWithOllama(findings, "SQL", options)).cached).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(findings[0]?.severity).toBe("error");
  });
  it("explains a missing model", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("missing", { status: 404 })));
    const result = await explainWithOllama(findings, "SQL", { url: "http://localhost:11434", model: "missing" });
    expect(result.source).toBe("deterministic");
    expect(result.fallbackReason).toContain("ollama pull missing");
  });
  it.each(["not JSON", JSON.stringify({ cause: "" })])("rejects invalid output: %s", async (response) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ response }))));
    expect((await explainWithOllama(findings, response, { url: "http://localhost:11434", model: "invalid" })).fallbackReason).toBeTruthy();
  });
  it("reports a timeout and preserves the verified error", async () => {
    vi.stubGlobal("fetch", vi.fn((_url, init: RequestInit) => new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))))));
    const result = await explainWithOllama(findings, "SQL", { url: "http://localhost:11434", model: "timeout", timeoutMs: 5 });
    expect(result.source).toBe("deterministic");
    expect(result.cause).toBe(findings[0]!.message);
    expect(result.fallbackReason).toContain("timeout");
  });
});
