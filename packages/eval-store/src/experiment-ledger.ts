import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  ArtifactReference,
  ExperimentApproval,
  ExperimentApprovalStage,
  ExperimentJobRecord,
  ExperimentSnapshot,
  ExperimentStatus,
  FrozenExperimentPlan
} from "@velum-labs/routekit-eval-contracts";
import { requiredExperimentApprovalStages } from "@velum-labs/routekit-eval-core/experiment";

export const EXPERIMENT_JOB_MAXIMUM_ATTEMPTS = 5;

export type CompleteExperimentJobInput = {
  workerId: string;
  outputArtifact: ArtifactReference;
  logArtifact?: ArtifactReference;
  providerCostUsd: number;
  infrastructureCostUsd: number;
  latencyMs: number;
};

export type FailExperimentJobInput = {
  workerId: string;
  error: string;
  providerCostUsd?: number;
  infrastructureCostUsd?: number;
  terminal?: boolean;
};

export interface ExperimentLedger {
  initialize(): Promise<void>;
  createExperiment(plan: FrozenExperimentPlan): Promise<ExperimentSnapshot>;
  listExperiments(): Promise<ExperimentSnapshot["experiment"][]>;
  getExperiment(experimentId: string): Promise<ExperimentSnapshot | undefined>;
  getJob(jobId: string): Promise<ExperimentJobRecord | undefined>;
  approve(
    experimentId: string,
    stage: ExperimentApprovalStage,
    actor: string
  ): Promise<ExperimentApproval>;
  setExperimentStatus(
    experimentId: string,
    status: ExperimentStatus,
    error?: string
  ): Promise<void>;
  queuePendingJobs(experimentId: string): Promise<ExperimentJobRecord[]>;
  claimJob(
    jobId: string,
    workerId: string,
    leaseMilliseconds: number,
    maximumAttempts?: number
  ): Promise<ExperimentJobRecord | undefined>;
  disableJobRetries(jobId: string, workerId: string): Promise<boolean>;
  heartbeatJob(jobId: string, workerId: string, leaseMilliseconds: number): Promise<boolean>;
  completeJob(jobId: string, input: CompleteExperimentJobInput): Promise<ExperimentJobRecord>;
  failJob(jobId: string, input: FailExperimentJobInput): Promise<ExperimentJobRecord>;
  attachMetrics(experimentId: string, artifact: ArtifactReference): Promise<void>;
  attachReport(experimentId: string, artifact: ArtifactReference): Promise<void>;
  cancelExperiment(experimentId: string): Promise<void>;
}

type Reservation = {
  providerUsd: number;
  infrastructureUsd: number;
};

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };

type MutableExperimentJobRecord = Mutable<ExperimentJobRecord>;
type MutableExperimentSnapshot = {
  experiment: Mutable<ExperimentSnapshot["experiment"]>;
  jobs: MutableExperimentJobRecord[];
  approvals: ExperimentApproval[];
};

type LocalLedgerState = {
  version: 1;
  experiments: Record<string, MutableExperimentSnapshot>;
  reservations: Record<string, Reservation>;
};

const EMPTY_STATE: LocalLedgerState = {
  version: 1,
  experiments: {},
  reservations: {}
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

function now(): string {
  return new Date().toISOString();
}

function transitionAllowed(from: ExperimentStatus, to: ExperimentStatus): boolean {
  if (from === to) return true;
  if (["cancelled", "invalidated", "superseded"].includes(from)) return false;
  if (to === "cancelled" || to === "invalidated" || to === "superseded") return true;
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

export class LocalExperimentLedger implements ExperimentLedger {
  readonly #path: string;
  #pending: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.#path = path;
  }

  async initialize(): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    try {
      await readFile(this.#path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.#write(EMPTY_STATE);
    }
  }

  async #read(): Promise<LocalLedgerState> {
    try {
      const state = JSON.parse(await readFile(this.#path, "utf8")) as LocalLedgerState;
      for (const snapshot of Object.values(state.experiments)) {
        for (const record of snapshot.jobs) {
          record.retryable ??= true;
        }
      }
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return clone(EMPTY_STATE);
      throw error;
    }
  }

  async #write(state: LocalLedgerState): Promise<void> {
    const temporary = `${this.#path}.${process.pid}.${Date.now()}.tmp`;
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.#path);
  }

  async #mutate<T>(operation: (state: LocalLedgerState) => T | Promise<T>): Promise<T> {
    let resolveResult: (value: T) => void = () => undefined;
    let rejectResult: (reason: unknown) => void = () => undefined;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    this.#pending = this.#pending
      .then(async () => {
        const state = await this.#read();
        const value = await operation(state);
        await this.#write(state);
        resolveResult(clone(value));
      })
      .catch(rejectResult);
    await result;
    return result;
  }

  async createExperiment(plan: FrozenExperimentPlan): Promise<ExperimentSnapshot> {
    return this.#mutate((state) => {
      const existing = state.experiments[plan.manifest.experimentId];
      if (existing !== undefined) {
        if (existing.experiment.manifestHash !== plan.manifestHash) {
          throw new Error(
            `experiment ${plan.manifest.experimentId} already exists with a different manifest`
          );
        }
        return existing;
      }
      const requiredApprovals = requiredExperimentApprovalStages(plan);
      const createdAt = plan.createdAt;
      const snapshot: MutableExperimentSnapshot = {
        experiment: {
          experimentId: plan.manifest.experimentId,
          manifestHash: plan.manifestHash,
          status: requiredApprovals.length > 0 ? "awaiting_approval" : "queued",
          manifest: plan.manifest,
          createdAt,
          updatedAt: createdAt,
          providerReservedUsd: 0,
          providerSpentUsd: 0,
          infrastructureReservedUsd: 0,
          infrastructureSpentUsd: 0
        },
        jobs: plan.jobs.map((job) => ({
          job,
          status: "pending",
          retryable: true,
          attemptCount: 0,
          providerCostUsd: 0,
          infrastructureCostUsd: 0
        })),
        approvals: []
      };
      state.experiments[plan.manifest.experimentId] = snapshot;
      return snapshot;
    });
  }

  async listExperiments(): Promise<ExperimentSnapshot["experiment"][]> {
    const state = await this.#read();
    return Object.values(state.experiments)
      .map((snapshot) => clone(snapshot.experiment))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async getExperiment(experimentId: string): Promise<ExperimentSnapshot | undefined> {
    const state = await this.#read();
    const snapshot = state.experiments[experimentId];
    return snapshot === undefined ? undefined : clone(snapshot);
  }

  async getJob(jobId: string): Promise<ExperimentJobRecord | undefined> {
    const state = await this.#read();
    return clone(this.#findJob(state, jobId)?.record);
  }

  async approve(
    experimentId: string,
    stage: ExperimentApprovalStage,
    actor: string
  ): Promise<ExperimentApproval> {
    return this.#mutate((state) => {
      const snapshot = this.#requireExperiment(state, experimentId);
      if (stage === "locked_test" && snapshot.experiment.manifest.dataset.role !== "locked_test") {
        throw new Error("locked-test approval is only valid for a locked-test experiment");
      }
      const existing = snapshot.approvals.find((approval) => approval.stage === stage);
      if (existing !== undefined) return existing;
      const approval: ExperimentApproval = {
        experimentId,
        stage,
        actor,
        approvedAt: now()
      };
      snapshot.approvals.push(approval);
      const required = requiredExperimentApprovalStages({
        manifest: snapshot.experiment.manifest,
        jobs: snapshot.jobs.map((record) => record.job)
      });
      const approved = new Set(snapshot.approvals.map((entry) => entry.stage));
      if (
        snapshot.experiment.status === "awaiting_approval" &&
        required.every((requiredStage) => approved.has(requiredStage))
      ) {
        snapshot.experiment.status = "queued";
      }
      snapshot.experiment.updatedAt = approval.approvedAt;
      return approval;
    });
  }

  async setExperimentStatus(
    experimentId: string,
    status: ExperimentStatus,
    error?: string
  ): Promise<void> {
    await this.#mutate((state) => {
      const snapshot = this.#requireExperiment(state, experimentId);
      if (!transitionAllowed(snapshot.experiment.status, status)) {
        throw new Error(
          `cannot transition experiment ${experimentId} from ${snapshot.experiment.status} to ${status}`
        );
      }
      snapshot.experiment.status = status;
      snapshot.experiment.updatedAt = now();
      snapshot.experiment.error = error;
    });
  }

  async queuePendingJobs(experimentId: string): Promise<ExperimentJobRecord[]> {
    return this.#mutate((state) => {
      const snapshot = this.#requireExperiment(state, experimentId);
      if (!["queued", "running"].includes(snapshot.experiment.status)) {
        throw new Error(
          `experiment ${experimentId} cannot queue jobs while ${snapshot.experiment.status}`
        );
      }
      const queued: ExperimentJobRecord[] = [];
      for (const record of snapshot.jobs) {
        if (
          record.status !== "pending" &&
          !(
            record.status === "failed" &&
            record.retryable &&
            record.attemptCount < EXPERIMENT_JOB_MAXIMUM_ATTEMPTS
          )
        ) {
          continue;
        }
        record.status = "queued";
        record.error = undefined;
        queued.push(record);
      }
      snapshot.experiment.updatedAt = now();
      return queued;
    });
  }

  async claimJob(
    jobId: string,
    workerId: string,
    leaseMilliseconds: number,
    maximumAttempts = EXPERIMENT_JOB_MAXIMUM_ATTEMPTS
  ): Promise<ExperimentJobRecord | undefined> {
    return this.#mutate((state) => {
      const located = this.#findJob(state, jobId);
      if (located === undefined) throw new Error(`unknown experiment job ${jobId}`);
      const { snapshot, record } = located;
      if (!["queued", "running"].includes(snapshot.experiment.status)) {
        return undefined;
      }
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
        const providerCostUsd = record.job.estimatedProviderCostUsd;
        const infrastructureCostUsd = record.job.estimatedInfrastructureCostUsd;
        this.#settleReservation(state, snapshot, jobId, {
          providerCostUsd,
          infrastructureCostUsd
        });
        record.status = "failed";
        record.providerCostUsd += providerCostUsd;
        record.infrastructureCostUsd += infrastructureCostUsd;
        record.finishedAt = now();
        record.leaseExpiresAt = undefined;
        record.error =
          "worker lease expired after a paid request was dispatched; automatic retry disabled";
        snapshot.experiment.updatedAt = record.finishedAt;
        return undefined;
      }
      if (record.attemptCount >= maximumAttempts) return undefined;
      if (record.job.executor === "hosted-model" || record.job.executor === "sandbox") {
        const maximum =
          record.job.executor === "hosted-model"
            ? snapshot.experiment.manifest.schedule.maximumHostedCallsInFlight
            : snapshot.experiment.manifest.schedule.maximumSandboxes;
        const active = snapshot.jobs.filter(
          (candidate) =>
            candidate.job.executor === record.job.executor &&
            candidate.status === "running" &&
            candidate.job.id !== jobId &&
            (candidate.leaseExpiresAt === undefined ||
              new Date(candidate.leaseExpiresAt).getTime() > Date.now())
        ).length;
        if (active >= maximum) return undefined;
      }
      if (state.reservations[jobId] === undefined) {
        const provider = record.job.estimatedProviderCostUsd;
        const infrastructure = record.job.estimatedInfrastructureCostUsd;
        if (
          snapshot.experiment.providerReservedUsd +
            snapshot.experiment.providerSpentUsd +
            provider >
          snapshot.experiment.manifest.budget.providerMaximumUsd + Number.EPSILON
        ) {
          record.status = "failed";
          record.attemptCount = maximumAttempts;
          record.finishedAt = now();
          record.error = `provider budget exceeded for experiment ${record.job.experimentId}`;
          snapshot.experiment.updatedAt = record.finishedAt;
          return undefined;
        }
        if (
          snapshot.experiment.infrastructureReservedUsd +
            snapshot.experiment.infrastructureSpentUsd +
            infrastructure >
          snapshot.experiment.manifest.budget.vercelMaximumUsd + Number.EPSILON
        ) {
          record.status = "failed";
          record.attemptCount = maximumAttempts;
          record.finishedAt = now();
          record.error = `Vercel budget exceeded for experiment ${record.job.experimentId}`;
          snapshot.experiment.updatedAt = record.finishedAt;
          return undefined;
        }
        state.reservations[jobId] = {
          providerUsd: provider,
          infrastructureUsd: infrastructure
        };
        snapshot.experiment.providerReservedUsd += provider;
        snapshot.experiment.infrastructureReservedUsd += infrastructure;
      }
      const claimedAt = now();
      record.status = "running";
      record.workerId = workerId;
      record.attemptCount += 1;
      record.startedAt ??= claimedAt;
      record.finishedAt = undefined;
      record.leaseExpiresAt = new Date(Date.now() + leaseMilliseconds).toISOString();
      record.error = undefined;
      if (snapshot.experiment.status === "queued") snapshot.experiment.status = "running";
      snapshot.experiment.updatedAt = claimedAt;
      return record;
    });
  }

  async disableJobRetries(jobId: string, workerId: string): Promise<boolean> {
    return this.#mutate((state) => {
      const located = this.#findJob(state, jobId);
      if (
        located === undefined ||
        located.record.status !== "running" ||
        located.record.workerId !== workerId
      ) {
        return false;
      }
      located.record.retryable = false;
      located.snapshot.experiment.updatedAt = now();
      return true;
    });
  }

  async completeJob(
    jobId: string,
    input: CompleteExperimentJobInput
  ): Promise<ExperimentJobRecord> {
    return this.#mutate((state) => {
      const located = this.#findJob(state, jobId);
      if (located === undefined) throw new Error(`unknown experiment job ${jobId}`);
      const { snapshot, record } = located;
      if (record.status === "succeeded") return record;
      if (record.status === "cancelled") return record;
      if (record.status !== "running" || record.workerId !== input.workerId) {
        throw new Error(`worker ${input.workerId} does not own running job ${jobId}`);
      }
      this.#settleReservation(state, snapshot, jobId, input);
      record.status = "succeeded";
      record.outputArtifact = input.outputArtifact;
      record.logArtifact = input.logArtifact;
      record.providerCostUsd += input.providerCostUsd;
      record.infrastructureCostUsd += input.infrastructureCostUsd;
      record.latencyMs = input.latencyMs;
      record.finishedAt = now();
      record.leaseExpiresAt = undefined;
      record.error = undefined;
      snapshot.experiment.updatedAt = record.finishedAt;
      return record;
    });
  }

  async heartbeatJob(jobId: string, workerId: string, leaseMilliseconds: number): Promise<boolean> {
    return this.#mutate((state) => {
      const located = this.#findJob(state, jobId);
      if (
        located === undefined ||
        located.record.status !== "running" ||
        located.record.workerId !== workerId
      ) {
        return false;
      }
      located.record.leaseExpiresAt = new Date(Date.now() + leaseMilliseconds).toISOString();
      located.snapshot.experiment.updatedAt = now();
      return true;
    });
  }

  async failJob(jobId: string, input: FailExperimentJobInput): Promise<ExperimentJobRecord> {
    return this.#mutate((state) => {
      const located = this.#findJob(state, jobId);
      if (located === undefined) throw new Error(`unknown experiment job ${jobId}`);
      const { snapshot, record } = located;
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
      this.#settleReservation(state, snapshot, jobId, {
        providerCostUsd: input.providerCostUsd ?? 0,
        infrastructureCostUsd: input.infrastructureCostUsd ?? 0
      });
      record.status = "failed";
      if (input.terminal === true) {
        record.retryable = false;
      }
      record.error = input.error;
      record.finishedAt = now();
      record.leaseExpiresAt = undefined;
      record.providerCostUsd += input.providerCostUsd ?? 0;
      record.infrastructureCostUsd += input.infrastructureCostUsd ?? 0;
      snapshot.experiment.updatedAt = record.finishedAt;
      return record;
    });
  }

  async attachReport(experimentId: string, artifact: ArtifactReference): Promise<void> {
    await this.#mutate((state) => {
      const snapshot = this.#requireExperiment(state, experimentId);
      snapshot.experiment.reportArtifact = artifact;
      snapshot.experiment.updatedAt = now();
    });
  }

  async attachMetrics(experimentId: string, artifact: ArtifactReference): Promise<void> {
    await this.#mutate((state) => {
      const snapshot = this.#requireExperiment(state, experimentId);
      snapshot.experiment.metricsArtifact = artifact;
      snapshot.experiment.updatedAt = now();
    });
  }

  async cancelExperiment(experimentId: string): Promise<void> {
    await this.#mutate((state) => {
      const snapshot = this.#requireExperiment(state, experimentId);
      if (
        ["completed", "cancelled", "invalidated", "superseded"].includes(snapshot.experiment.status)
      ) {
        return;
      }
      snapshot.experiment.status = "cancelled";
      snapshot.experiment.updatedAt = now();
      for (const record of snapshot.jobs) {
        if (record.status === "succeeded") continue;
        const reservation = state.reservations[record.job.id];
        if (reservation !== undefined) {
          snapshot.experiment.providerReservedUsd -= reservation.providerUsd;
          snapshot.experiment.infrastructureReservedUsd -= reservation.infrastructureUsd;
          delete state.reservations[record.job.id];
        }
        record.status = "cancelled";
        record.finishedAt = snapshot.experiment.updatedAt;
        record.leaseExpiresAt = undefined;
      }
    });
  }

  #requireExperiment(state: LocalLedgerState, experimentId: string): MutableExperimentSnapshot {
    const snapshot = state.experiments[experimentId];
    if (snapshot === undefined) throw new Error(`unknown experiment ${experimentId}`);
    return snapshot;
  }

  #findJob(
    state: LocalLedgerState,
    jobId: string
  ): { snapshot: MutableExperimentSnapshot; record: MutableExperimentJobRecord } | undefined {
    for (const snapshot of Object.values(state.experiments)) {
      const record = snapshot.jobs.find((candidate) => candidate.job.id === jobId);
      if (record !== undefined) return { snapshot, record };
    }
    return undefined;
  }

  #settleReservation(
    state: LocalLedgerState,
    snapshot: MutableExperimentSnapshot,
    jobId: string,
    actual: { providerCostUsd: number; infrastructureCostUsd: number }
  ): void {
    if (actual.providerCostUsd < 0 || actual.infrastructureCostUsd < 0) {
      throw new Error("actual job costs must be non-negative");
    }
    const reservation = state.reservations[jobId];
    if (reservation !== undefined) {
      snapshot.experiment.providerReservedUsd -= reservation.providerUsd;
      snapshot.experiment.infrastructureReservedUsd -= reservation.infrastructureUsd;
      delete state.reservations[jobId];
    }
    snapshot.experiment.providerSpentUsd += actual.providerCostUsd;
    snapshot.experiment.infrastructureSpentUsd += actual.infrastructureCostUsd;
  }
}
