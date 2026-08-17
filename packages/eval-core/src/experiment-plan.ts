import { createHash } from "node:crypto";

import {
  assertExplicitEvalModel,
  ExperimentManifest as ExperimentManifestSchema,
  type ExperimentApprovalStage,
  type ExperimentJob,
  type ExperimentJsonValue,
  type ExperimentManifest,
  type ExperimentTreatment,
  type FrozenExperimentPlan
} from "@velum-labs/routekit-eval-contracts";
import { Schema } from "effect";

const SECRET_KEY = /(?:api[_-]?key|authorization|credential|password|secret|token)/i;
const SHA256_IMAGE = /@sha256:[a-f0-9]{64}$/i;
const GIT_COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const CONTENT_HASH = /^[a-f0-9]{32,128}$/i;

type JsonLike =
  | null
  | boolean
  | number
  | string
  | readonly JsonLike[]
  | { readonly [key: string]: JsonLike };

function normalizeJson(value: JsonLike): JsonLike {
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, normalizeJson(entry)])
  );
}

export function canonicalJson(value: JsonLike): string {
  return JSON.stringify(normalizeJson(value));
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hashExperimentValue(value: JsonLike): string {
  return sha256(canonicalJson(value));
}

function requireNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) throw new Error(`${label} must not be empty`);
}

function requireWholeNonNegative(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
}

function assertNoSecretKeys(value: ExperimentJsonValue, path: string): void {
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      assertNoSecretKeys(entry, `${path}[${index}]`);
    }
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) {
      throw new Error(`${path} key ${JSON.stringify(key)} may contain a secret`);
    }
    assertNoSecretKeys(entry, `${path}.${key}`);
  }
}

function validateTreatment(treatment: ExperimentTreatment): void {
  requireNonEmpty(treatment.id, "treatment id");
  assertNoSecretKeys(treatment.configuration, `treatment ${treatment.id} configuration`);
  const model = treatment.configuration.model;
  if (treatment.executor === "hosted-model") {
    if (typeof model !== "string") {
      throw new Error(`hosted-model treatment ${treatment.id} requires configuration.model`);
    }
    assertExplicitEvalModel(model, "candidate");
  }
  if (treatment.executor !== "hosted-model" && treatment.command === undefined) {
    throw new Error(`${treatment.executor} treatment ${treatment.id} requires a command`);
  }
  if (
    treatment.command?.timeoutSeconds !== undefined &&
    (!Number.isInteger(treatment.command.timeoutSeconds) ||
      treatment.command.timeoutSeconds < 1 ||
      treatment.command.timeoutSeconds > 24 * 60 * 60)
  ) {
    throw new Error(
      `treatment ${treatment.id} command.timeoutSeconds must be an integer from 1 to 86400`
    );
  }
  const image = treatment.image;
  if (treatment.executor === "sandbox") {
    if (image === undefined || !SHA256_IMAGE.test(image)) {
      throw new Error(
        `sandbox treatment ${treatment.id} requires an image pinned with @sha256:<digest>`
      );
    }
  }
  for (const [label, value] of [
    ["estimatedProviderCostUsd", treatment.estimatedProviderCostUsd ?? 0],
    ["estimatedInfrastructureCostUsd", treatment.estimatedInfrastructureCostUsd ?? 0]
  ] as const) {
    if (value < 0) throw new Error(`treatment ${treatment.id} ${label} must be non-negative`);
  }
}

function validateManifest(manifest: ExperimentManifest): void {
  requireNonEmpty(manifest.experimentId, "experimentId");
  requireNonEmpty(manifest.objective, "objective");
  if (!SHA256_IMAGE.test(manifest.code.image)) {
    throw new Error("code.image must be pinned with @sha256:<digest>");
  }
  if (!GIT_COMMIT.test(manifest.code.sourceCommit)) {
    throw new Error("code.sourceCommit must be a full 40- or 64-character Git commit");
  }
  if (!CONTENT_HASH.test(manifest.dataset.hash)) {
    throw new Error("dataset.hash must be a hexadecimal content hash");
  }
  if (manifest.dataset.role === "locked_test" && !manifest.dataAccess.lockedTest) {
    throw new Error("locked-test datasets require dataAccess.lockedTest=true");
  }
  if (manifest.dataset.role !== "locked_test" && manifest.dataAccess.lockedTest) {
    throw new Error("dataAccess.lockedTest=true is only valid for a locked-test dataset");
  }
  if (manifest.matrix.treatments.length === 0) {
    throw new Error("matrix.treatments must contain at least one treatment");
  }
  if (manifest.matrix.seeds.length === 0) {
    throw new Error("matrix.seeds must contain at least one seed");
  }
  if (manifest.tasks.length === 0) throw new Error("tasks must contain at least one task");

  const treatmentIds = new Set<string>();
  for (const treatment of manifest.matrix.treatments) {
    if (treatmentIds.has(treatment.id)) {
      throw new Error(`duplicate treatment id ${JSON.stringify(treatment.id)}`);
    }
    treatmentIds.add(treatment.id);
    validateTreatment(treatment);
  }
  const taskIds = new Set<string>();
  for (const task of manifest.tasks) {
    requireNonEmpty(task.id, "task id");
    requireNonEmpty(task.inputArtifact, `task ${task.id} inputArtifact`);
    if (task.metadata !== undefined) {
      assertNoSecretKeys(task.metadata, `task ${task.id} metadata`);
    }
    if (taskIds.has(task.id)) throw new Error(`duplicate task id ${JSON.stringify(task.id)}`);
    taskIds.add(task.id);
  }
  const seeds = new Set<number>();
  for (const seed of manifest.matrix.seeds) {
    requireWholeNonNegative(seed, "seed");
    if (seeds.has(seed)) throw new Error(`duplicate seed ${seed}`);
    seeds.add(seed);
  }
  requireWholeNonNegative(
    manifest.schedule.maximumHostedCallsInFlight,
    "schedule.maximumHostedCallsInFlight"
  );
  requireWholeNonNegative(manifest.schedule.maximumSandboxes, "schedule.maximumSandboxes");
  if (
    manifest.matrix.treatments.some((treatment) => treatment.executor === "hosted-model") &&
    manifest.schedule.maximumHostedCallsInFlight < 1
  ) {
    throw new Error("hosted-model treatments require at least one hosted call in flight");
  }
  if (
    manifest.matrix.treatments.some((treatment) => treatment.executor === "sandbox") &&
    manifest.schedule.maximumSandboxes < 1
  ) {
    throw new Error("sandbox treatments require at least one active sandbox");
  }
  requireWholeNonNegative(
    manifest.selection.maximumPromotedTreatments,
    "selection.maximumPromotedTreatments"
  );
  if (manifest.selection.maximumPromotedTreatments < 1) {
    throw new Error("selection.maximumPromotedTreatments must be at least one");
  }
  if (manifest.budget.providerMaximumUsd < 0 || manifest.budget.vercelMaximumUsd < 0) {
    throw new Error("experiment budgets must be non-negative");
  }
}

function jobFor(input: {
  manifest: ExperimentManifest;
  manifestHash: string;
  treatment: ExperimentTreatment;
  taskId: string;
  inputArtifact: string;
  seed: number;
}): ExperimentJob {
  const configurationHash = hashExperimentValue(input.treatment.configuration);
  const identity = {
    manifestHash: input.manifestHash,
    treatmentId: input.treatment.id,
    taskId: input.taskId,
    seed: input.seed,
    configurationHash
  };
  const idempotencyKey = hashExperimentValue(identity);
  return {
    id: `job_${idempotencyKey.slice(0, 24)}`,
    experimentId: input.manifest.experimentId,
    treatmentId: input.treatment.id,
    taskId: input.taskId,
    seed: input.seed,
    executor: input.treatment.executor,
    idempotencyKey,
    inputArtifact: input.inputArtifact,
    configuration: input.treatment.configuration,
    configurationHash,
    image: input.treatment.image ?? input.manifest.code.image,
    command: input.treatment.command,
    estimatedProviderCostUsd: input.treatment.estimatedProviderCostUsd ?? 0,
    estimatedInfrastructureCostUsd: input.treatment.estimatedInfrastructureCostUsd ?? 0
  };
}

export function freezeExperimentPlan(
  input: unknown,
  createdAt = new Date().toISOString()
): FrozenExperimentPlan {
  const manifest = Schema.decodeUnknownSync(ExperimentManifestSchema)(input);
  validateManifest(manifest);
  const manifestHash = hashExperimentValue(manifest as JsonLike);
  const jobs: ExperimentJob[] = [];
  const tasks = [...manifest.tasks].sort((left, right) => left.id.localeCompare(right.id));
  const treatments = [...manifest.matrix.treatments].sort((left, right) =>
    left.id.localeCompare(right.id)
  );

  if (manifest.schedule.type === "paired_interleave") {
    for (const task of tasks) {
      for (const seed of manifest.matrix.seeds) {
        for (const treatment of treatments) {
          jobs.push(
            jobFor({
              manifest,
              manifestHash,
              treatment,
              taskId: task.id,
              inputArtifact: task.inputArtifact,
              seed
            })
          );
        }
      }
    }
  } else {
    for (const treatment of treatments) {
      for (const seed of manifest.matrix.seeds) {
        for (const task of tasks) {
          jobs.push(
            jobFor({
              manifest,
              manifestHash,
              treatment,
              taskId: task.id,
              inputArtifact: task.inputArtifact,
              seed
            })
          );
        }
      }
    }
  }
  const expected = expectedExperimentCost({
    manifest,
    manifestHash,
    createdAt,
    jobs
  });
  if (expected.providerUsd > manifest.budget.providerMaximumUsd + Number.EPSILON) {
    throw new Error(
      `expected provider cost $${expected.providerUsd.toFixed(4)} exceeds the manifest budget of $${manifest.budget.providerMaximumUsd.toFixed(4)}`
    );
  }
  if (expected.infrastructureUsd > manifest.budget.vercelMaximumUsd + Number.EPSILON) {
    throw new Error(
      `expected Vercel cost $${expected.infrastructureUsd.toFixed(4)} exceeds the manifest budget of $${manifest.budget.vercelMaximumUsd.toFixed(4)}`
    );
  }
  return { manifest, manifestHash, createdAt, jobs };
}

export function expectedExperimentCost(plan: FrozenExperimentPlan): {
  providerUsd: number;
  infrastructureUsd: number;
} {
  return plan.jobs.reduce(
    (total, job) => ({
      providerUsd: total.providerUsd + job.estimatedProviderCostUsd,
      infrastructureUsd: total.infrastructureUsd + job.estimatedInfrastructureCostUsd
    }),
    { providerUsd: 0, infrastructureUsd: 0 }
  );
}

export function requiredExperimentApprovalStages(
  plan: Pick<FrozenExperimentPlan, "manifest" | "jobs">
): ExperimentApprovalStage[] {
  const stages: ExperimentApprovalStage[] = [];
  if (
    plan.jobs.some(
      (job) =>
        job.estimatedProviderCostUsd > 0 || job.estimatedInfrastructureCostUsd > 0
    )
  ) {
    stages.push("paid_execution");
  }
  if (plan.manifest.dataset.role === "confirmation") stages.push("confirmation");
  if (plan.manifest.dataset.role === "locked_test") stages.push("locked_test");
  return stages;
}

export function configurationValue(
  configuration: Readonly<Record<string, ExperimentJsonValue>>,
  key: string
): ExperimentJsonValue | undefined {
  return configuration[key];
}
