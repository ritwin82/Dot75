import { findingCategory, findingFingerprint, type Finding, type FindingRecurrence, type RecurrenceSnapshot, type ValidationResult } from "@localmesh/shared";
import type { CompatibilityJob } from "./compatibility.js";

const allFindings=(result:ValidationResult):Finding[]=>[...result.orders.flatMap((order)=>order.findings),...result.contracts,...result.rollbacks.flatMap((rollback)=>rollback.findings),...result.performance];

export function buildRecurrenceSnapshot(repository:string,jobs:CompatibilityJob[]):RecurrenceSnapshot{
  const ordered=jobs.filter((job)=>job.result&&["passed","failed"].includes(job.status)).sort((a,b)=>Date.parse(a.createdAt)-Date.parse(b.createdAt));
  const latestByPr=new Map<number,string>();for(const job of ordered)if(job.result)latestByPr.set(job.result.currentPr,job.id);
  const entries=new Map<string,FindingRecurrence>();
  for(const job of ordered){
    const seen=new Set<string>();
    for(const finding of allFindings(job.result!)){
      const fingerprint=findingFingerprint(finding);if(seen.has(fingerprint))continue;seen.add(fingerprint);
      const existing=entries.get(fingerprint);const active=latestByPr.get(job.result!.currentPr)===job.id;
      if(existing){existing.count++;existing.lastSeen=job.createdAt;existing.active||=active;if(!existing.pullRequests.includes(job.result!.currentPr))existing.pullRequests.push(job.result!.currentPr);if(existing.jobIds.length<20)existing.jobIds.push(job.id);}
      else entries.set(fingerprint,{fingerprint,code:finding.code,title:finding.title,category:findingCategory(finding.code),count:1,firstSeen:job.createdAt,lastSeen:job.createdAt,active,pullRequests:[job.result!.currentPr],jobIds:[job.id]});
    }
  }
  return {repository,generatedAt:new Date().toISOString(),findings:[...entries.values()].sort((a,b)=>Number(b.active)-Number(a.active)||b.count-a.count||Date.parse(b.lastSeen)-Date.parse(a.lastSeen))};
}
