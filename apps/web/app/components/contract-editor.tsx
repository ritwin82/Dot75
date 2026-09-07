"use client";

import {useEffect,useState} from "react";

type Summary={mappings:{before:number;after:number};schemaAssertions:{before:number;after:number};sqlAssertions:{before:number;after:number}};
type Session={authenticated:boolean;user?:{login:string;avatarUrl:string};csrf?:string};

export function ContractEditor({owner,repo}:{owner:string;repo:string}) {
  const api=process.env.NEXT_PUBLIC_API_URL??"http://localhost:4100";
  const [session,setSession]=useState<Session>(); const [source,setSource]=useState(""); const [baseSha,setBaseSha]=useState("");
  const [summary,setSummary]=useState<Summary>(); const [message,setMessage]=useState("Loading your trusted default-branch configuration…");
  const [busy,setBusy]=useState(false); const [confirmed,setConfirmed]=useState(false); const [pullRequest,setPullRequest]=useState<{url:string;number:number}>();
  const endpoint=`${api}/api/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contracts`;

  useEffect(()=>{void (async()=>{
    try {
      const sessionResponse=await fetch(`${api}/api/session`,{credentials:"include"}); const nextSession=await sessionResponse.json() as Session; setSession(nextSession);
      if(!nextSession.authenticated){setMessage("Sign in with GitHub to load and edit contracts for repositories you can access.");return;}
      const response=await fetch(endpoint,{credentials:"include"}); const body=await response.json() as {source?:string;baseSha?:string;preview?:{summary:Summary};error?:string};
      if(!response.ok)throw new Error(body.error??"The contract configuration could not be loaded.");
      setSource(body.source??"");setBaseSha(body.baseSha??"");setSummary(body.preview?.summary);setMessage("Loaded from the trusted default branch. Preview before publishing.");
    } catch(error){setMessage(error instanceof Error?error.message:String(error));}
  })();},[api,endpoint]);

  async function post(path:string,body:Record<string,unknown>) {
    if(!session?.csrf)throw new Error("Your GitHub session has expired. Sign in again.");
    const response=await fetch(`${endpoint}/${path}`,{method:"POST",credentials:"include",headers:{"content-type":"application/json","x-dot75-csrf":session.csrf},body:JSON.stringify(body)});
    const result=await response.json() as Record<string,unknown>;
    if(!response.ok)throw new Error(String(result.error??"The request failed.")); return result;
  }
  async function preview(){setBusy(true);setPullRequest(undefined);try{const result=await post("preview",{proposedSource:source});const preview=result.preview as {summary:Summary};setSummary(preview.summary);setBaseSha(String(result.baseSha));setConfirmed(false);setMessage("Preview is valid and pinned to the current default-branch revision.");}catch(error){setSummary(undefined);setMessage(error instanceof Error?error.message:String(error));}finally{setBusy(false);}}
  async function publish(){setBusy(true);try{const result=await post("pull-request",{proposedSource:source,baseSha,confirmed});setPullRequest({url:String(result.url),number:Number(result.number)});setMessage("Configuration pull request created. Dot75 did not write to the default branch.");}catch(error){setMessage(error instanceof Error?error.message:String(error));}finally{setBusy(false);}}
  async function copy(){await navigator.clipboard.writeText(source);setMessage("Configuration copied to your clipboard.");}
  function download(){const link=document.createElement("a");link.href=URL.createObjectURL(new Blob([source],{type:"text/yaml"}));link.download="contracts.yml";link.click();URL.revokeObjectURL(link.href);}

  if(session&&!session.authenticated)return <section className="contract-auth"><div className="product-kicker">GitHub authorization required</div><h2>Configure with repository permissions</h2><p>{message}</p><a className="primary-button" href={`${api}/auth/github?returnTo=${encodeURIComponent(`/repositories/${owner}/${repo}/contracts`)}`}>Sign in with GitHub</a></section>;
  return <div className="contract-workspace">
    <section className="contract-toolbar" aria-live="polite"><div><strong>{session?.user?`Signed in as @${session.user.login}`:"Connecting to GitHub…"}</strong><span>{message}</span>{baseSha&&<code>Preview base {baseSha.slice(0,12)}</code>}</div><div><button type="button" onClick={copy} disabled={!source}>Copy YAML</button><button type="button" onClick={download} disabled={!source}>Download</button></div></section>
    <div className="contract-columns"><section><label htmlFor="contract-source">Contract configuration</label><textarea id="contract-source" value={source} onChange={(event)=>{setSource(event.target.value);setSummary(undefined);setConfirmed(false);}} spellCheck={false} aria-describedby="contract-help"/><p id="contract-help">Only read-only custom SQL assertions are accepted. A pull request changes this file and no other repository content.</p></section>
      <aside><div className="product-kicker">Semantic preview</div><h2>Coverage change</h2>{summary?<dl className="semantic-summary"><Change label="Template mappings" value={summary.mappings}/><Change label="Schema assertions" value={summary.schemaAssertions}/><Change label="SQL assertions" value={summary.sqlAssertions}/></dl>:<p className="muted">Run preview to validate YAML and see the semantic change.</p>}
        <button className="primary-button contract-action" type="button" onClick={preview} disabled={busy||!source}>{busy?"Working…":"Validate and preview"}</button>
        {summary&&<div className="publish-confirm"><label><input type="checkbox" checked={confirmed} onChange={(event)=>setConfirmed(event.target.checked)}/> I confirm Dot75 may create a branch and configuration pull request.</label><button className="primary-button contract-action" type="button" onClick={publish} disabled={busy||!confirmed}>Create config PR</button></div>}
        {pullRequest&&<p className="config-pr-success"><strong>PR #{pullRequest.number} is ready.</strong><a className="product-link" href={pullRequest.url}>Review it on GitHub</a></p>}
      </aside></div>
  </div>;
}

function Change({label,value}:{label:string;value:{before:number;after:number}}){const delta=value.after-value.before;return <div><dt>{label}</dt><dd>{value.before} → {value.after} <span>{delta===0?"no change":delta>0?`+${delta}`:String(delta)}</span></dd></div>;}
