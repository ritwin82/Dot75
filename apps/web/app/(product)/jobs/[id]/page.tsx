import type { Metadata } from "next";
import type { ValidationResult } from "@localmesh/shared";
import { ResultFindings } from "../../../components/result-findings";
import { RefreshResult } from "../../../components/refresh-result";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Migration check" };
type Job = { id: string; owner: string; repo: string; pr_number: number; status: string; result?: ValidationResult; error?: string };
async function getJob(id: string): Promise<Job | null> {
  const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4100"}/api/jobs/${encodeURIComponent(id)}`, { cache: "no-store", signal: AbortSignal.timeout(10000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("API unavailable");
  return response.json();
}

export default async function Detail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let job: Job | null;
  try { job = await getJob(id); } catch { return <section className="not-found"><h1>Unable to load this check</h1><p>The validation API is unavailable. Start the API and database, then refresh this page.</p><a href="/dashboard">Back to dashboard</a></section>; }
  if (!job) return <section className="not-found"><h1>Check not found</h1><p>No validation exists at this address.</p><a href="/dashboard">Back to dashboard</a></section>;
  const r = job.result;
  const ai = r?.explanation;
  const pending = r?.explanationStatus === "pending";
  const active = ["running", "queued"].includes(job.status);
  const singles = r?.orders.filter((order) => order.order.length === 1) ?? [];
  const combined = r?.orders.filter((order) => order.order.length > 1) ?? [];
  const errors = r ? [...r.orders.flatMap((order) => order.findings), ...r.contracts, ...r.rollbacks.flatMap((rollback) => rollback.findings)].filter((finding) => finding.severity === "error") : [];
  const summary = !r ? (job.error ? "Validation could not finish. Review the service error below." : "The worker is preparing this validation.")
    : job.status === "failed" ? `Checks found ${new Set(errors.map((finding) => finding.code)).size} kind(s) of blocking issue. Review the evidence before merging.`
    : job.status === "passed" ? "All executed checks passed. Review the tested scope and any checks that were skipped."
    : "This validation was cancelled or superseded.";
  return <>
    <section className="detail-hero">
      <a className="product-link" href="/dashboard">Back to dashboard</a>
      <div className="detail-title"><div><div className="product-kicker">{job.owner}/{job.repo} · PR #{job.pr_number}</div><h1>Migration review</h1></div><span className={`status status-large ${job.status}`}><i/>{job.status}</span></div>
      <p>{summary}</p>
      {job.owner === "local-demo" && <p className="scope-note">Local demo · simulated PRs executed in real PostgreSQL. GitHub delivery was not tested.</p>}
      <RefreshResult active={active || pending}/>
      {job.error && <details className="service-error"><summary>Inspect service error</summary><pre>{job.error}</pre></details>}
    </section>
    {r && <>
      <section className="review-summary" aria-label="Review summary">
        <div><strong>{r.orders.length}</strong><span>Execution orders tested</span></div>
        <div><strong>{r.comparedPullRequests.length}</strong><span>Related PRs compared</span></div>
        <div><strong>{r.scope?.contractMappings ?? "—"}</strong><span>Enabled contract mappings</span></div>
        <div><strong>{ai?.source === "ollama" ? "Local AI" : pending ? "Preparing" : "Evidence"}</strong><span>{ai?.model ?? "Explanation source"}</span></div>
      </section>
      <section className="ai-review" aria-labelledby="ai-heading">
        <div className="product-kicker">{ai?.source === "ollama" && !pending ? "Ollama explanation" : pending ? "Ollama is preparing an explanation" : "Explanation from recorded evidence"}</div>
        <h2 id="ai-heading">Understand this result</h2>
        <p className="verified-message"><strong>Verified outcome: </strong>{singles.filter((order) => order.passed).length} of {singles.length} individual PR checks passed. {combined.filter((order) => !order.passed).length} of {combined.length} combined merge orders failed.</p>
        {pending && <p role="status">Database checks are complete. The local model is still generating its explanation.</p>}
        {ai?.fallbackReason && <p className="fallback-notice"><strong>AI unavailable: </strong>{ai.fallbackReason}</p>}
        <p>{ai?.cause ?? "No explanation was recorded."}</p>
        <div className="explanation-columns"><div><h3>Suggested repair</h3><p>{ai?.forwardFix ?? "Use the next steps in each finding below."}</p></div><div><h3>Rollback coverage</h3><p>{r.rollbacks.length ? ai?.rollbackFix ?? "Review the measured rollback checks below." : "Rollback was not tested in this run. Verify matching down migrations against the starting schema and fixture data before relying on an undo."}</p></div></div>
        {ai?.assumptions.length ? <details><summary>Assumptions and uncertainties ({ai.assumptions.length})</summary><ul>{ai.assumptions.map((assumption, i) => <li key={i}>{assumption}</li>)}</ul></details> : null}
        <p className="ai-disclosure">{ai?.source === "ollama" ? `Model: ${ai.model ?? "Ollama"} · ${Math.round((ai.durationMs ?? 0) / 1000)}s · Model-reported confidence: ${ai.confidence}${ai.cached ? " · Cached explanation" : ""}. Suggestions need review; they have not been executed.` : "The explanation above summarizes the measured findings."} Pass/fail is determined by database checks.</p>
      </section>
      <div className="detail-layout"><div className="detail-main">
        <section className="detail-section"><div className="product-section-heading compact"><div><div className="product-kicker">Compare merge orders</div><h2>What was tested</h2></div></div>
          <p className="section-help">Each row uses a fresh database. A combined check can fail even when its SQL succeeds, because contracts or the final schema disagree.</p>
          <div className="order-list">{r.orders.map((order, i) => <div className="order-review" key={i}>
            <div><b>{order.order.map((pr) => `PR #${pr}`).join(" → ")}</b><small>{order.order.length === 1 ? "Tested individually" : "Tested together"} · {order.durationMs} ms</small></div>
            <span className={`status ${order.passed ? "passed" : "failed"}`}><i/>{order.passed ? "Passed" : "Failed"}</span>
            <p>{order.sqlPassed === false ? "SQL execution failed." : order.sqlPassed === true ? "SQL executed successfully." : "SQL execution detail was not recorded."} {order.contractsChecked ? "Configured contracts checked." : "Contracts not checked in this order."} {!order.passed && <a href="#findings">See findings ↓</a>}</p>
          </div>)}</div>
        </section>
        <ResultFindings result={r}/>
        <section className="detail-section"><h2>Rollback checks</h2>{r.rollbacks.length ? r.rollbacks.map((rollback) => <div className="rollback-row" key={rollback.migration}><code>{rollback.migration}</code><strong>{rollback.status.replaceAll("_", " ")}</strong><p>Schema restored: {rollback.schemaRestored ? "yes" : "no"} · Fixture data restored: {rollback.dataRestored === undefined ? "not checked" : rollback.dataRestored ? "yes" : "no"}</p></div>) : <p className="section-help">No rollback results were recorded. This is not evidence that rollback is safe.</p>}</section>
      </div><aside className="detail-aside">
        <section className="side-section"><div className="product-kicker">Test coverage</div><h3>Scope of this result</h3>
          <p>Compared PRs: {r.comparedPullRequests.map((pr) => `#${pr}`).join(", ") || "none"}</p>
          <p>Skipped unrelated PRs: {r.scope ? r.scope.skippedPrs.map((pr) => `#${pr}`).join(", ") || "none" : "not recorded"}</p>
          <p>{r.scope?.fixtureFiles ?? "Unknown number of"} fixture file(s). Fixtures are test data, not production records.</p>
          <p>Comparisons are pairwise with the current PR. All-PR permutations are not covered.</p>
          {!r.scope?.contractMappings && <p>No enabled contract mappings were recorded. Contract coverage is not established.</p>}
        </section>
        <section className="side-section"><div className="product-kicker">Affected objects</div><h2>{r.affectedObjects.length}</h2><div className="objects">{r.affectedObjects.map((object) => <span className="object" key={object.id}>{object.id}</span>)}</div>{!r.affectedObjects.length && <p>No schema changes were measured. Data-only migrations can still change rows.</p>}</section>
        <section className="side-section"><h3>How to read this page</h3><p>Schema checks protect database structure. Data contracts protect business rules. Rollback checks measure whether an undo restores the starting state.</p></section>
      </aside></div>
    </>}
  </>;
}
