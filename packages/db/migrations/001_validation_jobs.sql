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
