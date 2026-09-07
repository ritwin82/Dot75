ALTER TABLE validation_jobs ADD COLUMN IF NOT EXISTS engine_version text NOT NULL DEFAULT '0.1.0';
DROP INDEX IF EXISTS validation_jobs_dedupe_idx;
CREATE UNIQUE INDEX IF NOT EXISTS validation_jobs_dedupe_v2_idx
  ON validation_jobs(owner, repo, pr_number, head_sha, base_sha, engine_version);
