import type { Metadata } from "next";
import { findingCategory, type ValidationResult } from "@localmesh/shared";
import { RefreshResult } from "../../components/refresh-result";
import {apiFetch,githubSignInUrl} from "../../lib/api";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Dashboard" };
type Job = { id: string; owner: string; repo: string; prNumber: number; status: string; result?: ValidationResult; createdAt: string };

export default async function Dashboard() {
  let list: Job[];
  try {
    const response = await apiFetch("/api/jobs");
    if(response.status===401)return <div className="dashboard-page"><section className="dashboard-heading contract-auth dashboard-auth"><div className="product-kicker">Private investigation workspace</div><h1>Sign in to inspect repository evidence</h1><p>Dot75 checks your live GitHub repository access before showing runs, compatibility history, or migration SQL.</p><a className="primary-button" href={githubSignInUrl("/dashboard")}>Sign in with GitHub</a></section></div>;
    if (!response.ok) throw new Error("API unavailable");
    list = (await response.json()).jobs;
  } catch { return <section className="not-found"><h1>Dashboard unavailable</h1><p>The API could not be reached. Start the API and metadata database, then refresh.</p></section>; }
  const passed = list.filter((job) => job.status === "passed").length;
  const failed = list.filter((job) => job.status === "failed").length;
  const running = list.filter((job) => ["queued", "running"].includes(job.status)).length;
  const comparisons = list.reduce((n, job) => n + (job.result?.comparedPullRequests.length ?? 0), 0);
  const repositories = [...new Map(list.filter((job) => job.owner !== "local-demo").map((job) => [`${job.owner}/${job.repo}`, { owner: job.owner, repo: job.repo }])).values()];
  return <div className="dashboard-page">
    <section className="dashboard-heading"><div className="product-kicker">Installation workspace</div><h1>Migration activity</h1><p>Open a check to see the evidence, affected PRs, contract coverage and local AI explanation.</p><RefreshResult active={running > 0 || list.some((job) => job.result?.explanationStatus === "pending")}/></section>
    <section className="dashboard-stats" aria-label="Validation summary"><Metric value={list.length} label="Recent validation runs"/><Metric value={comparisons} label="PR pairs tested"/><Metric value={passed} label="Passing" tone="passed"/><Metric value={failed} label={`Failed · ${running} active`} tone="failed"/></section>
    {repositories.length > 0 && <section className="repository-maps"><div className="product-kicker">Repository investigation and configuration</div><div>{repositories.flatMap((repository) => [<a key={`${repository.owner}/${repository.repo}:map`} href={`/repositories/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/compatibility`}><b>{repository.owner}/{repository.repo}</b><span>Open compatibility map →</span></a>,<a key={`${repository.owner}/${repository.repo}:history`} href={`/repositories/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/recurrence`}><b>{repository.owner}/{repository.repo}</b><span>View recurrence history →</span></a>,<a key={`${repository.owner}/${repository.repo}:contracts`} href={`/repositories/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/contracts`}><b>{repository.owner}/{repository.repo}</b><span>Configure contract mappings →</span></a>])}</div></section>}
    <section className="checks-section" id="recent-checks"><div className="product-section-heading"><div><div className="product-kicker">Repository activity</div><h2>Recent checks</h2></div><span>{list.length} shown</span></div>
      {list.length ? <div className="check-list"><div className="table-head"><span>Repository / finding</span><span>Result / explanation</span><span>Related PRs</span><span>Created</span></div>{list.map((job) => {
        const r = job.result;
        const errors = r ? [...r.orders.flatMap((order) => order.findings), ...r.contracts, ...r.rollbacks.flatMap((rollback) => rollback.findings)].filter((finding) => finding.severity === "error") : [];
        const categories = [...new Set(errors.map((finding) => findingCategory(finding.code)))];
        return <a className="check-row" href={`/jobs/${job.id}`} key={job.id}><span className="repo"><b>{job.owner}/{job.repo}</b><small>PR #{job.prNumber}{job.owner === "local-demo" ? " · Local simulation" : ""}</small><small>{categories.join(" · ") || (job.status === "passed" ? "No blocking findings" : "See check details")}</small></span><span><span className={`status ${job.status}`}><i/>{job.status}</span><small className="explanation-label">{r?.explanationStatus === "pending" ? "AI preparing…" : r?.explanation?.source === "ollama" ? "Ollama explained" : r?.explanation?.fallbackReason ? "AI unavailable" : "Database evidence"}</small></span><span className="table-value">{r?.comparedPullRequests.map((pr) => `#${pr}`).join(", ") || "—"}</span><time className="table-value">{new Date(job.createdAt).toLocaleString()}</time></a>;
      })}</div> : <div className="dashboard-empty"><span>00</span><div><h3>No checks recorded yet</h3><p>Update a migration PR in a connected repository or run the local demo.</p></div></div>}
    </section>
  </div>;
}
function Metric({ value, label, tone = "default" }: { value: number; label: string; tone?: "default" | "passed" | "failed" }) { return <div className={`dashboard-metric ${tone}`}><strong>{String(value).padStart(2, "0")}</strong><span>{label}</span></div>; }
