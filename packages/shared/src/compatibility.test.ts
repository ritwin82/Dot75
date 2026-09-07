import { describe, expect, it } from "vitest";
import { deriveCompatibilityRelationships } from "./compatibility.js";
import type { OrderResult, ValidationResult } from "./types.js";

const order = (values: number[], passed: boolean): OrderResult => ({ order: values, passed, sqlPassed: passed, findings: passed ? [] : [{ code: "42701", severity: "error", title: "Conflict", message: "duplicate" }], durationMs: 1 });
const result = (orders: OrderResult[], decision: "tested" | "skipped" = "tested"): ValidationResult => ({
  jobId: "job", repository: "o/r", currentPr: 1, baseSha: "a".repeat(40), headSha: "b".repeat(40), status: "failed", startedAt: "now",
  affectedObjects: [], dependencies: [], comparedPullRequests: [2], orders, contracts: [], rollbacks: [], performance: [],
  scope: { candidatePrs: [2], skippedPrs: [], contractMappings: 0, fixtureFiles: 0, rollbackChecked: false, decisions: [{ pr: 2, decision, reason: "evidence" }] }
});

describe("deriveCompatibilityRelationships", () => {
  it("classifies compatible, conflicting and order-sensitive pairs", () => {
    expect(deriveCompatibilityRelationships(result([order([1], true), order([2], true), order([1, 2], true), order([2, 1], true)]))[0]!.status).toBe("compatible");
    expect(deriveCompatibilityRelationships(result([order([1], true), order([2], true), order([1, 2], false), order([2, 1], false)]))[0]!.status).toBe("conflict");
    const directed = deriveCompatibilityRelationships(result([order([1], true), order([2], true), order([1, 2], false), order([2, 1], true)]))[0]!;
    expect(directed.status).toBe("order_sensitive");
    expect(directed.passingOrder).toEqual([2, 1]);
  });

  it("does not claim compatibility without complete evidence", () => {
    expect(deriveCompatibilityRelationships(result([order([1], false), order([2], true), order([1, 2], false), order([2, 1], false)]))[0]!.status).toBe("standalone_invalid");
    expect(deriveCompatibilityRelationships(result([order([1], true)]))[0]!.status).toBe("untested");
    expect(deriveCompatibilityRelationships(result([], "skipped"))[0]!.status).toBe("independent");
  });
});
