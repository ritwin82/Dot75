import type {Metadata} from "next";

export const dynamic="force-dynamic";
export const metadata:Metadata={title:"Migration check"};
async function getJob(id:string){const response=await fetch(`${process.env.NEXT_PUBLIC_API_URL??"http://localhost:4100"}/api/jobs/${id}`,{cache:"no-store"});return response.ok?response.json():null;}
const titleCase=(value:string)=>value.charAt(0).toUpperCase()+value.slice(1);

export default async function Detail({params}:{params:Promise<{id:string}>}){
  const {id}=await params;
  const job=await getJob(id);
  if(!job)return <section className="not-found"><div className="product-kicker">Validation record</div><h1>Check not found</h1><p>This validation may have expired or the address is incorrect.</p><a className="product-link" href="/dashboard">Back to dashboard</a></section>;
  const r=job.result??{};
  const orders=r.orders??[];
  const findings=[...orders.flatMap((o:any)=>o.findings??[]),...(r.contracts??[]),...(r.rollbacks??[]).flatMap((x:any)=>x.findings??[]),...(r.performance??[])];
  const objects=r.affectedObjects??[];
  return <>
    <section className="detail-hero">
      <a className="product-link" href="/dashboard">Back to dashboard</a>
      <div className="detail-title"><div><div className="product-kicker">{job.owner}/{job.repo} · Pull request #{job.pr_number}</div><h1>Migration check</h1></div><span className={`status status-large ${job.status}`}><i/>{titleCase(job.status)}</span></div>
      <p>{r.explanation?.cause??job.error??"Validation is still in progress."}</p>
    </section>

    <div className="detail-layout">
      <div className="detail-main">
        <section className="detail-section"><div className="product-section-heading compact"><div><div className="product-kicker">Permutation testing</div><h2>Execution orders</h2></div><span>{orders.length} tested</span></div>{orders.length?<div className="order-list">{orders.map((o:any,i:number)=><div className="order-row" key={i}><span className="order-index">{String(i+1).padStart(2,"0")}</span><b>{o.order.map((n:number)=>`PR #${n}`).join("  →  ")}</b><span className={`status ${o.passed?"passed":"failed"}`}><i/>{o.passed?"Passed":"Failed"}</span><span className="duration">{o.durationMs} ms</span></div>)}</div>:<div className="empty-inline">No execution orders recorded.</div>}</section>
        <section className="detail-section"><div className="product-section-heading compact"><div><div className="product-kicker">Deterministic evidence</div><h2>Findings</h2></div><span>{findings.length} found</span></div>{findings.length?<div className="finding-list">{findings.map((f:any,i:number)=><article className={`finding ${f.severity??"error"}`} key={i}><div className="finding-meta"><span>{String(i+1).padStart(2,"0")}</span><span>{f.severity??"error"}</span></div><div><h3>{f.title}</h3><p>{f.message}</p></div></article>)}</div>:<div className="empty-inline">No deterministic findings.</div>}</section>
      </div>
      <aside className="detail-aside">
        <section className="side-section"><div className="product-kicker">Affected objects</div><h2>{String(objects.length).padStart(2,"0")}</h2><div className="objects">{objects.length?objects.map((o:any)=><span className="object" key={o.id}>{o.id}</span>):<p className="muted">No objects recorded.</p>}</div></section>
        <section className="side-section"><div className="product-kicker">Repair guidance</div><h3>Recommended next step</h3><p>{r.explanation?.forwardFix??"Guidance will appear when validation completes."}</p><div className="source"><span>Explanation source</span><b>{r.explanation?.source??"Pending"}</b></div></section>
      </aside>
    </div>
  </>;
}
