import type { CSSProperties } from "react";
import type { CompatibilityGraphSnapshot, CompatibilityStatus } from "@localmesh/shared";
import {apiFetch,githubSignInUrl} from "../../../../../lib/api";

export const dynamic = "force-dynamic";

const labels: Record<CompatibilityStatus, string> = {
  compatible: "Compatible", conflict: "Conflict", order_sensitive: "Order-sensitive", independent: "Independent",
  standalone_invalid: "Invalid alone", untested: "Untested"
};

export default async function CompatibilityPage({ params }: { params: Promise<{ owner: string; repo: string }> }) {
  const { owner, repo } = await params;
  let graph: CompatibilityGraphSnapshot | null = null;
  try {
    const response = await apiFetch(`/api/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/compatibility`);
    if(response.status===401)return <section className="contract-auth"><div className="product-kicker">Private compatibility evidence</div><h2>Sign in to open this map</h2><p>Repository access is verified against GitHub.</p><a className="primary-button" href={githubSignInUrl(`/repositories/${owner}/${repo}/compatibility`)}>Sign in with GitHub</a></section>;
    if (response.ok) graph = await response.json();
  } catch { /* Render a useful unavailable state below. */ }
  if (!graph) return <section className="not-found"><a className="product-link" href="/dashboard">Back to dashboard</a><h1>Compatibility map unavailable</h1><p>Dot75 needs at least one completed validation for {owner}/{repo} before it can build an evidence-backed map.</p></section>;
  const count = graph.nodes.length;
  const positions = new Map(graph.nodes.map((node, index) => {
    const angle = -Math.PI / 2 + (Math.PI * 2 * index / Math.max(count, 1));
    return [node.pr, { x: 50 + Math.cos(angle) * 38, y: 50 + Math.sin(angle) * 36 }];
  }));
  return <div className="compatibility-page">
    <section className="compatibility-heading">
      <a className="product-link" href="/dashboard">Back to dashboard</a><div className="product-kicker">Measured PR relationships</div>
      <h1>Compatibility map</h1><p>{graph.repository} at base <code>{graph.baseSha.slice(0, 12)}</code>. Every colored relationship is backed by a stored PostgreSQL validation.</p>
    </section>
    <section className="compatibility-metrics" aria-label="Compatibility coverage"><Metric value={graph.nodes.length} label="Observed PRs"/><Metric value={graph.edges.filter((edge) => edge.status === "conflict").length} label="Conflicts" tone="conflict"/><Metric value={graph.edges.filter((edge) => edge.status === "order_sensitive").length} label="Order-sensitive" tone="order_sensitive"/><Metric value={`${graph.coverage.classifiedPairs}/${graph.coverage.possiblePairs}`} label="Pairs classified"/></section>
    <div className="map-legend" aria-label="Relationship legend">{Object.entries(labels).map(([status, label]) => <span key={status} className={`legend-${status}`}><i/>{label}</span>)}</div>
    <section className="compatibility-map" aria-label={`Compatibility graph for ${graph.repository}`}>
      <svg viewBox="0 0 1000 620" role="img" aria-label="Pull request relationship lines">
        <defs><marker id="order-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z"/></marker></defs>
        {graph.edges.map((edge) => { const a=positions.get(edge.pullRequests[0])!;const b=positions.get(edge.pullRequests[1])!;return <line key={edge.pullRequests.join(":")} className={`map-edge ${edge.status}`} x1={a.x*10} y1={a.y*6.2} x2={b.x*10} y2={b.y*6.2} markerEnd={edge.status === "order_sensitive" ? "url(#order-arrow)" : undefined}/>; })}
      </svg>
      {graph.nodes.map((node) => { const point=positions.get(node.pr)!;return <a href={`#pr-${node.pr}`} key={node.pr} className={`map-pr ${node.standalone}`} style={{ "--map-x": `${point.x}%`, "--map-y": `${point.y}%` } as CSSProperties}><b>PR #{node.pr}</b><span>{node.title ?? "Migration change"}</span><small>{node.author ? `@${node.author} · ` : ""}{node.headSha?.slice(0, 8) ?? "SHA unknown"}</small></a>; })}
    </section>
    <section className="relationship-section"><div className="product-section-heading"><div><div className="product-kicker">Recorded evidence</div><h2>PR relationships</h2></div><span>{graph.edges.length} observed</span></div>
      <div className="relationship-list">{graph.edges.map((edge) => <article className={`relationship-card ${edge.status}`} id={`pr-${edge.pullRequests[0]}`} key={edge.pullRequests.join(":")}>
        <div><span className="relationship-status">{labels[edge.status]}</span><h3>PR #{edge.pullRequests[0]} ↔ PR #{edge.pullRequests[1]}</h3></div>
        <p>{edge.reason}</p>{edge.passingOrder && <p><strong>Verified passing order: </strong>{edge.passingOrder.map((pr) => `PR #${pr}`).join(" → ")}</p>}
        <p><strong>Finding codes: </strong>{edge.findingCodes.join(", ") || "none"}</p>
        {edge.sourceJobId && <a className="product-link" href={`/jobs/${edge.sourceJobId}`}>Open source validation</a>}
      </article>)}</div>
      {graph.coverage.missingPairs > 0 && <p className="coverage-warning">{graph.coverage.missingPairs} relationship(s) remain unclassified. Dot75 does not infer safety without recorded evidence.</p>}
    </section>
  </div>;
}

function Metric({ value, label, tone = "default" }: { value: string | number; label: string; tone?: string }) { return <div className={`compatibility-metric ${tone}`}><strong>{value}</strong><span>{label}</span></div>; }
