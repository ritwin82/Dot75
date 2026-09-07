import { describe, expect, it } from "vitest";
import { formatValidationResult } from "./report.js";
import type { ValidationResult } from "@localmesh/shared";

const result: ValidationResult = { jobId: "j", repository: "o/r", currentPr: 1, baseSha: "a".repeat(40), headSha: "b".repeat(40), status: "failed", startedAt: "now", affectedObjects: [], dependencies: [], comparedPullRequests: [], contracts: [], rollbacks: [], performance: [], orders: [{ order: [1], passed: false, durationMs: 25, findings: [{ code: "42701", severity: "error", title: "Duplicate", message: "bad <column>", file: "db/1.up.sql", line: 2 }] }], provenance: { pullRequests: [], currentPrFiles: [], inputDigest: "c".repeat(64), engineVersion: "0.1.0" } };

describe("validation reports", () => {
  it("formats human and Markdown evidence", () => {
    expect(formatValidationResult(result, "human")).toContain("FAIL o/r PR #1");
    expect(formatValidationResult(result, "markdown")).toContain("## Findings");
  });
  it("formats valid SARIF and escaped JUnit", () => {
    expect(JSON.parse(formatValidationResult(result, "sarif")).runs[0].results[0].ruleId).toBe("42701");
    expect(formatValidationResult(result, "junit")).toContain("bad &lt;column&gt;");
  });
});
