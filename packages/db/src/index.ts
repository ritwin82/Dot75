import { Pool } from "pg";
import type { ValidationJob, ValidationResult } from "@localmesh/shared";

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export async function ensureSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS validation_jobs (
      id uuid PRIMARY KEY,
      installation_id bigint NOT NULL,
      owner text NOT NULL,
      repo text NOT NULL,
      pr_number integer NOT NULL,
      head_sha text NOT NULL,
      base_sha text NOT NULL,
      check_run_id bigint,
      status text NOT NULL DEFAULT 'queued',
      result jsonb,
      error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS validation_jobs_repo_pr_idx
      ON validation_jobs(owner, repo, pr_number, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS validation_jobs_dedupe_idx
      ON validation_jobs(owner, repo, pr_number, head_sha, base_sha);
  `);
}

export async function saveJob(job: ValidationJob): Promise<boolean> {
  const result = await pool.query(
    `INSERT INTO validation_jobs(id, installation_id, owner, repo, pr_number, head_sha, base_sha, check_run_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
    [job.id, job.installationId, job.owner, job.repo, job.prNumber, job.headSha, job.baseSha, job.checkRunId ?? null]
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

export async function getJob(id: string): Promise<unknown | null> {
  const { rows } = await pool.query(`SELECT * FROM validation_jobs WHERE id=$1`, [id]);
  return rows[0] ?? null;
}

export async function loadJob(id: string): Promise<ValidationJob | null> {
  const { rows } = await pool.query(`SELECT id, installation_id, owner, repo, pr_number, head_sha, base_sha, check_run_id FROM validation_jobs WHERE id=$1`, [id]);
  const row=rows[0] as Record<string,unknown>|undefined; if(!row)return null;
  return {id:String(row.id),installationId:Number(row.installation_id),owner:String(row.owner),repo:String(row.repo),prNumber:Number(row.pr_number),headSha:String(row.head_sha),baseSha:String(row.base_sha),...(row.check_run_id?{checkRunId:Number(row.check_run_id)}:{})};
}
