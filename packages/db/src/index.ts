import { Pool } from "pg";
import {ENGINE_VERSION,type ValidationJob, type ValidationResult } from "@localmesh/shared";
import {migrateDatabase as runMigrations} from "./migrate.js";

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export async function migrateDatabase():Promise<void>{await runMigrations(pool);}

export async function saveJob(job: ValidationJob): Promise<boolean> {
  const result = await pool.query(
    `INSERT INTO validation_jobs(id, installation_id, owner, repo, pr_number, head_sha, base_sha, check_run_id, engine_version)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
    [job.id, job.installationId, job.owner, job.repo, job.prNumber, job.headSha, job.baseSha, job.checkRunId ?? null,job.engineVersion??ENGINE_VERSION]
  );
  return result.rowCount === 1;
}

export async function cancelStaleJobs(owner: string, repo: string, pr: number, currentHead: string): Promise<Array<{id:string;checkRunId?:number}>> {
  const {rows}=await pool.query(
    `UPDATE validation_jobs SET status='cancelled', updated_at=now()
     WHERE owner=$1 AND repo=$2 AND pr_number=$3 AND head_sha<>$4 AND status IN ('queued','running')
     RETURNING id, check_run_id`,
    [owner, repo, pr, currentHead]
  );
  return rows.map((row)=>({id:String(row.id),...(row.check_run_id?{checkRunId:Number(row.check_run_id)}:{})}));
}

export async function setJobStatus(id: string, status: string, result?: ValidationResult, error?: string): Promise<void> {
  await pool.query(
    `UPDATE validation_jobs SET status=$2, result=COALESCE($3,result), error=$4, updated_at=now()
     WHERE id=$1 AND (status<>'cancelled' OR $2='cancelled')`,
    [id, status, result ? JSON.stringify(result) : null, error ?? null]
  );
}

export async function setCheckRunId(id:string,checkRunId:number):Promise<void>{await pool.query(`UPDATE validation_jobs SET check_run_id=$2,updated_at=now() WHERE id=$1`,[id,checkRunId]);}
export async function isJobCancelled(id:string):Promise<boolean>{const {rows}=await pool.query(`SELECT status='cancelled' AS cancelled FROM validation_jobs WHERE id=$1`,[id]);return rows[0]?.cancelled===true;}

export async function listJobs(limit = 50): Promise<unknown[]> {
  const { rows } = await pool.query(
    `SELECT id, owner, repo, pr_number AS "prNumber", head_sha AS "headSha", base_sha AS "baseSha",
            status, result, error, created_at AS "createdAt", updated_at AS "updatedAt"
     FROM validation_jobs ORDER BY created_at DESC LIMIT $1`, [Math.min(limit, 200)]
  );
  return rows;
}

export async function listRepositoryJobs(owner: string, repo: string, limit = 200): Promise<unknown[]> {
  const { rows } = await pool.query(
    `SELECT id, owner, repo, pr_number AS "prNumber", head_sha AS "headSha", base_sha AS "baseSha",
            status, result, error, created_at AS "createdAt", updated_at AS "updatedAt"
     FROM validation_jobs WHERE owner=$1 AND repo=$2 ORDER BY created_at DESC LIMIT $3`,
    [owner, repo, Math.min(Math.max(limit, 1), 500)]
  );
  return rows;
}

export async function getJob(id: string): Promise<unknown | null> {
  const { rows } = await pool.query(`SELECT * FROM validation_jobs WHERE id=$1`, [id]);
  return rows[0] ?? null;
}

export type JobEventStage="discovery"|"baseline"|"standalone"|"relationships"|"contracts"|"rollback"|"reporting"|"explaining"|"remediating"|"completed";
export interface JobEvent {id:number;jobId:string;stage:JobEventStage;state:"started"|"completed"|"failed"|"info";message:string;details?:Record<string,unknown>;createdAt:string}
export async function appendJobEvent(jobId:string,stage:JobEventStage,state:JobEvent["state"],message:string,details?:Record<string,unknown>):Promise<void>{
  await pool.query("INSERT INTO job_events(job_id,stage,state,message,details) VALUES($1,$2,$3,$4,$5)",[jobId,stage,state,message,details?JSON.stringify(details):null]);
}
export async function listJobEvents(jobId:string,after=0,limit=100):Promise<JobEvent[]> {
  const {rows}=await pool.query(`SELECT id,job_id AS "jobId",stage,state,message,details,created_at AS "createdAt" FROM job_events WHERE job_id=$1 AND id>$2 ORDER BY id LIMIT $3`,[jobId,Math.max(0,after),Math.min(Math.max(limit,1),500)]);
  return rows.map((row)=>({...row,id:Number(row.id)})) as JobEvent[];
}
export async function saveAuditEvent(event:{actor:string;action:string;owner:string;repo:string;details?:Record<string,unknown>}):Promise<void>{
  await pool.query("INSERT INTO audit_events(actor,action,owner,repo,details) VALUES($1,$2,$3,$4,$5)",[event.actor,event.action,event.owner,event.repo,JSON.stringify(event.details??{})]);
}
export async function saveReplayInput(jobId:string,input:unknown):Promise<void>{await pool.query("UPDATE validation_jobs SET replay_input=$2,updated_at=now() WHERE id=$1",[jobId,JSON.stringify(input)]);}
export async function loadReplayInput(jobId:string):Promise<unknown|undefined>{const {rows}=await pool.query("SELECT replay_input FROM validation_jobs WHERE id=$1",[jobId]);return rows[0]?.replay_input;}
export async function createRemediationAttempt(id:string,jobId:string,actor:string):Promise<void>{await pool.query("INSERT INTO remediation_attempts(id,validation_job_id,actor) VALUES($1,$2,$3)",[id,jobId,actor]);}
export async function setRemediationAttempt(id:string,status:string,result?:unknown,error?:string):Promise<void>{await pool.query("UPDATE remediation_attempts SET status=$2,result=COALESCE($3,result),error=$4,updated_at=now() WHERE id=$1",[id,status,result?JSON.stringify(result):null,error??null]);}
export async function getRemediationAttempt(id:string):Promise<unknown|null>{const {rows}=await pool.query(`SELECT r.id,r.validation_job_id AS "jobId",r.actor,r.status,r.result,r.error,r.created_at AS "createdAt",r.updated_at AS "updatedAt",j.owner,j.repo FROM remediation_attempts r JOIN validation_jobs j ON j.id=r.validation_job_id WHERE r.id=$1`,[id]);return rows[0]??null;}

export async function loadJob(id: string): Promise<ValidationJob | null> {
  const { rows } = await pool.query(`SELECT id, installation_id, owner, repo, pr_number, head_sha, base_sha, check_run_id, engine_version FROM validation_jobs WHERE id=$1`, [id]);
  const row=rows[0] as Record<string,unknown>|undefined; if(!row)return null;
  return {id:String(row.id),installationId:Number(row.installation_id),owner:String(row.owner),repo:String(row.repo),prNumber:Number(row.pr_number),headSha:String(row.head_sha),baseSha:String(row.base_sha),engineVersion:String(row.engine_version??ENGINE_VERSION),...(row.check_run_id?{checkRunId:Number(row.check_run_id)}:{})};
}
