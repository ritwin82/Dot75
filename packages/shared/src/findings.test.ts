import { describe, expect, it } from "vitest";
import { findingCategory, findingGuidance, uniqueFindings } from "./findings.js";
describe("finding presentation", () => {
  it("separates schema and data contract failures", () => {
    expect(findingCategory("CONTRACT_COLUMN_MISSING")).toBe("Schema contract");
    expect(findingCategory("DATA_CONTRACT_FAILED")).toBe("Data contract");
    expect(findingGuidance("DATA_CONTRACT_FAILED").impact).toContain("business rule");
  });
  it("deduplicates repeated findings without merging different PR evidence", () => {
    const f = { code: "42701", severity: "error" as const, title: "Error", message: "Duplicate", evidence: { pr: 1 } };
    expect(uniqueFindings([f, f, { ...f, evidence: { pr: 2 } }])).toHaveLength(2);
  });
});
