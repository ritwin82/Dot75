import { findingCategory, findingGuidance, type Finding, type ValidationResult } from "@localmesh/shared";

export function ResultFindings({ result }: { result: ValidationResult }) {
  const groups = new Map<string, { finding: Finding; contexts: string[] }>();
  const add = (finding: Finding, context: string) => {
    const key = JSON.stringify([finding.code, finding.message, finding.file]);
    const group = groups.get(key) ?? { finding, contexts: [] };
    if (!group.contexts.includes(context)) group.contexts.push(context);
    groups.set(key, group);
  };
  for (const order of result.orders) for (const finding of order.findings) add(finding, order.order.map((pr) => `PR #${pr}`).join(" → "));
  for (const finding of result.contracts) add(finding, "Contract configuration");
  for (const rollback of result.rollbacks) for (const finding of rollback.findings) add(finding, `Rollback: ${rollback.migration}`);
  for (const finding of result.performance) add(finding, "Performance review");
  return <section className="detail-section" id="findings">
    <div className="product-section-heading compact"><div><div className="product-kicker">Verified by the checks</div><h2>What needs attention</h2></div><span>{groups.size} distinct findings</span></div>
    {groups.size ? [...groups].map(([key, { finding: f, contexts }]) => {
      const guidance = findingGuidance(f.code);
      const differences = Array.isArray(f.evidence?.differences) ? f.evidence.differences.filter((item): item is { id: string; ab?: unknown; ba?: unknown } => Boolean(item) && typeof item === "object" && typeof (item as { id?: unknown }).id === "string") : [];
      return <article className={`evidence-card ${f.severity}`} key={key}>
        <div className="evidence-tags"><span>{findingCategory(f.code)}</span><span>{f.severity}</span><code>{f.code}</code></div>
        <h3>{f.title}</h3><p className="verified-message">{f.message}</p>
        <div className="finding-explanation-grid"><section><span>What caused this</span><p>{guidance.cause}</p></section><section><span>Why this matters</span><p>{guidance.impact}</p></section></div>
        {differences.length ? <div className="definition-comparison"><h4>Database definitions produced by each order</h4>{differences.map((difference) => <div key={difference.id}><code>{difference.id}</code><dl><div><dt>Current PR then related PR</dt><dd>{String(difference.ab ?? "object missing")}</dd></div><div><dt>Related PR then current PR</dt><dd>{String(difference.ba ?? "object missing")}</dd></div></dl></div>)}</div> : null}
        <div className="finding-repair"><h4>Suggested repair</h4><p>{guidance.action}</p><ol>{guidance.steps.map((step, index) => <li key={step}><span>{index + 1}</span>{step}</li>)}</ol><div className="verification-box"><strong>How to prove the repair works</strong><p>{guidance.verification}</p></div></div>
        <p className="occurrences"><strong>Observed in: </strong>{contexts.join("; ")}</p>
        {f.file && <p><strong>Migration: </strong><code>{f.file}{f.line ? `:${f.line}` : ""}</code></p>}
        {f.evidence && <details><summary>Inspect database evidence</summary><pre>{JSON.stringify(f.evidence, null, 2)}</pre></details>}
      </article>;
    }) : <p className="empty-inline">No findings were recorded in the tested scope. Review skipped checks before merging.</p>}
  </section>;
}
