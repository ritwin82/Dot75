import type { Octokit } from "@octokit/rest";
import { findingCategory, findingGuidance, type Finding, type ValidationResult } from "@localmesh/shared";

export const STICKY_COMMENT_MARKER = "<!-- localmesh-sensei:validation -->";
export const DOT75_CHECK_NAME = "LocalMesh Sensei";
const MAX_BODY_LENGTH = 60_000;

function truncateUtf8(value: string, limit: number): string {
  const bytes = Buffer.from(value);
  return bytes.length <= limit ? value : bytes.subarray(0, limit).toString("utf8").replace(/\uFFFD$/, "");
}

interface FindingContext {
  finding: Finding;
  contexts: string[];
  pullRequests: Set<number>;
  currentPrFile: boolean;
}

export interface CheckAnnotation {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: "failure" | "warning" | "notice";
  title: string;
  message: string;
}

function text(value: unknown): string {
  return String(value ?? "unknown").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("@", "&#64;")
    .replace(/([\\`*_[\]])/g, "\\$1");
}

function code(value: unknown): string {
  const content = String(value ?? "unknown").replace(/[\r\n]/g, " ").replaceAll("`", "'");
  return `\`${content.replaceAll("<", "&lt;").replaceAll(">", "&gt;")}\``;
}

function prLabel(result: ValidationResult, number: number): string {
  if (number === 0) return "Merge queue";
  const pr = result.provenance?.pullRequests.find((candidate) => candidate.number === number);
  return `#${number}${pr?.author ? ` by ${code(`@${pr.author}`)}` : ""}`;
}

function orderLabel(order: number[]): string {
  return order.map((number) => number === 0 ? "Merge queue" : `#${number}`).join(" → ");
}

function findingContexts(result: ValidationResult): FindingContext[] {
  const entries = new Map<string, FindingContext>();
  const add = (finding: Finding, context: string, prs: number[], currentPrFile: boolean) => {
    const key = JSON.stringify([finding.code, finding.severity, finding.title, finding.message, finding.file, finding.line, finding.evidence]);
    let entry = entries.get(key);
    if (!entry) {
      entry = { finding, contexts: [], pullRequests: new Set(), currentPrFile: false };
      entries.set(key, entry);
    }
    if (!entry.contexts.includes(context)) entry.contexts.push(context);
    for (const pr of prs) entry.pullRequests.add(pr);
    entry.currentPrFile ||= currentPrFile && (finding.evidence?.pr === undefined || finding.evidence.pr === result.currentPr);
  };
  for (const order of result.orders) {
    for (const finding of order.findings) {
      const owner = finding.evidence?.pr;
      add(finding, `Order ${orderLabel(order.order)}`, order.order,
        owner === result.currentPr || (owner === undefined && order.order.length === 1 && order.order[0] === result.currentPr));
    }
  }
  for (const finding of result.contracts) add(finding, "Contract coverage", [], false);
  for (const rollback of result.rollbacks) {
    for (const finding of rollback.findings) add(finding, `Rollback ${rollback.migration}`, [result.currentPr], true);
  }
  for (const finding of result.performance) add(finding, "Operational risk review", [result.currentPr], true);
  return [...entries.values()].sort((a, b) => {
    const rank = { error: 0, warning: 1, info: 2 };
    return rank[a.finding.severity] - rank[b.finding.severity];
  });
}

export function checkConclusion(result: ValidationResult): "cancelled" | "failure" | "success" | "neutral" {
  if (result.status === "cancelled") return "cancelled";
  if (result.status === "queued" || result.status === "running") return "neutral";
  if (result.status === "failed" || result.orders.some((order) => !order.passed)
    || findingContexts(result).some(({ finding }) => finding.severity === "error")) return "failure";
  return "success";
}

export function checkTitle(result: ValidationResult): string {
  const conclusion = checkConclusion(result);
  if (conclusion === "cancelled") return "Validation superseded by a newer commit";
  if (conclusion === "neutral") return "Migration validation is not complete";
  if (conclusion === "success") return result.orders.length === 0 && result.provenance?.currentPrFiles.length === 0
    ? "No migration changes require validation" : "Tested migration orders are compatible";
  const count = findingContexts(result).filter(({ finding }) => finding.severity === "error").length;
  return count ? `${count} migration problem${count === 1 ? "" : "s"} detected` : "Migration validation failed";
}

function coverageLines(result: ValidationResult): string[] {
  const scope = result.scope;
  const provenance = result.provenance;
  const lines = [
    `Repository: ${code(result.repository)} · Current change: ${prLabel(result, result.currentPr)}`,
    `Tested base SHA: ${code(result.baseSha)} · Current head SHA: ${code(result.headSha)}`,
    "",
    "### Validation coverage",
    `Compared with ${result.comparedPullRequests.length} related open migration PR(s): ${result.comparedPullRequests.map((number) => prLabel(result, number)).join(", ") || "none"}.`,
    `Executed ${result.orders.length} recorded order(s). Pairwise checks do not prove every possible combination of three or more PRs.`
  ];
  if (scope) {
    lines.push(`Discovery: ${scope.candidatePrs.length} migration candidate(s); ${scope.skippedPrs.length} candidate(s) skipped after dependency screening${scope.skippedPrs.length ? ` (${scope.skippedPrs.map((number) => `#${number}`).join(", ")})` : ""}.`);
    lines.push(`Contracts: ${scope.contractMappings} enabled mapping(s). Fixture files: ${scope.fixtureFiles}. Rollback verification: ${scope.rollbackChecked ? "performed" : "not performed"}.`);
    if (!scope.contractMappings) lines.push("No application contracts were configured; SQL and catalog compatibility do not establish application correctness.");
    else if (!scope.fixtureFiles) lines.push("No fixture files were supplied; data checks cover only data created by the tested SQL.");
    if (scope.decisions?.length) {
      lines.push("", "Dependency screening decisions:");
      for (const decision of scope.decisions) lines.push(`- ${prLabel(result, decision.pr)}: ${decision.decision} — ${text(decision.reason)}`);
    }
  } else {
    lines.push("Contract, fixture, and dependency-screening coverage was not recorded for this result.");
  }
  if (provenance) {
    lines.push("", "<details><summary>Exact PR heads tested</summary>", "");
    for (const pr of provenance.pullRequests) lines.push(`- ${prLabel(result, pr.number)}: ${code(pr.headSha)}${pr.title ? ` — ${text(pr.title)}` : ""}`);
    if (provenance.inputDigest) lines.push(`- Input digest: ${code(provenance.inputDigest)}`);
    if (provenance.engineVersion) lines.push(`- Engine version: ${code(provenance.engineVersion)}`);
    if (provenance.trigger) lines.push(`- Trigger: ${code(provenance.trigger)}`);
    lines.push("", "</details>");
  }
  return lines;
}

function findingLines(result: ValidationResult, entry: FindingContext): string[] {
  const { finding } = entry;
  const guidance = findingGuidance(finding.code);
  const otherPrs = [...entry.pullRequests].filter((number) => number !== result.currentPr);
  const objects = Array.isArray(finding.evidence?.objects) ? finding.evidence.objects.filter((object) => typeof object === "string") : [];
  const relation = finding.evidence?.relation;
  const lines = [
    `#### ${text(finding.severity.toUpperCase())}: ${text(finding.title)} (${code(finding.code)})`,
    `${text(findingCategory(finding.code))} · ${entry.contexts.map(text).join("; ")}`,
    "",
    text(finding.message)
  ];
  if (otherPrs.length) lines.push(`Other PR(s) involved: ${otherPrs.map((number) => prLabel(result, number)).join(", ")}.`);
  const migrationPr = finding.evidence?.pr;
  if (typeof migrationPr === "number") lines.push(`Failing migration belongs to ${prLabel(result, migrationPr)}.`);
  if (finding.file) lines.push(`Location: ${code(`${finding.file}${finding.line ? `:${finding.line}` : ""}`)}${finding.line ? "" : " (PostgreSQL did not provide a statement line)"}.`);
  if (objects.length || typeof relation === "string") lines.push(`Affected object(s): ${[...objects, ...(typeof relation === "string" ? [relation] : [])].map(code).join(", ")}.`);
  lines.push(`Impact: ${text(guidance.impact)}`, `Suggested next step: ${text(guidance.action)}`);
  if (finding.evidence && Object.values(finding.evidence).some((value) => value !== undefined)) {
    const evidence = JSON.stringify(finding.evidence);
    lines.push(`Recorded evidence: ${code(evidence.slice(0, 3000))}${evidence.length > 3000 ? " (truncated; see the result JSON)" : ""}.`);
  }
  return [...lines, ""];
}

export function checkSummary(result: ValidationResult): string {
  const entries = findingContexts(result);
  const errors = entries.filter(({ finding }) => finding.severity === "error").length;
  const warnings = entries.filter(({ finding }) => finding.severity === "warning").length;
  const lines = [
    `**${checkTitle(result)}** — ${errors} distinct error(s), ${warnings} distinct warning(s).`,
    "", ...coverageLines(result), "", "### Executed orders", "",
    "| PR application order | Result | SQL execution | Contracts | Duration |",
    "| --- | --- | --- | --- | --- |",
    ...result.orders.map((order) => `| ${orderLabel(order.order)} | ${order.passed ? "Passed" : "Failed"} | ${order.sqlPassed === undefined ? "Not recorded" : order.sqlPassed ? "Passed" : "Failed"} | ${order.contractsChecked ? "Checked" : "Not checked"} | ${order.durationMs} ms |`),
    ""
  ];
  if (result.affectedObjects?.length) lines.push(`Affected catalog objects: ${result.affectedObjects.map((object) => code(object.id)).join(", ")}.`, "");
  if (result.compatibility?.length) {
    lines.push("### PR compatibility", "", "| Pull requests | Classification | Verified passing order |", "| --- | --- | --- |");
    for (const relationship of result.compatibility) lines.push(`| ${relationship.pullRequests.map((pr) => `#${pr}`).join(" ↔ ")} | ${text(relationship.status.replaceAll("_", " "))} | ${relationship.passingOrder?.map((pr) => `#${pr}`).join(" → ") ?? "—"} |`);
    lines.push("");
  }
  if (result.groupCoverage && (result.groupCoverage.tested.length || result.groupCoverage.untested.length)) lines.push(`Three-PR coverage: ${result.groupCoverage.tested.length} permutation(s) tested; ${result.groupCoverage.untested.length} left untested by the ${result.groupCoverage.permutationBudget}-execution budget.`, "");
  if (result.dataDifferences?.length) {
    lines.push("### Fixture-state differences", "");
    for (const difference of result.dataDifferences) lines.push(`- ${code(difference.table)}: ${difference.first?.rowCount ?? "missing"} row(s) / ${code(difference.first?.fingerprint ?? "missing")} versus ${difference.second?.rowCount ?? "missing"} row(s) / ${code(difference.second?.fingerprint ?? "missing")}.`);
    lines.push("");
  }
  if (result.rollbacks.length) {
    lines.push("### Rollback results", "");
    for (const rollback of result.rollbacks) lines.push(`- ${code(rollback.migration)}: **${rollback.status.replaceAll("_", " ")}**; schema restored: ${rollback.schemaRestored ? "yes" : "no"}; fixture data restored: ${rollback.dataRestored === undefined ? "not checked" : rollback.dataRestored ? "yes" : "no"}.`);
    lines.push("");
  }
  if (entries.length) lines.push("### Findings and next steps", "", ...entries.slice(0, 40).flatMap((entry) => findingLines(result, entry)));
  if (entries.length > 40) lines.push(`${entries.length - 40} additional finding(s) are available in the result JSON.`, "");
  const command = result.provenance
    ? `pnpm localmesh validate --input input-${result.currentPr}.json --output result-${result.currentPr}.json`
    : `pnpm --filter @localmesh/worker validate --job ${result.jobId}`;
  lines.push("### Reproduce", "", `Run ${code(command)} using the same base, PR heads, fixtures, and configuration.`);
  if (result.links?.investigation) lines.push(`[Open the Dot75 investigation](${result.links.investigation})`);
  if (result.links?.replay) lines.push(`[Download the replay bundle](${result.links.replay})`);
  lines.push("Verdicts come from PostgreSQL execution and deterministic checks. Suggested fixes are guidance and require review.");
  const summary = lines.join("\n");
  return Buffer.byteLength(summary) <= MAX_BODY_LENGTH ? summary : `${truncateUtf8(summary, MAX_BODY_LENGTH - 100)}\n\nReport truncated. See the saved result JSON for complete evidence.`;
}

export function checkAnnotations(result: ValidationResult): CheckAnnotation[] {
  const currentFiles = result.provenance ? new Set(result.provenance.currentPrFiles) : undefined;
  return findingContexts(result).filter(({ finding, currentPrFile }) => currentPrFile && finding.file
    && (!currentFiles || currentFiles.has(finding.file))).slice(0, 50).map(({ finding, contexts }) => {
    const line = Number.isInteger(finding.line) && finding.line! > 0 ? finding.line! : 1;
    return {
      path: finding.file!, start_line: line, end_line: line,
      annotation_level: finding.severity === "error" ? "failure" : finding.severity === "warning" ? "warning" : "notice",
      title: truncateUtf8(`${finding.code}: ${finding.title}`, 255),
      message: truncateUtf8(`${finding.message}\n\n${contexts.join("; ")}\nSuggested next step: ${findingGuidance(finding.code).action}${finding.line ? "" : "\nExact SQL line unavailable; attached to the start of this migration."}`, MAX_BODY_LENGTH)
    };
  });
}

export function stickyComment(result: ValidationResult): string {
  const check = result.links?.check ? `[Check](${result.links.check})` : `**${DOT75_CHECK_NAME}** Check`;
  const investigation = result.links?.investigation ? ` · [Investigate](${result.links.investigation})` : "";
  if (checkConclusion(result) === "success") {
    const warnings = findingContexts(result).filter(({ finding }) => finding.severity === "warning").length;
    const verdict = result.orders.length === 0 && result.provenance?.currentPrFiles.length === 0
      ? "no migration changes; PostgreSQL execution was not needed" : `${result.orders.length} tested order(s) passed`;
    return truncateUtf8(`${STICKY_COMMENT_MARKER}\n✅ **Dot75 passed**: ${verdict} for ${prLabel(result, result.currentPr)} at ${code(result.headSha.slice(0, 12))} against base ${code(result.baseSha.slice(0, 12))}; ${warnings} warning(s). ${check}${investigation}.`, MAX_BODY_LENGTH);
  }
  const entries = findingContexts(result);
  const top = entries.filter(({ finding }) => finding.severity === "error").slice(0, 5);
  const combined = result.orders.filter((order) => order.order.length > 1);
  const related = result.comparedPullRequests.map((number) => prLabel(result, number)).join(", ") || "none";
  const rollback = result.rollbacks.length ? `${result.rollbacks.filter((item) => item.status === "safe").length}/${result.rollbacks.length} safe` : "not tested";
  const lines = [
    STICKY_COMMENT_MARKER,
    `❌ **Dot75 blocked this merge** for ${prLabel(result, result.currentPr)}.`,
    `Related PRs: ${related}. Combined orders: ${combined.filter((order) => order.passed).length}/${combined.length} passed. Rollbacks: ${rollback}.`,
    ...top.map(({ finding }) => `- **${text(finding.title)}** (${code(finding.code)}): ${text(finding.message)}`),
    `See the required ${check} for complete evidence and reproduction details${investigation}.`
  ];
  return truncateUtf8(lines.join("\n"), MAX_BODY_LENGTH);
}

export async function upsertStickyComment(octokit: Octokit, owner: string, repo: string, result: ValidationResult,
  options: { enabled?: boolean; botLogin?: string } = {}): Promise<void> {
  if (options.enabled === false || result.currentPr === 0) return;
  const botLogin = options.botLogin ?? "github-actions[bot]";
  const comments = await octokit.paginate(octokit.issues.listComments, { owner, repo, issue_number: result.currentPr, per_page: 100 });
  // A marker in a human comment must never grant permission to overwrite it.
  const existing = comments.find((comment) => comment.user?.type === "Bot" && comment.user.login === botLogin
    && comment.body?.startsWith(`${STICKY_COMMENT_MARKER}\n`));
  const body = stickyComment(result);
  if (existing?.body === body) return;
  if (existing) await octokit.issues.updateComment({ owner, repo, comment_id: existing.id, body });
  else await octokit.issues.createComment({ owner, repo, issue_number: result.currentPr, body });
}
