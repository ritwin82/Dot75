import { describe, expect, it } from "vitest";
import { buildCompatibilityGraph } from "./compatibility.js";
import type { ValidationResult } from "@localmesh/shared";

const sha = (letter: string) => letter.repeat(40);
const result: ValidationResult = {
  jobId: "j1", repository: "o/r", currentPr: 1, baseSha: sha("a"), headSha: sha("b"), status: "failed", startedAt: "2026-01-01",
  affectedObjects: [], dependencies: [], comparedPullRequests: [2], contracts: [], rollbacks: [], performance: [],
  orders: [
    { order: [1], passed: true, findings: [], durationMs: 1 }, { order: [2], passed: true, findings: [], durationMs: 1 },
    { order: [1, 2], passed: false, findings: [], durationMs: 1 }, { order: [2, 1], passed: false, findings: [], durationMs: 1 }
  ],
  provenance: { currentPrFiles: [], pullRequests: [{ number: 1, author: "a", title: "One", headSha: sha("b") }, { number: 2, author: "b", title: "Two", headSha: sha("c") }] },
  scope: { candidatePrs: [2], skippedPrs: [], contractMappings: 0, fixtureFiles: 0, rollbackChecked: false, decisions: [{ pr: 2, decision: "tested", reason: "related" }] }
};

describe("buildCompatibilityGraph", () => {
  it("builds a deterministic graph from immutable stored evidence", () => {
    const graph = buildCompatibilityGraph("o/r", [{ id: "j1", status: "failed", createdAt: "2026-01-01T00:00:00Z", result }]);
    expect(graph?.nodes.map((node) => node.pr)).toEqual([1, 2]);
    expect(graph?.edges[0]).toMatchObject({ pullRequests: [1, 2], status: "conflict", sourceJobId: "j1" });
    expect(graph?.coverage).toEqual({ possiblePairs: 1, classifiedPairs: 1, missingPairs: 0 });
  });

  it("returns null when no completed result exists", () => {
    expect(buildCompatibilityGraph("o/r", [])).toBeNull();
  });
});
