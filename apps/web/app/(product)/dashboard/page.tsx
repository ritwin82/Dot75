import type {Metadata} from "next";

export const dynamic="force-dynamic";
export const metadata:Metadata={title:"Dashboard"};
type Job={id:string;owner:string;repo:string;prNumber:number;status:string;result?:{comparedPullRequests?:number[];orders?:unknown[]};createdAt:string};
async function jobs():Promise<Job[]>{try{const response=await fetch(`${process.env.NEXT_PUBLIC_API_URL??"http://localhost:4100"}/api/jobs`,{cache:"no-store"});if(!response.ok)return[];return (await response.json()).jobs;}catch{return[]}}

const formatStatus=(status:string)=>status.charAt(0).toUpperCase()+status.slice(1);

export default async function Dashboard(){
  const list=await jobs();
  const passed=list.filter((j)=>j.status==="passed").length;
  const failed=list.filter((j)=>j.status==="failed").length;
  const running=list.filter((j)=>["queued","running"].includes(j.status)).length;
  const comparisons=list.reduce((n,j)=>n+(j.result?.comparedPullRequests?.length??0),0);
  return <div className="dashboard-page">
    <section className="dashboard-heading">
      <div><div className="product-kicker">Installation workspace</div><h1>Migration activity</h1><p>Validation results from repositories connected to this Dot75 installation.</p></div>
    </section>

    <section className="dashboard-stats" aria-label="Validation summary">
      <Metric value={list.length} label="Validation runs"/>
      <Metric value={comparisons} label="PR pairs tested"/>
      <Metric value={passed} label="Passing" tone="passed"/>
      <Metric value={failed+running} label={`${failed} failed, ${running} active`} tone={failed?"failed":"default"}/>
    </section>

    <section className="checks-section" id="recent-checks">
      <div className="product-section-heading"><div><div className="product-kicker">Repository activity</div><h2>Recent checks</h2></div><span>{list.length} total</span></div>
      {list.length?<div className="check-list"><div className="table-head"><span>Repository</span><span>Status</span><span>Related PRs</span><span>Created</span></div>{list.map((job)=><a className="check-row" href={`/jobs/${job.id}`} key={job.id}><span className="repo"><b>{job.owner}/{job.repo}</b><small>Pull request #{job.prNumber}</small></span><span><span className={`status ${job.status}`}><i/>{formatStatus(job.status)}</span></span><span className="table-value">{job.result?.comparedPullRequests?.length??0}</span><time className="table-value">{new Date(job.createdAt).toLocaleString()}</time></a>)}</div>:<div className="dashboard-empty"><span>00</span><div><h3>No checks recorded yet</h3><p>Update a pull request containing a SQL migration in a connected repository. Its first validation will appear here.</p></div></div>}
    </section>
  </div>;
}

function Metric({value,label,tone="default"}:{value:number;label:string;tone?:"default"|"passed"|"failed"}){return <div className={`dashboard-metric ${tone}`}><strong>{String(value).padStart(2,"0")}</strong><span>{label}</span></div>}
