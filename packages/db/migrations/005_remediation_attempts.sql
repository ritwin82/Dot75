CREATE TABLE IF NOT EXISTS remediation_attempts (
  id uuid PRIMARY KEY,
  validation_job_id uuid NOT NULL REFERENCES validation_jobs(id) ON DELETE CASCADE,
  actor text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  result jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS remediation_attempts_job_idx ON remediation_attempts(validation_job_id, created_at DESC);
