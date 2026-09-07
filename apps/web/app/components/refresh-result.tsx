"use client";
import { useEffect,useState } from "react";
import { useRouter } from "next/navigation";

export function RefreshResult({ active,jobId }: { active: boolean;jobId?:string }) {
  const router = useRouter();
  const [stage,setStage]=useState("Waiting for the next validation stage…");
  useEffect(() => {
    if (!active) return;
    const api=process.env.NEXT_PUBLIC_API_URL??"http://localhost:4100";let poll:ReturnType<typeof setInterval>|undefined;
    if(!jobId){setStage("Using periodic refresh for active repository jobs.");poll=setInterval(()=>{if(document.visibilityState==="visible")router.refresh();},4000);return()=>clearInterval(poll);}
    const source=new EventSource(`${api}/api/jobs/${encodeURIComponent(jobId)}/events`,{withCredentials:true});
    source.addEventListener("job-stage",(event)=>{const update=JSON.parse((event as MessageEvent).data) as {stage:string;message:string};setStage(update.message);if(["reporting","completed","explaining"].includes(update.stage)&&document.visibilityState==="visible")router.refresh();});
    source.onerror=()=>{source.close();setStage("Live updates are unavailable; using periodic refresh.");poll=setInterval(()=>{if(document.visibilityState==="visible")router.refresh();},4000);};
    return () => {source.close();if(poll)clearInterval(poll);};
  }, [active, jobId,router]);
  return active ? <p className="live-note" role="status"><strong>Live progress: </strong>{stage}</p> : null;
}
