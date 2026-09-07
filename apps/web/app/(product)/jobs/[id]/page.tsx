import type { Metadata } from "next";
import { cookies } from "next/headers";
import type { PullRequestChangeSummary, ValidationResult } from "@localmesh/shared";
import { ResultFindings } from "../../../components/result-findings";
import { RefreshResult } from "../../../components/refresh-result";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Migration check" };
type Job = { id: string; owner: string; repo: string; pr_number: number; status: string; source?: string; result?: ValidationResult; error?: string };
async function getJob(id: string): Promise<Job | null> {
  const cookieHeader = (await cookies()).toString();
  const response = await fetch(`${process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4100"}/api/jobs/${encodeURIComponent(id)}`, { headers: { cookie: cookieHeader }, cache: "no-store", signal: AbortSignal.timeout(10000) });
  if (response.status === 401) throw new Error("AUTH_REQUIRED");
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("API unavailable");
  return response.json();
}

export default async function Detail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let job: Job | null;
  try { job = await getJob(id); } catch (error) { return error instanceof Error && error.message === "AUTH_REQUIRED" ? <section className="not-found"><h1>GitHub sign-in required</h1><p>Sign in to view checks from repositories connected to your account.</p><a className="primary-button" href={`${process.env.PUBLIC_API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4100"}/auth/github`}>Continue with GitHub</a></section> : <section className="not-found"><h1>Unable to load this check</h1><p>The validation API is unavailable. Check the service deployment, then refresh this page.</p><a href="/dashboard">Back to dashboard</a></section>; }
  if (!job) return <section className="not-found"><h1>Check not found</h1><p>No validation exists at this address.</p><a href="/dashboard">Back to dashboard</a></section>;
  const r = job.result;
  const publicApi = process.env.PUBLIC_API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4100";
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
  const changes: PullRequestChangeSummary[] = r ? r.pullRequestChanges ?? singles.map((order) => ({
    pr: order.order[0]!,
    migrationFiles: order.order[0] === r.currentPr ? r.provenance?.currentPrFiles ?? [] : [],
    operations: [],
    affectedObjects: (order.affectedObjects ?? []).map(({ id: objectId, kind }) => ({ id: objectId, kind }))
  })) : [];
  const prDetails = new Map(r?.provenance?.pullRequests.map((pr) => [pr.number, pr]) ?? []);
  const safeRollbacks = r?.rollbacks.filter((rollback) => rollback.status === "safe").length ?? 0;
  const unsafeRollbacks = (r?.rollbacks.length ?? 0) - safeRollbacks;
  const failedCombined = combined.filter((order) => !order.passed);
  const mergedVerdict = !combined.length ? "No combined PR order was executed in this result."
    : failedCombined.length === 0 ? "The tested PRs can be combined in every recorded order without a blocking finding."
    : failedCombined.length === combined.length ? "Every tested way of combining these PRs failed. Do not merge the pair until the migrations are coordinated."
    : `Only ${combined.length - failedCombined.length} of ${combined.length} tested merge orders passed. Use the recorded passing order or revise the migrations.`;
  return <>
    <section className="detail-hero">
      <a className="product-link" href="/dashboard">Back to dashboard</a>
      <div className="detail-title"><div><div className="product-kicker">{job.owner}/{job.repo} · PR #{job.pr_number}</div><h1>Migration review</h1></div><span className={`status status-large ${job.status}`}><i/>{job.status}</span></div>
      <p>{summary}</p>
      {job.owner === "local-demo" && <p className="scope-note">Local demo · simulated PRs executed in real PostgreSQL. GitHub delivery was not tested.</p>}
      {job.owner !== "local-demo" && <p className="scope-note">Result source: {job.source === "github_action" ? "verified GitHub Action publication" : "GitHub App service validation"}.</p>}
      <RefreshResult active={active || pending}/>
      {job.error && <details className="service-error"><summary>Inspect service error</summary><pre>{job.error}</pre></details>}
    </section>
    {r && <>
      <section className="review-summary" aria-label="Review summary">
        <div><strong>{r.orders.length}</strong><span>Execution orders tested</span></div>
        <div><strong>{r.comparedPullRequests.length}</strong><span>Related PRs compared</span></div>
        <div><strong>{r.scope?.contractMappings ?? "—"}</strong><span>Enabled contract mappings</span></div>
        <div><strong>{r.groupCoverage?.tested.length ?? 0}</strong><span>Three-PR permutations</span></div>
      </section>
      <nav className="review-route" aria-label="Result explanation order">
        <span>Read this result in order</span>
        <a href="#pr-changes">1 · PR changes</a><a href="#merged-result">2 · Combined result</a><a href="#rollback-verification">3 · Rollbacks</a><a href="#plain-explanation">4 · Explanation</a>
      </nav>
      <section className="guided-section" id="pr-changes">
        <div className="step-heading"><span>01</span><div><div className="product-kicker">Start with the inputs</div><h2>What each pull request changes</h2><p>These descriptions come from the migration files and the schema measured after each PR ran alone.</p></div></div>
        <div className="pr-change-grid">{changes.map((change) => { const details = prDetails.get(change.pr); return <article className="pr-change-card" key={change.pr}>
          <header><div><span className="pr-number">PR #{change.pr}</span><h3>{details?.title ?? (change.pr === r.currentPr ? "Current pull request" : "Related migration pull request")}</h3></div>{details?.author && <span className="pr-author">@{details.author}</span>}</header>
          {change.operations.length ? <ol className="operation-list">{change.operations.map((operation, index) => <li key={`${operation.file}:${index}`}><span className={`operation-action ${operation.action}`}>{operation.action}</span><div><strong>{operation.description}</strong><small>{operation.file}</small></div></li>)}</ol>
            : <p className="recording-note">This result predates per-operation summaries. Open the migration files below or rerun the PR to generate the clearer description.</p>}
          <div className="change-evidence"><strong>Migration files</strong><p>{change.migrationFiles.length ? change.migrationFiles.map((file) => <code key={file}>{file}</code>) : "File names were not retained in this older result."}</p></div>
          <div className="change-evidence"><strong>Database objects observed</strong><p>{change.affectedObjects.length ? change.affectedObjects.map((object) => <code key={object.id}>{object.id}</code>) : "No schema-object difference was measured. This can be a data-only change."}</p></div>
        </article>; })}</div>
      </section>
      <section className="guided-section" id="merged-result">
        <div className="step-heading"><span>02</span><div><div className="product-kicker">Then combine them</div><h2>What happens if both PRs merge</h2><p>{mergedVerdict}</p></div></div>
        <div className={`merge-verdict ${failedCombined.length ? "failed" : "passed"}`}><strong>{failedCombined.length ? "Merge blocked" : "Merge compatible"}</strong><p>{singles.filter((order) => order.passed).length} of {singles.length} PRs passed alone. {combined.filter((order) => order.passed).length} of {combined.length} combined orders passed.</p></div>
        <div className="merge-order-grid">{combined.map((order, index) => <article key={index} className={order.passed ? "passed" : "failed"}><span>Merge order {index + 1}</span><h3>{order.order.map((pr) => `PR #${pr}`).join(" → ")}</h3><p>{order.sqlPassed === false ? "PostgreSQL stopped while applying this order." : order.passed ? "SQL, state, and configured checks passed for this order." : "The SQL ran, but the resulting schema, data, or contract was not acceptable."}</p><strong>{order.passed ? "Verified pass" : "Verified failure"}</strong></article>)}</div>
        {r.compatibility?.map((relationship) => <article className={`relationship-summary ${relationship.status}`} key={relationship.pullRequests.join(":")}><strong>{relationship.status.replaceAll("_", " ")}: PR #{relationship.pullRequests[0]} + PR #{relationship.pullRequests[1]}</strong><p>{relationship.reason}</p>{relationship.passingOrder && <p>Passing sequence: {relationship.passingOrder.map((pr) => `PR #${pr}`).join(" → ")}</p>}</article>)}
      </section>
      <section className="guided-section" id="rollback-verification">
        <div className="step-heading"><span>03</span><div><div className="product-kicker">Verify the escape path</div><h2>Can the current PR be rolled back?</h2><p>Each up migration is applied to a fresh database, followed by its paired down migration. Dot75 compares both the schema and fixture-backed rows with the starting state.</p></div></div>
        {r.rollbacks.length ? <><div className="rollback-summary"><div><strong>{safeRollbacks}</strong><span>fully restored</span></div><div className={unsafeRollbacks ? "danger" : ""}><strong>{unsafeRollbacks}</strong><span>unsafe or missing</span></div></div>{r.rollbacks.map((rollback) => <article className={`rollback-proof ${rollback.status}`} key={rollback.migration}><div><span>{rollback.status.replaceAll("_", " ")}</span><code>{rollback.migration}</code></div><ul><li className={rollback.schemaRestored ? "yes" : "no"}>Schema returned to its starting definition: <strong>{rollback.schemaRestored ? "yes" : "no"}</strong></li><li className={rollback.dataRestored === undefined ? "unknown" : rollback.dataRestored ? "yes" : "no"}>Fixture rows returned to their starting values: <strong>{rollback.dataRestored === undefined ? "not checked" : rollback.dataRestored ? "yes" : "no"}</strong></li></ul></article>)}</>
          : <p className="coverage-warning">Rollback was not verified in this run. This result does not show that an undo is safe.</p>}
      </section>
      <section className="ai-review" id="plain-explanation" aria-labelledby="ai-heading">
        <div className="product-kicker">{ai?.source === "ollama" && !pending ? "Ollama explanation" : pending ? "Ollama is preparing an explanation" : "Explanation from recorded evidence"}</div>
        <div className="step-heading ai-step"><span>04</span><div><h2 id="ai-heading">Understand the issue in plain language</h2><p>Ollama explains the verified evidence. It cannot change the pass or fail result.</p></div></div>
        <p className="verified-message"><strong>Verified outcome: </strong>{singles.filter((order) => order.passed).length} of {singles.length} individual PR checks passed. {combined.filter((order) => !order.passed).length} of {combined.length} combined merge orders failed.</p>
        {pending && <p role="status">Database checks are complete. The local model is still generating its explanation.</p>}
        {ai?.fallbackReason && <p className="fallback-notice"><strong>AI unavailable: </strong>{ai.fallbackReason}</p>}
        <div className="cause-panel"><h3>Why the PRs interact</h3><p>{ai?.cause ?? "No explanation was recorded."}</p>{ai?.conflictingObjects.length ? <p><strong>Affected objects: </strong>{ai.conflictingObjects.join(", ")}</p> : null}</div>
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
        <section className="detail-section"><h2>Fixture-state comparison</h2>{r.dataDifferences?.length ? <div className="data-difference-list">{r.dataDifferences.map((difference) => <article key={difference.table}><code>{difference.table}</code><p>{difference.table.startsWith("sequence:") ? "Sequence position differs between orders." : `${difference.first?.rowCount ?? "missing"} row(s) versus ${difference.second?.rowCount ?? "missing"} row(s).`} Fingerprints <code>{difference.first?.fingerprint.slice(0,12) ?? "missing"}</code> / <code>{difference.second?.fingerprint.slice(0,12) ?? "missing"}</code>.</p></article>)}</div> : <p className="section-help">No order-dependent fixture-state or sequence differences were recorded.</p>}</section>
        <section className="detail-section"><h2>Rollback evidence details</h2><p className="section-help">The guided rollback result is shown above. Findings attached to an unsafe down migration remain listed in “What needs attention.”</p></section>
      </div><aside className="detail-aside">
        <section className="side-section"><div className="product-kicker">Test coverage</div><h3>Scope of this result</h3>
          <p>Compared PRs: {r.comparedPullRequests.map((pr) => `#${pr}`).join(", ") || "none"}</p>
          <p>Skipped unrelated PRs: {r.scope ? r.scope.skippedPrs.map((pr) => `#${pr}`).join(", ") || "none" : "not recorded"}</p>
          <p>{r.scope?.fixtureFiles ?? "Unknown number of"} fixture file(s). Fixtures are test data, not production records.</p>
          <p>Related pairs are tested in both orders. Connected three-PR groups run within the configured permutation budget; remaining combinations stay explicitly untested.</p>
          {!r.scope?.contractMappings && <p>No enabled contract mappings were recorded. Contract coverage is not established.</p>}
          <a className="product-link" href={`/repositories/${encodeURIComponent(job.owner)}/${encodeURIComponent(job.repo)}/compatibility`}>Open compatibility map</a>
        </section>
        <section className="side-section"><div className="product-kicker">Affected objects</div><h2>{r.affectedObjects.length}</h2><div className="objects">{r.affectedObjects.map((object) => <span className="object" key={object.id}>{object.id}</span>)}</div>{!r.affectedObjects.length && <p>No schema changes were measured. Data-only migrations can still change rows.</p>}</section>
        <section className="side-section"><div className="product-kicker">Immutable provenance</div><h3>Compatibility receipt</h3><p>Base <code>{r.baseSha}</code></p><p>Head <code>{r.headSha}</code></p><p>Digest <code>{r.provenance?.inputDigest ?? "not recorded"}</code></p><p>Engine {r.provenance?.engineVersion ?? "not recorded"}</p></section>
        <section className="side-section"><div className="product-kicker">Portable evidence</div><h3>Download this result</h3><div className="export-links">{(["json","markdown","sarif","junit"] as const).map((format)=><a className="product-link" key={format} href={`${publicApi}/api/jobs/${encodeURIComponent(job.id)}/export/${format}`}>{format.toUpperCase()}</a>)}</div></section>
        <section className="side-section"><h3>How to read this page</h3><p>Start with each PR’s change, then compare the combined orders, verify rollback, and use the Ollama explanation to plan a fix. The compatibility map carries the same measured relationship across later runs.</p></section>
      </aside></div>
    </>}
  </>;
}
