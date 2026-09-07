import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { GitHubAccountInstallation, GitHubRepositoryAccess, PublishedActionResult, ValidationJob, ValidationResult } from "@localmesh/shared";

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
      source text NOT NULL DEFAULT 'github_app',
      external_id text,
      trigger text,
      engine_version text NOT NULL DEFAULT '0.1.0',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE validation_jobs ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'github_app';
    ALTER TABLE validation_jobs ADD COLUMN IF NOT EXISTS external_id text;
    ALTER TABLE validation_jobs ADD COLUMN IF NOT EXISTS trigger text;
    ALTER TABLE validation_jobs ADD COLUMN IF NOT EXISTS engine_version text NOT NULL DEFAULT '0.1.0';
    CREATE INDEX IF NOT EXISTS validation_jobs_repo_pr_idx
      ON validation_jobs(owner, repo, pr_number, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS validation_jobs_dedupe_idx
      ON validation_jobs(owner, repo, pr_number, head_sha, base_sha);
    CREATE UNIQUE INDEX IF NOT EXISTS validation_jobs_external_id_idx
      ON validation_jobs(external_id) WHERE external_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS github_users (
      id bigint PRIMARY KEY,
      login text NOT NULL,
      avatar_url text,
      access_token_ciphertext text,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE github_users ADD COLUMN IF NOT EXISTS access_token_ciphertext text;
    CREATE TABLE IF NOT EXISTS github_installations (
      id bigint PRIMARY KEY,
      account_id bigint NOT NULL,
      account_login text NOT NULL,
      account_type text NOT NULL,
      repository_selection text NOT NULL,
      status text NOT NULL DEFAULT 'active',
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS user_installations (
      user_id bigint NOT NULL REFERENCES github_users(id) ON DELETE CASCADE,
      installation_id bigint NOT NULL REFERENCES github_installations(id) ON DELETE CASCADE,
      role text NOT NULL DEFAULT 'owner',
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(user_id, installation_id)
    );
    CREATE TABLE IF NOT EXISTS installation_repositories (
      installation_id bigint NOT NULL REFERENCES github_installations(id) ON DELETE CASCADE,
      repository_id bigint NOT NULL,
      owner text NOT NULL,
      repo text NOT NULL,
      full_name text NOT NULL,
      private boolean NOT NULL DEFAULT false,
      active boolean NOT NULL DEFAULT true,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(installation_id, repository_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS installation_repositories_name_idx
      ON installation_repositories(installation_id, lower(owner), lower(repo));
    CREATE TABLE IF NOT EXISTS github_webhook_deliveries (
      delivery_id text PRIMARY KEY,
      event text NOT NULL,
      installation_id bigint,
      received_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS github_webhook_deliveries_received_idx
      ON github_webhook_deliveries(received_at);
    CREATE TABLE IF NOT EXISTS job_events (
      id bigserial PRIMARY KEY,
      job_id uuid NOT NULL REFERENCES validation_jobs(id) ON DELETE CASCADE,
      stage text NOT NULL,
      state text NOT NULL,
      message text NOT NULL,
      details jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS job_events_job_idx ON job_events(job_id, id);
  `);
}

export async function upsertGitHubUser(user: { id: number; login: string; avatarUrl?: string; accessTokenCiphertext?: string }): Promise<void> {
  await pool.query(
    `INSERT INTO github_users(id,login,avatar_url,access_token_ciphertext) VALUES($1,$2,$3,$4)
     ON CONFLICT(id) DO UPDATE SET login=EXCLUDED.login,avatar_url=EXCLUDED.avatar_url,
       access_token_ciphertext=COALESCE(EXCLUDED.access_token_ciphertext,github_users.access_token_ciphertext),updated_at=now()`,
    [user.id, user.login, user.avatarUrl ?? null, user.accessTokenCiphertext ?? null]
  );
}

export async function getGitHubUserCredential(userId: number): Promise<string | undefined> {
  const { rows } = await pool.query(`SELECT access_token_ciphertext FROM github_users WHERE id=$1`, [userId]);
  return rows[0]?.access_token_ciphertext ? String(rows[0].access_token_ciphertext) : undefined;
}

export async function upsertGitHubInstallation(installation: GitHubAccountInstallation): Promise<void> {
  await pool.query(
    `INSERT INTO github_installations(id,account_id,account_login,account_type,repository_selection,status)
     VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT(id) DO UPDATE SET account_id=EXCLUDED.account_id,account_login=EXCLUDED.account_login,
       account_type=EXCLUDED.account_type,repository_selection=EXCLUDED.repository_selection,status=EXCLUDED.status,updated_at=now()`,
    [installation.id, installation.accountId, installation.accountLogin, installation.accountType, installation.repositorySelection, installation.status ?? "active"]
  );
}

export async function setGitHubInstallationStatus(id: number, status: "active" | "suspended" | "deleted"): Promise<void> {
  await pool.query(`UPDATE github_installations SET status=$2,updated_at=now() WHERE id=$1`, [id, status]);
  if (status !== "active") {
    await pool.query(`UPDATE installation_repositories SET active=false,updated_at=now() WHERE installation_id=$1`, [id]);
    await pool.query(`UPDATE validation_jobs SET status='cancelled',updated_at=now() WHERE installation_id=$1 AND status IN ('queued','running')`, [id]);
  }
}

export async function linkUserInstallation(userId: number, installationId: number): Promise<void> {
  await pool.query(
    `INSERT INTO user_installations(user_id,installation_id) VALUES($1,$2)
     ON CONFLICT(user_id,installation_id) DO NOTHING`,
    [userId, installationId]
  );
}

export async function replaceInstallationRepositories(installationId: number, repositories: GitHubRepositoryAccess[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE installation_repositories SET active=false,updated_at=now() WHERE installation_id=$1`, [installationId]);
    for (const repository of repositories) {
      await client.query(
        `INSERT INTO installation_repositories(installation_id,repository_id,owner,repo,full_name,private,active)
         VALUES($1,$2,$3,$4,$5,$6,true)
         ON CONFLICT(installation_id,repository_id) DO UPDATE SET owner=EXCLUDED.owner,repo=EXCLUDED.repo,
           full_name=EXCLUDED.full_name,private=EXCLUDED.private,active=true,updated_at=now()`,
        [installationId, repository.id, repository.owner, repository.repo, repository.fullName, repository.private]
      );
    }
    await client.query(
      `UPDATE validation_jobs j SET status='cancelled',updated_at=now()
       WHERE j.installation_id=$1 AND j.status IN ('queued','running') AND NOT EXISTS(
         SELECT 1 FROM installation_repositories r WHERE r.installation_id=$1 AND r.active
           AND lower(r.owner)=lower(j.owner) AND lower(r.repo)=lower(j.repo)
       )`,
      [installationId]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function updateInstallationRepositories(installationId: number, added: GitHubRepositoryAccess[], removedIds: number[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const repository of added) {
      await client.query(
        `INSERT INTO installation_repositories(installation_id,repository_id,owner,repo,full_name,private,active)
         VALUES($1,$2,$3,$4,$5,$6,true)
         ON CONFLICT(installation_id,repository_id) DO UPDATE SET owner=EXCLUDED.owner,repo=EXCLUDED.repo,
           full_name=EXCLUDED.full_name,private=EXCLUDED.private,active=true,updated_at=now()`,
        [installationId, repository.id, repository.owner, repository.repo, repository.fullName, repository.private]
      );
    }
    if (removedIds.length) {
      await client.query(
        `UPDATE installation_repositories SET active=false,updated_at=now()
         WHERE installation_id=$1 AND repository_id=ANY($2::bigint[])`,
        [installationId, removedIds]
      );
      await client.query(
        `UPDATE validation_jobs j SET status='cancelled',updated_at=now()
         WHERE j.installation_id=$1 AND j.status IN ('queued','running') AND EXISTS(
           SELECT 1 FROM installation_repositories r WHERE r.installation_id=$1 AND r.repository_id=ANY($2::bigint[])
             AND lower(r.owner)=lower(j.owner) AND lower(r.repo)=lower(j.repo)
         )`,
        [installationId, removedIds]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function recordWebhookDelivery(deliveryId: string, event: string, installationId?: number): Promise<boolean> {
  const result = await pool.query(
    `INSERT INTO github_webhook_deliveries(delivery_id,event,installation_id) VALUES($1,$2,$3)
     ON CONFLICT(delivery_id) DO NOTHING`,
    [deliveryId, event, installationId ?? null]
  );
  void pool.query(`DELETE FROM github_webhook_deliveries WHERE received_at < now() - interval '30 days'`).catch(() => undefined);
  return result.rowCount === 1;
}

export async function forgetWebhookDelivery(deliveryId: string): Promise<void> {
  await pool.query(`DELETE FROM github_webhook_deliveries WHERE delivery_id=$1`, [deliveryId]);
}

export async function listInstallationsForUser(userId: number): Promise<unknown[]> {
  const { rows } = await pool.query(
    `SELECT i.id,i.account_login AS "accountLogin",i.account_type AS "accountType",
       i.repository_selection AS "repositorySelection",i.status,i.updated_at AS "updatedAt",
       count(r.repository_id) FILTER (WHERE r.active) AS "repositoryCount"
     FROM github_installations i
     JOIN user_installations u ON u.installation_id=i.id
     LEFT JOIN installation_repositories r ON r.installation_id=i.id
     WHERE u.user_id=$1
     GROUP BY i.id ORDER BY i.account_login`,
    [userId]
  );
  return rows.map((row) => ({ ...row, repositoryCount: Number(row.repositoryCount) }));
}

export async function listRepositoriesForUser(userId: number): Promise<unknown[]> {
  const { rows } = await pool.query(
    `SELECT r.installation_id AS "installationId",r.repository_id AS "repositoryId",r.owner,r.repo,r.full_name AS "fullName",r.private
     FROM installation_repositories r JOIN user_installations u ON u.installation_id=r.installation_id
     JOIN github_installations i ON i.id=r.installation_id
     WHERE u.user_id=$1 AND r.active AND i.status='active' ORDER BY lower(r.full_name)`,
    [userId]
  );
  return rows;
}

export async function saveJob(job: ValidationJob): Promise<boolean> {
  const result = await pool.query(
    `INSERT INTO validation_jobs(id, installation_id, owner, repo, pr_number, head_sha, base_sha, check_run_id, trigger, engine_version)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
    [job.id, job.installationId, job.owner, job.repo, job.prNumber, job.headSha, job.baseSha, job.checkRunId ?? null, job.trigger ?? null, job.engineVersion ?? "0.1.0"]
  );
  return result.rowCount === 1;
}

export async function saveActionResults(repository: string, published: PublishedActionResult[]): Promise<Array<{ id: string; externalId: string }>> {
  const separator = repository.indexOf("/");
  const owner = repository.slice(0, separator);
  const repo = repository.slice(separator + 1);
  const installation = await pool.query(
    `SELECT installation_id FROM installation_repositories
     WHERE lower(owner)=lower($1) AND lower(repo)=lower($2) AND active ORDER BY updated_at DESC LIMIT 1`,
    [owner, repo]
  );
  const installationId = installation.rows[0] ? Number(installation.rows[0].installation_id) : 0;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const saved: Array<{ id: string; externalId: string }> = [];
    for (const item of published) {
      const result = item.result;
      const id = randomUUID();
      const query = await client.query(
        `INSERT INTO validation_jobs(
           id, installation_id, owner, repo, pr_number, head_sha, base_sha,
           status, result, source, external_id, engine_version
         ) VALUES($1,$10,$2,$3,$4,$5,$6,$7,$8,'github_action',$9,$11)
         ON CONFLICT (owner, repo, pr_number, head_sha, base_sha) DO UPDATE SET
           status=EXCLUDED.status, result=EXCLUDED.result, error=NULL,
           source='github_action', external_id=EXCLUDED.external_id, updated_at=now()
         RETURNING id`,
        [id, owner, repo, result.currentPr, result.headSha, result.baseSha, result.status, JSON.stringify(result), item.externalId, installationId, result.provenance?.engineVersion ?? "0.1.0"]
      );
      saved.push({ id: String(query.rows[0].id), externalId: item.externalId });
    }
    await client.query("COMMIT");
    return saved;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
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
            status, result, error, source, external_id AS "externalId",
            created_at AS "createdAt", updated_at AS "updatedAt"
     FROM validation_jobs ORDER BY created_at DESC LIMIT $1`, [Math.min(limit, 200)]
  );
  return rows;
}

export async function listJobsForUser(userId: number, limit = 50): Promise<unknown[]> {
  const { rows } = await pool.query(
    `SELECT j.id,j.owner,j.repo,j.pr_number AS "prNumber",j.head_sha AS "headSha",j.base_sha AS "baseSha",
            j.status,j.result,j.error,j.source,j.external_id AS "externalId",
            j.created_at AS "createdAt",j.updated_at AS "updatedAt"
     FROM validation_jobs j
     WHERE EXISTS(
       SELECT 1 FROM user_installations u
       JOIN github_installations i ON i.id=u.installation_id AND i.status='active'
       JOIN installation_repositories r ON r.installation_id=i.id AND r.active
       WHERE u.user_id=$1 AND u.installation_id=j.installation_id
         AND lower(r.owner)=lower(j.owner) AND lower(r.repo)=lower(j.repo)
     )
     ORDER BY j.created_at DESC LIMIT $2`,
    [userId, Math.min(limit, 200)]
  );
  return rows;
}

export async function listRepositoryJobs(owner: string, repo: string, limit = 200): Promise<unknown[]> {
  const { rows } = await pool.query(
    `SELECT id,owner,repo,pr_number AS "prNumber",head_sha AS "headSha",base_sha AS "baseSha",
            status,result,error,source,external_id AS "externalId",created_at AS "createdAt",updated_at AS "updatedAt"
     FROM validation_jobs WHERE lower(owner)=lower($1) AND lower(repo)=lower($2)
     ORDER BY created_at DESC LIMIT $3`,
    [owner, repo, Math.min(Math.max(limit, 1), 500)]
  );
  return rows;
}

export async function listRepositoryJobsForUser(userId: number, owner: string, repo: string, limit = 200): Promise<unknown[]> {
  const { rows } = await pool.query(
    `SELECT j.id,j.owner,j.repo,j.pr_number AS "prNumber",j.head_sha AS "headSha",j.base_sha AS "baseSha",
            j.status,j.result,j.error,j.source,j.external_id AS "externalId",j.created_at AS "createdAt",j.updated_at AS "updatedAt"
     FROM validation_jobs j WHERE lower(j.owner)=lower($2) AND lower(j.repo)=lower($3) AND EXISTS(
       SELECT 1 FROM user_installations u
       JOIN github_installations i ON i.id=u.installation_id AND i.status='active'
       JOIN installation_repositories r ON r.installation_id=i.id AND r.active
       WHERE u.user_id=$1 AND u.installation_id=j.installation_id
         AND lower(r.owner)=lower(j.owner) AND lower(r.repo)=lower(j.repo)
     ) ORDER BY j.created_at DESC LIMIT $4`,
    [userId, owner, repo, Math.min(Math.max(limit, 1), 500)]
  );
  return rows;
}

export async function validationJobStatusCounts(): Promise<Array<{ status: string; count: string }>> {
  const { rows } = await pool.query<{ status: string; count: string }>("SELECT status,count(*)::text count FROM validation_jobs GROUP BY status ORDER BY status");
  return rows;
}

export async function databaseReady(): Promise<boolean> {
  try { await pool.query("SELECT 1"); return true; }
  catch { return false; }
}

export async function appendJobEvent(jobId: string, stage: string, state: string, message: string, details?: Record<string, unknown>): Promise<void> {
  await pool.query("INSERT INTO job_events(job_id,stage,state,message,details) VALUES($1,$2,$3,$4,$5)", [jobId, stage, state, message, details ? JSON.stringify(details) : null]);
}

export async function listJobEvents(jobId: string, after = 0, limit = 200): Promise<Array<{ id: number; jobId: string; stage: string; state: string; message: string; details?: Record<string, unknown>; createdAt: string }>> {
  const { rows } = await pool.query(
    `SELECT id,job_id AS "jobId",stage,state,message,details,created_at AS "createdAt"
     FROM job_events WHERE job_id=$1 AND id>$2 ORDER BY id LIMIT $3`,
    [jobId, Math.max(0, after), Math.min(Math.max(limit, 1), 500)]
  );
  return rows.map((row) => ({ ...row, id: Number(row.id) }));
}

export async function getJob(id: string): Promise<unknown | null> {
  const { rows } = await pool.query(`SELECT * FROM validation_jobs WHERE id=$1`, [id]);
  return rows[0] ?? null;
}

export async function getJobForUser(id: string, userId: number): Promise<unknown | null> {
  const { rows } = await pool.query(
    `SELECT j.* FROM validation_jobs j
     WHERE j.id=$1 AND EXISTS(
       SELECT 1 FROM user_installations u
       JOIN github_installations i ON i.id=u.installation_id AND i.status='active'
       JOIN installation_repositories r ON r.installation_id=i.id AND r.active
       WHERE u.user_id=$2 AND u.installation_id=j.installation_id
         AND lower(r.owner)=lower(j.owner) AND lower(r.repo)=lower(j.repo)
     )`,
    [id, userId]
  );
  return rows[0] ?? null;
}

export async function loadJob(id: string): Promise<ValidationJob | null> {
  const { rows } = await pool.query(`SELECT id, installation_id, owner, repo, pr_number, head_sha, base_sha, check_run_id, trigger, engine_version FROM validation_jobs WHERE id=$1`, [id]);
  const row=rows[0] as Record<string,unknown>|undefined; if(!row)return null;
  return {id:String(row.id),installationId:Number(row.installation_id),owner:String(row.owner),repo:String(row.repo),prNumber:Number(row.pr_number),headSha:String(row.head_sha),baseSha:String(row.base_sha),engineVersion:String(row.engine_version??"0.1.0"),...(row.check_run_id?{checkRunId:Number(row.check_run_id)}:{}),...(row.trigger?{trigger:String(row.trigger) as NonNullable<ValidationJob["trigger"]>}:{})};
}
