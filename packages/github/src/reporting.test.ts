import { describe, expect, it, vi } from "vitest";
import type { Octokit } from "@octokit/rest";
import type { Finding, ValidationResult } from "@localmesh/shared";
import { checkAnnotations, checkConclusion, checkSummary, STICKY_COMMENT_MARKER, stickyComment, upsertStickyComment } from "./reporting.js";

const collision: Finding = {
  code: "42701", severity: "error", title: "PostgreSQL rejected the migration", message: 'column "status" already exists',
  file: "migrations/002_status.up.sql", line: 8,
  evidence: { pr: 1, objects: ["column:public.orders.status"], position: "210" }
};

function result(overrides: Partial<ValidationResult> = {}): ValidationResult {
  return {
    jobId: "job-1", repository: "owner/repo", currentPr: 1, baseSha: "base-sha", headSha: "current-head-sha",
    startedAt: "2026-09-07T00:00:00.000Z", completedAt: "2026-09-07T00:00:01.000Z", status: "failed",
    affectedObjects: [], dependencies: [], comparedPullRequests: [2],
    orders: [{ order: [2, 1], passed: false, sqlPassed: false, durationMs: 20, findings: [collision] }],
    contracts: [], rollbacks: [], performance: [],
    scope: { candidatePrs: [2, 3], skippedPrs: [3], contractMappings: 1, fixtureFiles: 2, rollbackChecked: true },
    provenance: {
      pullRequests: [{ number: 1, author: "alice", headSha: "current-head-sha" }, { number: 2, author: "bob", headSha: "other-head-sha", title: "Add order status" }],
      currentPrFiles: [collision.file!], trigger: "pull_request", inputDigest: "sha256:digest", engineVersion: "0.1.0"
    },
    ...overrides
  };
}

function client(comments: unknown[] = []) {
  const mock = {
    paginate: vi.fn().mockResolvedValue(comments),
    issues: { listComments: vi.fn(), updateComment: vi.fn().mockResolvedValue({}), createComment: vi.fn().mockResolvedValue({}) }
  };
  return { mock, octokit: mock as unknown as Octokit };
}

describe("GitHub validation explanations", () => {
  it("records exact commits, conflicting author, SQL location, objects, impact, action, and scope", () => {
    const summary = checkSummary(result());
    for (const detail of ["base-sha", "current-head-sha", "other-head-sha", "#2 by `@bob`", "#2 → #1", "migrations/002_status.up.sql:8", "column:public.orders.status", "42701", "remove or rename", "sha256:digest", "Contracts: 1", "Fixture files: 2", "1 candidate(s) skipped", "three or more PRs", "localmesh repro --input input-1.json --output result-1.json"]) {
      expect(summary).toContain(detail);
    }
  });

  it("deduplicates an identical failure while retaining every affected order", () => {
    const value = result();
    value.orders.push({ order: [1, 2], passed: false, durationMs: 10, findings: [collision] });
    const summary = checkSummary(value);
    expect(summary).toContain("1 distinct error(s)");
    expect(summary).toContain("Order #2 → #1; Order #1 → #2");
    expect(summary.match(/#### ERROR:/g)).toHaveLength(1);
  });

  it("does not announce success when a failed result or failed order has no error findings", () => {
    expect(checkConclusion(result({ orders: [] }))).toBe("failure");
    expect(checkConclusion(result({ status: "passed", orders: [{ order: [1], passed: false, durationMs: 1, findings: [] }] }))).toBe("failure");
    expect(checkConclusion(result({ status: "running" }))).toBe("neutral");
    expect(checkConclusion(result({ status: "cancelled" }))).toBe("cancelled");
  });

  it("keeps a warning-only destructive rollback heuristic advisory when restoration passed", () => {
    const value = result({ status: "passed", orders: [{ order: [1], passed: true, durationMs: 2, findings: [] }],
      rollbacks: [{ migration: "migrations/002_status.up.sql", status: "unsafe", schemaRestored: true, dataRestored: true,
        findings: [{ code: "DROP_TABLE", severity: "warning", title: "Potentially destructive rollback", message: "Dropping a table destroys its records." }] }] });
    expect(checkConclusion(value)).toBe("success");
    expect(checkSummary(value)).toContain("1 distinct warning(s)");
    expect(checkSummary(value)).toContain("**unsafe**; schema restored: yes; fixture data restored: yes");
  });

  it("explains absent contract and fixture coverage instead of claiming application correctness", () => {
    const summary = checkSummary(result({ scope: { candidatePrs: [], skippedPrs: [], contractMappings: 0, fixtureFiles: 0, rollbackChecked: false } }));
    expect(summary).toContain("No application contracts were configured");
    expect(summary).toContain("Rollback verification: not performed");
  });

  it("explains why a candidate was tested or skipped", () => {
    const value = result();
    value.scope!.decisions = [{ pr: 3, decision: "skipped", reason: "No shared catalog objects or dependency edges." }];
    expect(checkSummary(value)).toContain("#3: skipped — No shared catalog objects or dependency edges.");
  });

  it("labels cumulative merge queue validation without a fictitious PR #0", () => {
    const summary = checkSummary(result({ currentPr: 0, orders: [{ order: [0], passed: true, durationMs: 1, findings: [] }] }));
    expect(summary).toContain("Current change: Merge queue");
    expect(summary).not.toContain("#0");
  });

  it("bounds GitHub output and escapes untrusted HTML and title mentions", () => {
    const value = result();
    value.provenance!.pullRequests[1]!.title = "<script>@someone</script>";
    expect(checkSummary(value)).toContain("&lt;script&gt;&#64;someone&lt;/script&gt;");
    value.orders[0]!.findings = Array.from({ length: 60 }, (_, i) => ({ ...collision, message: `${i}: ${"x".repeat(3000)}` }));
    expect(checkSummary(value).length).toBeLessThanOrEqual(60_000);
    expect(checkSummary(value)).toContain("Report truncated");
  });

  it("enforces GitHub output limits in UTF-8 bytes for non-ASCII evidence", () => {
    const value = result();
    value.orders[0]!.findings = [{ ...collision, title: "問".repeat(200), message: "問".repeat(40_000) }];
    expect(Buffer.byteLength(checkSummary(value))).toBeLessThanOrEqual(60_000);
    expect(Buffer.byteLength(checkAnnotations(value)[0]!.message)).toBeLessThanOrEqual(60_000);
    expect(Buffer.byteLength(checkAnnotations(value)[0]!.title)).toBeLessThanOrEqual(255);
  });
});

describe("annotations scoped to the checked head", () => {
  it("annotates current PR SQL with exact line and actionable guidance", () => {
    expect(checkAnnotations(result())).toEqual([expect.objectContaining({ path: collision.file, start_line: 8, end_line: 8, annotation_level: "failure", message: expect.stringContaining("remove or rename") })]);
  });

  it("does not attach another PR's error even if both PRs use the same migration path", () => {
    const value = result();
    value.orders[0]!.findings = [{ ...collision, evidence: { pr: 2 } }];
    expect(checkAnnotations(value)).toEqual([]);
    expect(checkSummary(value)).toContain("Failing migration belongs to #2 by `@bob`");
  });

  it("does not guess ownership of pairwise findings or annotate paths missing from the checked head", () => {
    const value = result();
    value.orders[0]!.findings = [{ ...collision, evidence: {} }, { ...collision, file: "migrations/missing.up.sql" }];
    expect(checkAnnotations(value)).toEqual([]);
  });

  it("allows a current-only order without explicit ownership and labels a missing SQL line", () => {
    const { line: _line, evidence: _evidence, ...finding } = collision;
    const value = result({ orders: [{ order: [1], passed: false, durationMs: 1, findings: [finding] }] });
    expect(checkAnnotations(value)[0]).toMatchObject({ start_line: 1, message: expect.stringContaining("Exact SQL line unavailable") });
  });
});

describe("sticky PR comments", () => {
  it("clearly identifies the no-migration fast path", () => {
    const value = result({ status: "passed", orders: [] });
    value.provenance!.currentPrFiles = [];
    expect(stickyComment(value)).toContain("no migration changes; PostgreSQL execution was not needed");
  });

  it("collapses successful results to one visible line and preserves warning counts", () => {
    const body = stickyComment(result({ status: "passed", orders: [{ order: [1], passed: true, durationMs: 2, findings: [] }], performance: [{ code: "NON_CONCURRENT_INDEX", severity: "warning", title: "Index lock", message: "Review locking" }] }));
    expect(body.split("\n")).toHaveLength(2);
    expect(body).toContain("1 warning(s)");
    expect(body).toContain("against base `base-sha`");
  });

  it("updates the exact bot-owned marker comment without overwriting a human lookalike", async () => {
    const { mock, octokit } = client([
      { id: 10, body: `${STICKY_COMMENT_MARKER}\nHuman note`, user: { type: "User", login: "alice" } },
      { id: 20, body: `${STICKY_COMMENT_MARKER}\nOld verdict`, user: { type: "Bot", login: "github-actions[bot]" } }
    ]);
    await upsertStickyComment(octokit, "owner", "repo", result());
    expect(mock.issues.updateComment).toHaveBeenCalledWith(expect.objectContaining({ comment_id: 20, body: stickyComment(result()) }));
    expect(mock.issues.createComment).not.toHaveBeenCalled();
  });

  it("creates a comment when the marker only belongs to a different bot or human", async () => {
    const { mock, octokit } = client([{ id: 10, body: `${STICKY_COMMENT_MARKER}\nOther bot`, user: { type: "Bot", login: "unrelated[bot]" } }]);
    await upsertStickyComment(octokit, "owner", "repo", result());
    expect(mock.issues.updateComment).not.toHaveBeenCalled();
    expect(mock.issues.createComment).toHaveBeenCalledWith(expect.objectContaining({ issue_number: 1 }));
  });

  it("performs no write when the saved comment is already identical", async () => {
    const value = result();
    const { mock, octokit } = client([{ id: 20, body: stickyComment(value), user: { type: "Bot", login: "localmesh[bot]" } }]);
    await upsertStickyComment(octokit, "owner", "repo", value, { botLogin: "localmesh[bot]" });
    expect(mock.issues.updateComment).not.toHaveBeenCalled();
    expect(mock.issues.createComment).not.toHaveBeenCalled();
  });

  it("keeps fan-out and merge queue runs quiet without querying comments", async () => {
    const { mock, octokit } = client();
    await upsertStickyComment(octokit, "owner", "repo", result(), { enabled: false });
    await upsertStickyComment(octokit, "owner", "repo", result({ currentPr: 0 }));
    expect(mock.paginate).not.toHaveBeenCalled();
    expect(mock.issues.createComment).not.toHaveBeenCalled();
  });
});
