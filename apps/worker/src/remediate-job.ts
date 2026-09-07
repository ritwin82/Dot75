import {remediateValidationInput} from "@localmesh/engine";
import {appendJobEvent,getJob,loadReplayInput,saveAuditEvent,setRemediationAttempt} from "@localmesh/db";

export interface RemediationJob {attemptId:string;jobId:string;actor:string}
export async function runRemediationJob(job:RemediationJob):Promise<void>{
  await setRemediationAttempt(job.attemptId,"running");
  const validation=await getJob(job.jobId) as {owner:string;repo:string}|null;
  try{
    if(!validation)throw new Error("Source validation no longer exists.");const replay=await loadReplayInput(job.jobId);if(!replay)throw new Error("Source validation does not contain a replay bundle.");
    const model=process.env.OLLAMA_MODEL;if(!model)throw new Error("Local AI remediation is not configured on the worker.");
    const attempt=await remediateValidationInput(replay,{model,url:process.env.OLLAMA_URL??"http://localhost:11434",timeoutMs:Number(process.env.OLLAMA_TIMEOUT_MS??120000)});
    await setRemediationAttempt(job.attemptId,"completed",attempt);
    await saveAuditEvent({actor:job.actor,action:"remediation.completed",owner:validation.owner,repo:validation.repo,details:{jobId:job.jobId,attemptId:job.attemptId,status:attempt.status,sourceDigest:attempt.sourceDigest,verified:attempt.candidates.filter((candidate)=>candidate.status==="verified").length,model:attempt.model,promptVersion:attempt.promptVersion}});
    await appendJobEvent(job.jobId,"remediating","completed","Remediation candidates finished deterministic verification.",{attemptId:job.attemptId,status:attempt.status,verified:attempt.candidates.filter((candidate)=>candidate.status==="verified").length});
  }catch(error){const message=error instanceof Error?error.message:String(error);await setRemediationAttempt(job.attemptId,"failed",undefined,message);if(validation)await appendJobEvent(job.jobId,"remediating","failed","Remediation could not complete.",{attemptId:job.attemptId,error:message});throw error;}
}
