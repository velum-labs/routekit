CREATE TABLE IF NOT EXISTS experiment_runs (
  experiment_id text PRIMARY KEY,
  manifest_hash text NOT NULL,
  status text NOT NULL,
  manifest jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  provider_maximum_usd numeric(18, 8) NOT NULL,
  infrastructure_maximum_usd numeric(18, 8) NOT NULL,
  provider_reserved_usd numeric(18, 8) NOT NULL DEFAULT 0,
  provider_spent_usd numeric(18, 8) NOT NULL DEFAULT 0,
  infrastructure_reserved_usd numeric(18, 8) NOT NULL DEFAULT 0,
  infrastructure_spent_usd numeric(18, 8) NOT NULL DEFAULT 0,
  metrics_artifact jsonb,
  report_artifact jsonb,
  error text,
  CONSTRAINT experiment_status_valid CHECK (
    status IN (
      'awaiting_approval',
      'queued',
      'running',
      'aggregating',
      'completed',
      'failed',
      'cancelled',
      'invalidated',
      'superseded'
    )
  )
);

ALTER TABLE experiment_runs
  ADD COLUMN IF NOT EXISTS metrics_artifact jsonb;

CREATE TABLE IF NOT EXISTS experiment_jobs (
  job_id text PRIMARY KEY,
  experiment_id text NOT NULL REFERENCES experiment_runs(experiment_id) ON DELETE CASCADE,
  idempotency_key text NOT NULL UNIQUE,
  job jsonb NOT NULL,
  status text NOT NULL,
  retryable boolean NOT NULL DEFAULT true,
  attempt_count integer NOT NULL DEFAULT 0,
  worker_id text,
  lease_expires_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  output_artifact jsonb,
  log_artifact jsonb,
  provider_cost_usd numeric(18, 8) NOT NULL DEFAULT 0,
  infrastructure_cost_usd numeric(18, 8) NOT NULL DEFAULT 0,
  latency_ms integer,
  error text,
  CONSTRAINT experiment_job_status_valid CHECK (
    status IN ('pending', 'queued', 'running', 'succeeded', 'failed', 'cancelled')
  )
);

ALTER TABLE experiment_jobs
  ADD COLUMN IF NOT EXISTS retryable boolean NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS experiment_jobs_run_status
  ON experiment_jobs(experiment_id, status);

CREATE INDEX IF NOT EXISTS experiment_jobs_lease
  ON experiment_jobs(status, lease_expires_at)
  WHERE status = 'running';

CREATE TABLE IF NOT EXISTS experiment_job_attempts (
  job_id text NOT NULL REFERENCES experiment_jobs(job_id) ON DELETE CASCADE,
  attempt_number integer NOT NULL,
  worker_id text NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  status text NOT NULL,
  error text,
  PRIMARY KEY (job_id, attempt_number)
);

CREATE TABLE IF NOT EXISTS experiment_budget_reservations (
  job_id text PRIMARY KEY REFERENCES experiment_jobs(job_id) ON DELETE CASCADE,
  experiment_id text NOT NULL REFERENCES experiment_runs(experiment_id) ON DELETE CASCADE,
  provider_usd numeric(18, 8) NOT NULL,
  infrastructure_usd numeric(18, 8) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS experiment_approvals (
  experiment_id text NOT NULL REFERENCES experiment_runs(experiment_id) ON DELETE CASCADE,
  stage text NOT NULL,
  actor text NOT NULL,
  approved_at timestamptz NOT NULL,
  PRIMARY KEY (experiment_id, stage),
  CONSTRAINT experiment_approval_stage_valid CHECK (
    stage IN ('paid_execution', 'confirmation', 'locked_test')
  )
);

CREATE TABLE IF NOT EXISTS experiment_workflow_runs (
  workflow_run_id text PRIMARY KEY,
  experiment_id text NOT NULL REFERENCES experiment_runs(experiment_id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS experiment_workflow_runs_experiment
  ON experiment_workflow_runs(experiment_id);
