import { Client, type QueryResultRow } from "@neondatabase/serverless";
import type {
  ArtifactReference,
  ExperimentApproval,
  ExperimentApprovalStage,
  ExperimentJob,
  ExperimentJobRecord,
  ExperimentManifest,
  ExperimentRecord,
  ExperimentSnapshot,
  ExperimentStatus,
  FrozenExperimentPlan
} from "@velum-labs/routekit-eval-contracts";
import { requiredExperimentApprovalStages } from "@velum-labs/routekit-eval-core/experiment";
import type {
  CompleteExperimentJobInput,
  ExperimentLedger,
  FailExperimentJobInput
} from "@velum-labs/routekit-eval-store/platform";
import { EXPERIMENT_JOB_MAXIMUM_ATTEMPTS } from "@velum-labs/routekit-eval-store/platform";

import { EXPERIMENT_SCHEMA_SQL } from "./schema";

function number(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value);
  return 0;
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function optionalIso(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : iso(value);
}

function json<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

function optionalJson<T>(value: unknown): T | undefined {
  return value === null || value === undefined ? undefined : json<T>(value);
}

function experimentFromRow(row: QueryResultRow): ExperimentRecord {
  return {
    experimentId: String(row.experiment_id),
    manifestHash: String(row.manifest_hash),
    status: String(row.status) as ExperimentStatus,
    manifest: json<ExperimentManifest>(row.manifest),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    providerReservedUsd: number(row.provider_reserved_usd),
    providerSpentUsd: number(row.provider_spent_usd),
    infrastructureReservedUsd: number(row.infrastructure_reserved_usd),
    infrastructureSpentUsd: number(row.infrastructure_spent_usd),
    metricsArtifact: optionalJson<ArtifactReference>(row.metrics_artifact),
    reportArtifact: optionalJson<ArtifactReference>(row.report_artifact),
    error: row.error === null || row.error === undefined ? undefined : String(row.error)
  };
}

function jobFromRow(row: QueryResultRow): ExperimentJobRecord {
  return {
    job: json<ExperimentJob>(row.job),
    status: String(row.status) as ExperimentJobRecord["status"],
    retryable:
      row.retryable === undefined || row.retryable === null
        ? true
        : row.retryable === true || row.retryable === "true",
    attemptCount: number(row.attempt_count),
    workerId:
      row.worker_id === null || row.worker_id === undefined ? undefined : String(row.worker_id),
    leaseExpiresAt: optionalIso(row.lease_expires_at),
    startedAt: optionalIso(row.started_at),
    finishedAt: optionalIso(row.finished_at),
    outputArtifact: optionalJson<ArtifactReference>(row.output_artifact),
    logArtifact: optionalJson<ArtifactReference>(row.log_artifact),
    providerCostUsd: number(row.provider_cost_usd),
    infrastructureCostUsd: number(row.infrastructure_cost_usd),
    latencyMs:
      row.latency_ms === null || row.latency_ms === undefined ? undefined : number(row.latency_ms),
    error: row.error === null || row.error === undefined ? undefined : String(row.error)
  };
}

function approvalFromRow(row: QueryResultRow): ExperimentApproval {
  return {
    experimentId: String(row.experiment_id),
    stage: String(row.stage) as ExperimentApprovalStage,
    actor: String(row.actor),
    approvedAt: iso(row.approved_at)
  };
}

function transitionAllowed(from: ExperimentStatus, to: ExperimentStatus): boolean {
  if (from === to) return true;
  if (to === "cancelled" || to === "invalidated" || to === "superseded") {
    return !["cancelled", "invalidated", "superseded"].includes(from);
  }
  const transitions: Readonly<Record<ExperimentStatus, readonly ExperimentStatus[]>> = {
    awaiting_approval: ["queued", "failed"],
    queued: ["running", "failed"],
    running: ["aggregating", "completed", "failed"],
    aggregating: ["completed", "failed"],
    completed: [],
    failed: ["queued"],
    cancelled: [],
    invalidated: [],
    superseded: []
  };
  return transitions[from].includes(to);
}

export class NeonExperimentLedger implements ExperimentLedger {
  constructor(readonly connectionString: string) {}

  async #withClient<T>(operation: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({ connectionString: this.connectionString });
    await client.connect();
    try {
      return await operation(client);
    } finally {
      await client.end();
    }
  }

  async #transaction<T>(operation: (client: Client) => Promise<T>): Promise<T> {
    return this.#withClient(async (client) => {
      await client.query("BEGIN");
      try {
        const result = await operation(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    });
  }

  async initialize(): Promise<void> {
    await this.#withClient(async (client) => {
      await client.query(EXPERIMENT_SCHEMA_SQL);
    });
  }

  async createExperiment(plan: FrozenExperimentPlan): Promise<ExperimentSnapshot> {
    await this.#transaction(async (client) => {
      const existing = await client.query(
        "SELECT manifest_hash FROM experiment_runs WHERE experiment_id = $1 FOR UPDATE",
        [plan.manifest.experimentId]
      );
      if (existing.rows[0] !== undefined) {
        if (String(existing.rows[0].manifest_hash) !== plan.manifestHash) {
          throw new Error(
            `experiment ${plan.manifest.experimentId} already exists with a different manifest`
          );
        }
        return;
      }
      const status =
        requiredExperimentApprovalStages(plan).length > 0 ? "awaiting_approval" : "queued";
      await client.query(
        `INSERT INTO experiment_runs (
          experiment_id, manifest_hash, status, manifest, created_at, updated_at,
          provider_maximum_usd, infrastructure_maximum_usd
        ) VALUES ($1, $2, $3, $4::jsonb, $5, $5, $6, $7)`,
        [
          plan.manifest.experimentId,
          plan.manifestHash,
          status,
          JSON.stringify(plan.manifest),
          plan.createdAt,
          plan.manifest.budget.providerMaximumUsd,
          plan.manifest.budget.vercelMaximumUsd
        ]
      );
      for (let offset = 0; offset < plan.jobs.length; offset += 100) {
        const jobs = plan.jobs.slice(offset, offset + 100);
        const values: unknown[] = [];
        const placeholders = jobs.map((job, index) => {
          const base = index * 4;
          values.push(job.id, job.experimentId, job.idempotencyKey, JSON.stringify(job));
          return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}::jsonb, 'pending')`;
        });
        await client.query(
          `INSERT INTO experiment_jobs (
            job_id, experiment_id, idempotency_key, job, status
          ) VALUES ${placeholders.join(", ")}`,
          values
        );
      }
    });
    const snapshot = await this.getExperiment(plan.manifest.experimentId);
    if (snapshot === undefined) throw new Error("created experiment could not be read back");
    return snapshot;
  }

  async listExperiments(): Promise<ExperimentRecord[]> {
    return this.#withClient(async (client) => {
      const result = await client.query("SELECT * FROM experiment_runs ORDER BY created_at DESC");
      return result.rows.map(experimentFromRow);
    });
  }

  async getExperiment(experimentId: string): Promise<ExperimentSnapshot | undefined> {
    return this.#withClient(async (client) => {
      const [experiments, jobs, approvals] = await Promise.all([
        client.query("SELECT * FROM experiment_runs WHERE experiment_id = $1", [experimentId]),
        client.query("SELECT * FROM experiment_jobs WHERE experiment_id = $1 ORDER BY job_id", [
          experimentId
        ]),
        client.query(
          "SELECT * FROM experiment_approvals WHERE experiment_id = $1 ORDER BY approved_at",
          [experimentId]
        )
      ]);
      const experiment = experiments.rows[0];
      if (experiment === undefined) return undefined;
      return {
        experiment: experimentFromRow(experiment),
        jobs: jobs.rows.map(jobFromRow),
        approvals: approvals.rows.map(approvalFromRow)
      };
    });
  }

  async getJob(jobId: string): Promise<ExperimentJobRecord | undefined> {
    return this.#withClient(async (client) => {
      const result = await client.query("SELECT * FROM experiment_jobs WHERE job_id = $1", [jobId]);
      return result.rows[0] === undefined ? undefined : jobFromRow(result.rows[0]);
    });
  }

  async approve(
    experimentId: string,
    stage: ExperimentApprovalStage,
    actor: string
  ): Promise<ExperimentApproval> {
    return this.#transaction(async (client) => {
      const result = await client.query(
        "SELECT * FROM experiment_runs WHERE experiment_id = $1 FOR UPDATE",
        [experimentId]
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error(`unknown experiment ${experimentId}`);
      const experiment = experimentFromRow(row);
      if (stage === "locked_test" && experiment.manifest.dataset.role !== "locked_test") {
        throw new Error("locked-test approval is only valid for a locked-test experiment");
      }
      const inserted = await client.query(
        `INSERT INTO experiment_approvals (experiment_id, stage, actor, approved_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (experiment_id, stage) DO UPDATE SET actor = experiment_approvals.actor
         RETURNING *`,
        [experimentId, stage, actor]
      );
      const [jobRows, approvalRows] = await Promise.all([
        client.query("SELECT job FROM experiment_jobs WHERE experiment_id = $1", [experimentId]),
        client.query("SELECT stage FROM experiment_approvals WHERE experiment_id = $1", [
          experimentId
        ])
      ]);
      const required = requiredExperimentApprovalStages({
        manifest: experiment.manifest,
        jobs: jobRows.rows.map((jobRow) => jobRow.job as ExperimentJob)
      });
      const approved = new Set(
        approvalRows.rows.map((approvalRow) => String(approvalRow.stage) as ExperimentApprovalStage)
      );
      if (
        experiment.status === "awaiting_approval" &&
        required.every((requiredStage) => approved.has(requiredStage))
      ) {
        await client.query(
          "UPDATE experiment_runs SET status = 'queued', updated_at = now() WHERE experiment_id = $1",
          [experimentId]
        );
      }
      return approvalFromRow(inserted.rows[0]!);
    });
  }

  async setExperimentStatus(
    experimentId: string,
    status: ExperimentStatus,
    error?: string
  ): Promise<void> {
    await this.#transaction(async (client) => {
      const result = await client.query(
        "SELECT status FROM experiment_runs WHERE experiment_id = $1 FOR UPDATE",
        [experimentId]
      );
      const current = result.rows[0];
      if (current === undefined) throw new Error(`unknown experiment ${experimentId}`);
      const from = String(current.status) as ExperimentStatus;
      if (!transitionAllowed(from, status)) {
        throw new Error(`cannot transition experiment ${experimentId} from ${from} to ${status}`);
      }
      await client.query(
        "UPDATE experiment_runs SET status = $2, error = $3, updated_at = now() WHERE experiment_id = $1",
        [experimentId, status, error ?? null]
      );
    });
  }

  async queuePendingJobs(experimentId: string): Promise<ExperimentJobRecord[]> {
    return this.#transaction(async (client) => {
      const experiment = await client.query(
        "SELECT status FROM experiment_runs WHERE experiment_id = $1 FOR UPDATE",
        [experimentId]
      );
      const row = experiment.rows[0];
      if (row === undefined) throw new Error(`unknown experiment ${experimentId}`);
      if (!["queued", "running"].includes(String(row.status))) {
        throw new Error(`experiment ${experimentId} cannot queue jobs while ${String(row.status)}`);
      }
      const result = await client.query(
        `UPDATE experiment_jobs
         SET status = 'queued', error = NULL
         WHERE experiment_id = $1
           AND (
             status = 'pending'
             OR (
               status = 'failed'
               AND retryable
               AND attempt_count < ${EXPERIMENT_JOB_MAXIMUM_ATTEMPTS}
             )
           )
         RETURNING *`,
        [experimentId]
      );
      await client.query("UPDATE experiment_runs SET updated_at = now() WHERE experiment_id = $1", [
        experimentId
      ]);
      return result.rows.map(jobFromRow);
    });
  }

  async claimJob(
    jobId: string,
    workerId: string,
    leaseMilliseconds: number,
    maximumAttempts = EXPERIMENT_JOB_MAXIMUM_ATTEMPTS
  ): Promise<ExperimentJobRecord | undefined> {
    return this.#transaction(async (client) => {
      const jobs = await client.query(
        "SELECT * FROM experiment_jobs WHERE job_id = $1 FOR UPDATE",
        [jobId]
      );
      const row = jobs.rows[0];
      if (row === undefined) throw new Error(`unknown experiment job ${jobId}`);
      const record = jobFromRow(row);
      const runs = await client.query(
        "SELECT * FROM experiment_runs WHERE experiment_id = $1 FOR UPDATE",
        [record.job.experimentId]
      );
      const runRow = runs.rows[0]!;
      const experiment = experimentFromRow(runRow);
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [record.job.experimentId]);
      if (!["queued", "running"].includes(experiment.status)) return undefined;
      if (record.status === "succeeded" || record.status === "cancelled") return undefined;
      if (
        record.status !== "queued" &&
        record.status !== "running" &&
        !(record.status === "failed" && record.retryable)
      ) {
        return undefined;
      }
      if (
        record.status === "running" &&
        record.leaseExpiresAt !== undefined &&
        new Date(record.leaseExpiresAt).getTime() > Date.now()
      ) {
        return undefined;
      }
      if (record.status === "running" && !record.retryable) {
        const error =
          "worker lease expired after a paid request was dispatched; automatic retry disabled";
        await client.query(
          `UPDATE experiment_job_attempts
           SET status = 'failed',
               finished_at = now(),
               error = $4
           WHERE job_id = $1
             AND attempt_number = $2
             AND worker_id = $3
             AND status = 'running'`,
          [jobId, record.attemptCount, record.workerId, error]
        );
        const costs = {
          providerCostUsd: record.job.estimatedProviderCostUsd,
          infrastructureCostUsd: record.job.estimatedInfrastructureCostUsd
        };
        await this.#settleReservation(client, record, costs);
        await client.query(
          `UPDATE experiment_jobs SET
             status = 'failed',
             provider_cost_usd = provider_cost_usd + $2,
             infrastructure_cost_usd = infrastructure_cost_usd + $3,
             finished_at = now(),
             lease_expires_at = NULL,
             error = $4
           WHERE job_id = $1`,
          [jobId, costs.providerCostUsd, costs.infrastructureCostUsd, error]
        );
        return undefined;
      }
      if (record.attemptCount >= maximumAttempts) return undefined;
      if (record.status === "running") {
        await client.query(
          `UPDATE experiment_job_attempts
           SET status = 'failed',
               finished_at = now(),
               error = $4
           WHERE job_id = $1
             AND attempt_number = $2
             AND worker_id = $3
             AND status = 'running'`,
          [
            jobId,
            record.attemptCount,
            record.workerId,
            `worker lease expired; job reclaimed by ${workerId}`
          ]
        );
      }
      if (record.job.executor === "hosted-model" || record.job.executor === "sandbox") {
        const maximum =
          record.job.executor === "hosted-model"
            ? experiment.manifest.schedule.maximumHostedCallsInFlight
            : experiment.manifest.schedule.maximumSandboxes;
        const active = await client.query(
          `SELECT count(*)::integer AS count
           FROM experiment_jobs
           WHERE experiment_id = $1
             AND status = 'running'
             AND job_id <> $2
             AND (job->>'executor') = $3
             AND (lease_expires_at IS NULL OR lease_expires_at > now())`,
          [record.job.experimentId, jobId, record.job.executor]
        );
        if (number(active.rows[0]?.count) >= maximum) return undefined;
      }

      const reservations = await client.query(
        "SELECT * FROM experiment_budget_reservations WHERE job_id = $1 FOR UPDATE",
        [jobId]
      );
      if (reservations.rows[0] === undefined) {
        const provider = record.job.estimatedProviderCostUsd;
        const infrastructure = record.job.estimatedInfrastructureCostUsd;
        if (
          experiment.providerReservedUsd + experiment.providerSpentUsd + provider >
          experiment.manifest.budget.providerMaximumUsd + Number.EPSILON
        ) {
          await client.query(
            `UPDATE experiment_jobs SET
               status = 'failed',
               attempt_count = $2,
               finished_at = now(),
               lease_expires_at = NULL,
               error = $3
             WHERE job_id = $1`,
            [
              jobId,
              maximumAttempts,
              `provider budget exceeded for experiment ${record.job.experimentId}`
            ]
          );
          return undefined;
        }
        if (
          experiment.infrastructureReservedUsd +
            experiment.infrastructureSpentUsd +
            infrastructure >
          experiment.manifest.budget.vercelMaximumUsd + Number.EPSILON
        ) {
          await client.query(
            `UPDATE experiment_jobs SET
               status = 'failed',
               attempt_count = $2,
               finished_at = now(),
               lease_expires_at = NULL,
               error = $3
             WHERE job_id = $1`,
            [
              jobId,
              maximumAttempts,
              `Vercel budget exceeded for experiment ${record.job.experimentId}`
            ]
          );
          return undefined;
        }
        await client.query(
          `INSERT INTO experiment_budget_reservations
            (job_id, experiment_id, provider_usd, infrastructure_usd)
           VALUES ($1, $2, $3, $4)`,
          [jobId, record.job.experimentId, provider, infrastructure]
        );
        await client.query(
          `UPDATE experiment_runs SET
             provider_reserved_usd = provider_reserved_usd + $2,
             infrastructure_reserved_usd = infrastructure_reserved_usd + $3
           WHERE experiment_id = $1`,
          [record.job.experimentId, provider, infrastructure]
        );
      }
      const leaseExpiresAt = new Date(Date.now() + leaseMilliseconds).toISOString();
      const claimed = await client.query(
        `UPDATE experiment_jobs SET
           status = 'running',
           worker_id = $2,
           attempt_count = attempt_count + 1,
           started_at = COALESCE(started_at, now()),
           finished_at = NULL,
           lease_expires_at = $3,
           error = NULL
         WHERE job_id = $1
         RETURNING *`,
        [jobId, workerId, leaseExpiresAt]
      );
      const claimedRecord = jobFromRow(claimed.rows[0]!);
      await client.query(
        `INSERT INTO experiment_job_attempts
          (job_id, attempt_number, worker_id, started_at, status)
         VALUES ($1, $2, $3, now(), 'running')`,
        [jobId, claimedRecord.attemptCount, workerId]
      );
      await client.query(
        `UPDATE experiment_runs SET
           status = CASE WHEN status = 'queued' THEN 'running' ELSE status END,
           updated_at = now()
         WHERE experiment_id = $1`,
        [record.job.experimentId]
      );
      return claimedRecord;
    });
  }

  async disableJobRetries(jobId: string, workerId: string): Promise<boolean> {
    return this.#transaction(async (client) => {
      const result = await client.query(
        `UPDATE experiment_jobs AS jobs
         SET retryable = false
         FROM experiment_runs AS runs
         WHERE jobs.job_id = $1
           AND jobs.worker_id = $2
           AND jobs.status = 'running'
           AND runs.experiment_id = jobs.experiment_id
           AND runs.status IN ('queued', 'running')
         RETURNING jobs.experiment_id`,
        [jobId, workerId]
      );
      const experimentId = result.rows[0]?.experiment_id;
      if (typeof experimentId !== "string") return false;
      await client.query(
        "UPDATE experiment_runs SET updated_at = now() WHERE experiment_id = $1",
        [experimentId]
      );
      return true;
    });
  }

  async completeJob(
    jobId: string,
    input: CompleteExperimentJobInput
  ): Promise<ExperimentJobRecord> {
    return this.#transaction(async (client) => {
      const current = await client.query(
        "SELECT * FROM experiment_jobs WHERE job_id = $1 FOR UPDATE",
        [jobId]
      );
      const row = current.rows[0];
      if (row === undefined) throw new Error(`unknown experiment job ${jobId}`);
      const record = jobFromRow(row);
      if (record.status === "succeeded") return record;
      if (record.status === "cancelled") return record;
      if (record.status !== "running" || record.workerId !== input.workerId) {
        throw new Error(`worker ${input.workerId} does not own running job ${jobId}`);
      }
      await this.#settleReservation(client, record, {
        providerCostUsd: input.providerCostUsd,
        infrastructureCostUsd: input.infrastructureCostUsd
      });
      const updated = await client.query(
        `UPDATE experiment_jobs SET
           status = 'succeeded',
           output_artifact = $2::jsonb,
           log_artifact = $3::jsonb,
           provider_cost_usd = provider_cost_usd + $4,
           infrastructure_cost_usd = infrastructure_cost_usd + $5,
           latency_ms = $6,
           finished_at = now(),
           lease_expires_at = NULL,
           error = NULL
         WHERE job_id = $1
         RETURNING *`,
        [
          jobId,
          JSON.stringify(input.outputArtifact),
          input.logArtifact === undefined ? null : JSON.stringify(input.logArtifact),
          input.providerCostUsd,
          input.infrastructureCostUsd,
          input.latencyMs
        ]
      );
      await client.query(
        `UPDATE experiment_job_attempts SET status = 'succeeded', finished_at = now()
         WHERE job_id = $1 AND attempt_number = $2 AND worker_id = $3 AND status = 'running'`,
        [jobId, record.attemptCount, input.workerId]
      );
      return jobFromRow(updated.rows[0]!);
    });
  }

  async heartbeatJob(jobId: string, workerId: string, leaseMilliseconds: number): Promise<boolean> {
    return this.#withClient(async (client) => {
      const result = await client.query(
        `UPDATE experiment_jobs SET lease_expires_at = $3
         WHERE job_id = $1 AND worker_id = $2 AND status = 'running'`,
        [jobId, workerId, new Date(Date.now() + leaseMilliseconds).toISOString()]
      );
      return result.rowCount === 1;
    });
  }

  async failJob(jobId: string, input: FailExperimentJobInput): Promise<ExperimentJobRecord> {
    return this.#transaction(async (client) => {
      const current = await client.query(
        "SELECT * FROM experiment_jobs WHERE job_id = $1 FOR UPDATE",
        [jobId]
      );
      const row = current.rows[0];
      if (row === undefined) throw new Error(`unknown experiment job ${jobId}`);
      const record = jobFromRow(row);
      if (
        record.status === "succeeded" ||
        record.status === "cancelled" ||
        record.status === "failed"
      ) {
        return record;
      }
      if (record.status !== "running" || record.workerId !== input.workerId) {
        throw new Error(`worker ${input.workerId} does not own running job ${jobId}`);
      }
      const costs = {
        providerCostUsd: input.providerCostUsd ?? 0,
        infrastructureCostUsd: input.infrastructureCostUsd ?? 0
      };
      await this.#settleReservation(client, record, costs);
      const updated = await client.query(
        `UPDATE experiment_jobs SET
           status = 'failed',
           retryable = CASE WHEN $5 THEN false ELSE retryable END,
           provider_cost_usd = provider_cost_usd + $2,
           infrastructure_cost_usd = infrastructure_cost_usd + $3,
           finished_at = now(),
           lease_expires_at = NULL,
           error = $4
         WHERE job_id = $1
         RETURNING *`,
        [
          jobId,
          costs.providerCostUsd,
          costs.infrastructureCostUsd,
          input.error,
          input.terminal === true
        ]
      );
      await client.query(
        `UPDATE experiment_job_attempts SET status = 'failed', finished_at = now(), error = $3
         WHERE job_id = $1
           AND attempt_number = $2
           AND worker_id = $4
           AND status = 'running'`,
        [jobId, record.attemptCount, input.error, input.workerId]
      );
      return jobFromRow(updated.rows[0]!);
    });
  }

  async #settleReservation(
    client: Client,
    record: ExperimentJobRecord,
    actual: { providerCostUsd: number; infrastructureCostUsd: number }
  ): Promise<void> {
    if (actual.providerCostUsd < 0 || actual.infrastructureCostUsd < 0) {
      throw new Error("actual job costs must be non-negative");
    }
    const runs = await client.query(
      "SELECT * FROM experiment_runs WHERE experiment_id = $1 FOR UPDATE",
      [record.job.experimentId]
    );
    const experiment = experimentFromRow(runs.rows[0]!);
    const reservations = await client.query(
      "DELETE FROM experiment_budget_reservations WHERE job_id = $1 RETURNING *",
      [record.job.id]
    );
    const reservation = reservations.rows[0];
    const providerReserved = number(reservation?.provider_usd);
    const infrastructureReserved = number(reservation?.infrastructure_usd);
    await client.query(
      `UPDATE experiment_runs SET
         provider_reserved_usd = GREATEST(0, provider_reserved_usd - $2),
         infrastructure_reserved_usd = GREATEST(0, infrastructure_reserved_usd - $3),
         provider_spent_usd = provider_spent_usd + $4,
         infrastructure_spent_usd = infrastructure_spent_usd + $5,
         updated_at = now()
       WHERE experiment_id = $1`,
      [
        record.job.experimentId,
        providerReserved,
        infrastructureReserved,
        actual.providerCostUsd,
        actual.infrastructureCostUsd
      ]
    );
  }

  async attachReport(experimentId: string, artifact: ArtifactReference): Promise<void> {
    await this.#withClient(async (client) => {
      const result = await client.query(
        `UPDATE experiment_runs SET report_artifact = $2::jsonb, updated_at = now()
         WHERE experiment_id = $1`,
        [experimentId, JSON.stringify(artifact)]
      );
      if (result.rowCount === 0) throw new Error(`unknown experiment ${experimentId}`);
    });
  }

  async attachMetrics(experimentId: string, artifact: ArtifactReference): Promise<void> {
    await this.#withClient(async (client) => {
      const result = await client.query(
        `UPDATE experiment_runs SET metrics_artifact = $2::jsonb, updated_at = now()
         WHERE experiment_id = $1`,
        [experimentId, JSON.stringify(artifact)]
      );
      if (result.rowCount === 0) throw new Error(`unknown experiment ${experimentId}`);
    });
  }

  async cancelExperiment(experimentId: string): Promise<void> {
    await this.#transaction(async (client) => {
      const runs = await client.query(
        "SELECT status FROM experiment_runs WHERE experiment_id = $1 FOR UPDATE",
        [experimentId]
      );
      const run = runs.rows[0];
      if (run === undefined) throw new Error(`unknown experiment ${experimentId}`);
      if (["completed", "cancelled", "invalidated", "superseded"].includes(String(run.status))) {
        return;
      }
      const reservations = await client.query(
        `DELETE FROM experiment_budget_reservations
         WHERE experiment_id = $1
         RETURNING provider_usd, infrastructure_usd`,
        [experimentId]
      );
      const totals = reservations.rows.reduce(
        (sum, row) => ({
          provider: sum.provider + number(row.provider_usd),
          infrastructure: sum.infrastructure + number(row.infrastructure_usd)
        }),
        { provider: 0, infrastructure: 0 }
      );
      await client.query(
        `UPDATE experiment_runs SET
           status = 'cancelled',
           provider_reserved_usd = GREATEST(0, provider_reserved_usd - $2),
           infrastructure_reserved_usd = GREATEST(0, infrastructure_reserved_usd - $3),
           updated_at = now()
         WHERE experiment_id = $1`,
        [experimentId, totals.provider, totals.infrastructure]
      );
      await client.query(
        `UPDATE experiment_job_attempts AS attempts SET
           status = 'cancelled',
           finished_at = now(),
           error = COALESCE(attempts.error, 'experiment cancelled')
         FROM experiment_jobs AS jobs
         WHERE attempts.job_id = jobs.job_id
           AND jobs.experiment_id = $1
           AND attempts.status = 'running'`,
        [experimentId]
      );
      await client.query(
        `UPDATE experiment_jobs SET
           status = 'cancelled', finished_at = now(), lease_expires_at = NULL
         WHERE experiment_id = $1 AND status <> 'succeeded'`,
        [experimentId]
      );
    });
  }
}
