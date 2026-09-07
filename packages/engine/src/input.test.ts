import { describe, expect, it, vi } from "vitest";
import { defaultConfig } from "@localmesh/shared";
import { parseValidationInput, runValidationInput, validationInputDigest, validationPlanFromInput } from "./input.js";
import { PostgresValidationEnvironment } from "./runtime.js";

const input = () => ({
  version: 1, job: { id: "offline-replay", installationId: 0, owner: "acme", repo: "store", prNumber: 7, baseSha: "a".repeat(40), headSha: "b".repeat(40) },
  config: structuredClone(defaultConfig), baseline: [], current: { pr: 7, files: [] }, candidates: [], fixtures: []
});

describe("versioned validation input", () => {
  it("accepts offline bundles and synthetic merge-group PR zero without GitHub credentials", () => {
    const value = input(); value.job.prNumber = 0; value.current.pr = 0;
    expect(parseValidationInput(JSON.stringify(value)).job.installationId).toBe(0);
  });

  it("rejects mutable refs, unknown versions, mismatched PRs and duplicate candidates", () => {
    expect(() => parseValidationInput({ ...input(), version: 2 })).toThrow();
    expect(() => parseValidationInput({ ...input(), job: { ...input().job, headSha: "main" } })).toThrow(/immutable/);
    expect(() => parseValidationInput({ ...input(), current: { pr: 8, files: [] } })).toThrow(/match/);
    expect(() => parseValidationInput({ ...input(), candidates: [{ pr: 8, files: [] }, { pr: 8, files: [] }] })).toThrow(/unique/);
    expect(() => parseValidationInput({ ...input(), candidates: [{ pr: 7, files: [] }] })).toThrow(/exclude/);
  });

  it("rejects invalid migration paths, duplicate files and mismatched directions", () => {
    const file = { path: "db/migrations/002.up.sql", sql: "SELECT 1;", direction: "up", order: 2 };
    expect(() => parseValidationInput({ ...input(), baseline: [{ ...file, path: "../002.up.sql" }] })).toThrow(/relative/);
    expect(() => parseValidationInput({ ...input(), baseline: [file, file] })).toThrow(/unique/);
    expect(() => parseValidationInput({ ...input(), baseline: [{ ...file, direction: "down" }] })).toThrow(/direction/);
    expect(() => parseValidationInput({ ...input(), unexpectedSecret: "ignored" })).toThrow();
  });

  it("creates a content receipt that is key-order independent and includes fixtures and configuration", () => {
    const parsed = parseValidationInput(input());
    const reordered = parseValidationInput(Object.fromEntries(Object.entries(input()).reverse()));
    expect(validationInputDigest(parsed)).toBe(validationInputDigest(reordered));
    expect(validationInputDigest({ ...parsed, fixtures: [{ path: ".localmesh/fixtures/orders.sql", sql: "SELECT 1;" }] })).not.toBe(validationInputDigest(parsed));
    expect(validationInputDigest({ ...parsed, config: { ...parsed.config, postgres: { ...parsed.config.postgres, version: "17" } } })).not.toBe(validationInputDigest(parsed));
  });

  it("validates committed mappings before executing PostgreSQL", () => {
    expect(() => validationPlanFromInput(parseValidationInput({ ...input(), mappingsText: "version: 99" }))).toThrow();
  });

  it("binds publication provenance to current files, head SHA and candidate identities", () => {
    const provenance = { currentPrFiles: [], pullRequests: [{ number: 7, author: "alice", headSha: input().job.headSha }] };
    expect(parseValidationInput({ ...input(), provenance }).provenance?.pullRequests[0]?.number).toBe(7);
    expect(() => parseValidationInput({ ...input(), provenance: { ...provenance, currentPrFiles: ["db/migrations/fake.up.sql"] } })).toThrow(/Annotation/);
    expect(() => parseValidationInput({ ...input(), provenance: { ...provenance, pullRequests: [{ ...provenance.pullRequests[0], headSha: "c".repeat(40) }] } })).toThrow(/head SHA/);
    expect(() => parseValidationInput({ ...input(), candidates: [{ pr: 8, files: [] }], provenance })).toThrow(/exactly/);
  });

  it("reports no migrations without starting Docker", async () => {
    const start = vi.spyOn(PostgresValidationEnvironment, "start").mockRejectedValue(new Error("Docker must not start"));
    try {
      const result = await runValidationInput(input());
      expect(result.status).toBe("passed");
      expect(result.orders).toEqual([]);
      expect(result.scope?.rollbackChecked).toBe(false);
      expect(result.explanation?.cause).toContain("not needed");
      expect(result.provenance?.inputDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(start).not.toHaveBeenCalled();
    } finally { start.mockRestore(); }
  });

  it("fails closed on incomplete discovery without running a misleading partial SQL plan", async () => {
    const start = vi.spyOn(PostgresValidationEnvironment, "start").mockRejectedValue(new Error("Docker must not start"));
    try {
      const finding = { code: "DISCOVERY_INCOMPLETE", severity: "error", title: "Discovery incomplete", message: "A historical migration was removed." };
      const result = await runValidationInput({ ...input(), discoveryFindings: [finding] });
      expect(result.status).toBe("failed");
      expect(result.contracts).toEqual([finding]);
      expect(result.orders).toEqual([]);
      expect(start).not.toHaveBeenCalled();
    } finally { start.mockRestore(); }
  });
});
