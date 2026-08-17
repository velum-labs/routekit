import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import {
  buildLunaAccuracyPrompt,
  getLunaAccuracyRepetitionSeed,
  validateLunaAccuracyMatrixV2,
  type LunaAccuracyMatrixV2,
  type LunaAccuracyPrompt,
  type LunaAccuracyVariantV2,
} from "./luna-accuracy-context.ts";
import { contentHash, sha256 } from "./hash.ts";
import type {
  AreaCardV1,
  ClassifierPredictionV1,
  RepositoryProfileV1,
  TaskEpisode,
  UnknownType,
} from "./types.ts";
import {
  validateAreaCards,
  validateEpisodes,
  validateRepositoryProfile,
} from "./validation.ts";
import {
  buildLunaAccuracyProviderRequest,
  LUNA_ACCURACY_CANONICAL_MODEL,
  LUNA_ACCURACY_MODEL,
  LUNA_ACCURACY_PROVIDER,
  LUNA_ACCURACY_TRANSPORT_POLICY,
  LUNA_ACCURACY_PREFLIGHT_VERSION,
  LUNA_ACCURACY_PROVIDER_SLUG,
  LUNA_ACCURACY_REQUIRED_PROVIDER_PARAMETERS,
  type LunaAccuracyCallMetadata,
  type LunaAccuracyOpenRouterPreflight,
  type LunaAccuracyOpenRouterPreflightBinding,
} from "./luna-accuracy-openrouter.ts";

export const LUNA_ACCURACY_RUNNER_VERSION =
  "luna-accuracy-runner-v2-pinned-transport" as const;
export const LUNA_ACCURACY_FINALIZATION_VERSION =
  "luna-accuracy-finalization-v1" as const;
export const LUNA_ACCURACY_MAX_CONCURRENCY = 32 as const;

export type LunaAccuracyArchitecture =
  | "single_call"
  | "self_consistency_3"
  | "proposal_verify_revise";

export type LunaAccuracyCallStage =
  | "single"
  | "member"
  | "proposal"
  | "verify"
  | "revise";

export interface LunaAccuracyExperimentArm {
  id: string;
  variantId: string;
  architecture: LunaAccuracyArchitecture;
}

export interface LunaAccuracyPipelineJob {
  key: string;
  armId: string;
  variantId: string;
  architecture: LunaAccuracyArchitecture;
  taskEpisodeId: string;
  repetitionIndex: number;
  seed: number;
}

export interface LunaAccuracyExecutorInput {
  model: string;
  taskEpisodeId: string;
  armId: string;
  variantId: string;
  architecture: LunaAccuracyArchitecture;
  stage: LunaAccuracyCallStage;
  repetitionIndex: number;
  seed: number;
  prompt: LunaAccuracyPrompt;
  variant: LunaAccuracyVariantV2;
  allowedAreaIds: readonly string[];
  classifierLabel: string;
  attempt: number;
  signal: AbortSignal;
}

export interface LunaAccuracyExecutorResult {
  prediction: ClassifierPredictionV1;
  /**
   * Safe operational metadata only. Prompts, traces, provider request IDs,
   * response text, and hidden reasoning never enter runner artifacts.
   */
  metadata?: unknown;
}

export type LunaAccuracyCallExecutor = (
  input: LunaAccuracyExecutorInput,
) => Promise<LunaAccuracyExecutorResult | ClassifierPredictionV1>;

export interface LunaAccuracyRetryPolicy {
  maxAttempts: number;
  timeoutMs: number;
  initialBackoffMs: number;
  maximumBackoffMs: number;
  backoffMultiplier: number;
  jitterFraction: number;
}

export interface LunaAccuracyRetryContext {
  job: LunaAccuracyPipelineJob;
  stage: LunaAccuracyCallStage;
  attempt: number;
  maximumAttempts: number;
}

export interface LunaAccuracyRunnerHooks {
  now?: () => string;
  sleep?: (milliseconds: number) => Promise<void>;
  shouldRetry?: (
    error: unknown,
    context: LunaAccuracyRetryContext,
  ) => boolean;
  backoffMs?: (
    context: LunaAccuracyRetryContext,
    policy: LunaAccuracyRetryPolicy,
  ) => number;
  onAttempt?: (
    context: LunaAccuracyRetryContext & { promptHash: string },
  ) => void | Promise<void>;
}

export interface LunaAccuracyCallRecord {
  schemaVersion: 1;
  runnerVersion: typeof LUNA_ACCURACY_RUNNER_VERSION;
  key: string;
  jobKey: string;
  inputHash: string;
  promptHash: string;
  armId: string;
  variantId: string;
  architecture: LunaAccuracyArchitecture;
  taskEpisodeId: string;
  repetitionIndex: number;
  seed: number;
  stage: LunaAccuracyCallStage;
  attemptCount: number;
  completedAt: string;
  prediction: ClassifierPredictionV1;
  transport: LunaAccuracyPersistedTransportMetadata;
}

export interface LunaAccuracyPersistedTransportMetadata {
  policyVersion: typeof LUNA_ACCURACY_TRANSPORT_POLICY.version;
  providerRequestHash: string;
  providerName: typeof LUNA_ACCURACY_PROVIDER;
  responseModel: typeof LUNA_ACCURACY_MODEL;
  catalogCanonicalModel: typeof LUNA_ACCURACY_CANONICAL_MODEL;
}

export interface LunaAccuracyRunManifest {
  schemaVersion: 1;
  runnerVersion: typeof LUNA_ACCURACY_RUNNER_VERSION;
  createdAt: string;
  configurationHash: string;
  inputHash: string;
  model: string;
  transport: {
    policyVersion: typeof LUNA_ACCURACY_TRANSPORT_POLICY.version;
    policyHash: string;
    endpoint: typeof LUNA_ACCURACY_TRANSPORT_POLICY.endpoint;
    requestedModel: typeof LUNA_ACCURACY_TRANSPORT_POLICY.requestedModel;
    expectedCanonicalModel:
      typeof LUNA_ACCURACY_TRANSPORT_POLICY.expectedCanonicalModel;
    expectedProviderName:
      typeof LUNA_ACCURACY_TRANSPORT_POLICY.expectedProviderName;
    catalogPreflight?: LunaAccuracyOpenRouterPreflightBinding;
    catalogPreflightHash?: string;
  };
  concurrency: number;
  scheduleSeed: number;
  retryPolicy: LunaAccuracyRetryPolicy;
  repository: {
    repositoryIdHash: string;
    snapshotHash: string;
  };
  hashes: {
    profile: string;
    registry: string;
    runtimeEpisodes: string;
    matrix: string;
    arms: string;
  };
  counts: {
    cases: number;
    contextVariants: number;
    experimentArms: number;
    pipelineJobs: number;
    expectedCalls: number;
  };
  arms: LunaAccuracyExperimentArm[];
}

export interface LunaAccuracyPredictionSet {
  id: string;
  armId: string;
  variantId: string;
  architecture: LunaAccuracyArchitecture;
  repetitionIndex: number | null;
  seeds: number[];
  predictions: ClassifierPredictionV1[];
}

export interface LunaAccuracyRunSummary {
  schemaVersion: 1;
  runnerVersion: typeof LUNA_ACCURACY_RUNNER_VERSION;
  completedAt: string;
  configurationHash: string;
  inputHash: string;
  concurrency: number;
  cases: number;
  arms: number;
  pipelineJobs: number;
  completedCalls: number;
  predictionSets: Array<{
    id: string;
    armId: string;
    architecture: LunaAccuracyArchitecture;
    repetitionIndex: number | null;
    seeds: number[];
    predictions: number;
  }>;
}

export interface LunaAccuracyRunFinalization {
  schemaVersion: 1;
  finalizationVersion: typeof LUNA_ACCURACY_FINALIZATION_VERSION;
  completedAt: string;
  configurationHash: string;
  inputHash: string;
  transportPolicyHash: string;
  completedCalls: {
    count: number;
    hash: string;
  };
  predictionSets: {
    count: number;
    hash: string;
  };
  summaryHash: string;
}

export interface LunaAccuracyRunResult {
  manifest: LunaAccuracyRunManifest;
  schedule: LunaAccuracyPipelineJob[];
  callRecords: LunaAccuracyCallRecord[];
  predictionSets: LunaAccuracyPredictionSet[];
  executedCalls: number;
  resumedCalls: number;
  attempts: number;
  paths: {
    manifest: string;
    callStateDirectory: string;
    callsJsonl: string;
    predictionSetsDirectory: string;
    summary: string;
    finalization: string;
  };
}

export interface RunLunaAccuracyExperimentInput {
  runDirectory: string;
  model: string;
  profile: RepositoryProfileV1;
  cards: AreaCardV1[];
  episodes: TaskEpisode[];
  matrix: LunaAccuracyMatrixV2;
  arms?: LunaAccuracyExperimentArm[];
  concurrency?: number;
  scheduleSeed?: number;
  retryPolicy?: Partial<LunaAccuracyRetryPolicy>;
  executor: LunaAccuracyCallExecutor;
  transportPreflight?: LunaAccuracyOpenRouterPreflight;
  hooks?: LunaAccuracyRunnerHooks;
}

const DEFAULT_RETRY_POLICY: LunaAccuracyRetryPolicy = Object.freeze({
  maxAttempts: 3,
  timeoutMs: 300_000,
  initialBackoffMs: 1_000,
  maximumBackoffMs: 30_000,
  backoffMultiplier: 2,
  jitterFraction: 0.15,
});

export const normalizeLunaAccuracyConcurrency = (
  value: number | undefined,
): number => {
  const concurrency = value ?? 1;
  if (
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > LUNA_ACCURACY_MAX_CONCURRENCY
  ) {
    throw new Error(
      `Luna accuracy concurrency must be an integer from 1 to ${LUNA_ACCURACY_MAX_CONCURRENCY}`,
    );
  }
  return concurrency;
};

const UNKNOWN_TYPES = new Set<UnknownType>([
  "new_repository_area",
  "outside_scope",
  "insufficient_information",
]);

const ARCHITECTURES = new Set<LunaAccuracyArchitecture>([
  "single_call",
  "self_consistency_3",
  "proposal_verify_revise",
]);

const STAGES = new Set<LunaAccuracyCallStage>([
  "single",
  "member",
  "proposal",
  "verify",
  "revise",
]);

const safeId = /^[a-z0-9][a-z0-9_-]{0,79}$/u;

const lexicalCompare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const defaultSleep = async (milliseconds: number): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
};

const numericTotal = (
  predictions: readonly ClassifierPredictionV1[],
  key:
    | "inputCharacters"
    | "inputTokens"
    | "cachedInputTokens"
    | "outputTokens"
    | "reasoningOutputTokens"
    | "costUsd",
): number | undefined => {
  const values = predictions.map((prediction) => prediction[key]);
  return values.every(
      (value): value is number =>
        typeof value === "number" && Number.isFinite(value),
    )
    ? values.reduce((sum, value) => sum + value, 0)
    : undefined;
};

const clonePrediction = (
  prediction: ClassifierPredictionV1,
  classifierOverride?: string,
): ClassifierPredictionV1 => {
  const inputCharacters = prediction.inputCharacters;
  const inputTokens = prediction.inputTokens;
  const cachedInputTokens = prediction.cachedInputTokens;
  const outputTokens = prediction.outputTokens;
  const reasoningOutputTokens = prediction.reasoningOutputTokens;
  const costUsd = prediction.costUsd;
  const gateConfidence = prediction.gateConfidence;
  const areaConfidence = prediction.areaConfidence;
  return {
    schemaVersion: 1,
    taskEpisodeId: prediction.taskEpisodeId,
    classifier: classifierOverride ?? prediction.classifier,
    areaScores: prediction.areaScores.map((score) => ({
      areaId: score.areaId,
      score: score.score,
      evidenceIds: [...score.evidenceIds],
    })),
    selectedAreaIds: [...prediction.selectedAreaIds],
    known: prediction.known,
    ...(!prediction.known && prediction.unknownType
      ? { unknownType: prediction.unknownType }
      : {}),
    confidence: prediction.confidence,
    ...(gateConfidence !== undefined ? { gateConfidence } : {}),
    ...(areaConfidence !== undefined ? { areaConfidence } : {}),
    ...(prediction.abstentionReason !== undefined
      ? { abstentionReason: prediction.abstentionReason }
      : {}),
    durationMs: prediction.durationMs,
    ...(inputCharacters !== undefined ? { inputCharacters } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined
      ? { reasoningOutputTokens }
      : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
};

const persistedTransportMetadata = (
  metadata: LunaAccuracyCallMetadata | undefined,
  providerRequestHash: string,
): LunaAccuracyPersistedTransportMetadata => {
  if (
    metadata?.provider?.name !== LUNA_ACCURACY_PROVIDER ||
    metadata?.response?.model !== LUNA_ACCURACY_MODEL
  ) {
    throw new Error(
      "Luna accuracy executor omitted or returned mismatched pinned transport metadata",
    );
  }
  return {
    policyVersion: LUNA_ACCURACY_TRANSPORT_POLICY.version,
    providerRequestHash,
    providerName: LUNA_ACCURACY_PROVIDER,
    responseModel: LUNA_ACCURACY_MODEL,
    catalogCanonicalModel: LUNA_ACCURACY_CANONICAL_MODEL,
  };
};

const decisionKey = (prediction: ClassifierPredictionV1): string =>
  JSON.stringify({
    known: prediction.known,
    selectedAreaIds: [...prediction.selectedAreaIds].sort(),
    unknownType: prediction.unknownType ?? null,
  });

const validatePrediction = (
  prediction: ClassifierPredictionV1,
  taskEpisodeId: string,
  allowedAreaIds: readonly string[],
): void => {
  if (!isRecord(prediction) || prediction.schemaVersion !== 1) {
    throw new Error("Luna accuracy executor returned an invalid prediction");
  }
  if (prediction.taskEpisodeId !== taskEpisodeId) {
    throw new Error(
      `Luna accuracy prediction case mismatch: expected ${taskEpisodeId}`,
    );
  }
  if (
    typeof prediction.classifier !== "string" ||
    !prediction.classifier.trim()
  ) {
    throw new Error("Luna accuracy prediction requires a classifier label");
  }
  if (
    !Array.isArray(prediction.selectedAreaIds) ||
    prediction.selectedAreaIds.length > 2 ||
    new Set(prediction.selectedAreaIds).size !==
      prediction.selectedAreaIds.length
  ) {
    throw new Error("Luna accuracy prediction has invalid selected areas");
  }
  const allowed = new Set(allowedAreaIds);
  for (const areaId of prediction.selectedAreaIds) {
    if (typeof areaId !== "string" || !allowed.has(areaId)) {
      throw new Error(`Luna accuracy prediction invented area ID ${areaId}`);
    }
  }
  if (
    typeof prediction.known !== "boolean" ||
    prediction.known !== (prediction.selectedAreaIds.length > 0)
  ) {
    throw new Error("Luna accuracy prediction has an inconsistent known flag");
  }
  if (prediction.known && prediction.unknownType !== undefined) {
    throw new Error(
      "Luna accuracy prediction returned unknownType for known work",
    );
  }
  if (
    !prediction.known &&
    (
      prediction.unknownType === undefined ||
      !UNKNOWN_TYPES.has(prediction.unknownType)
    )
  ) {
    throw new Error(
      "Luna accuracy prediction requires a valid unknown subtype",
    );
  }
  if (
    typeof prediction.confidence !== "number" ||
    !Number.isFinite(prediction.confidence) ||
    prediction.confidence < 0 ||
    prediction.confidence > 1
  ) {
    throw new Error("Luna accuracy prediction confidence must be 0..1");
  }
  if (
    prediction.gateConfidence !== undefined &&
    (
      typeof prediction.gateConfidence !== "number" ||
      !Number.isFinite(prediction.gateConfidence) ||
      prediction.gateConfidence < 0 ||
      prediction.gateConfidence > 1
    )
  ) {
    throw new Error(
      "Luna accuracy prediction gateConfidence must be 0..1",
    );
  }
  if (
    prediction.areaConfidence !== undefined &&
    prediction.areaConfidence !== null &&
    (
      typeof prediction.areaConfidence !== "number" ||
      !Number.isFinite(prediction.areaConfidence) ||
      prediction.areaConfidence < 0 ||
      prediction.areaConfidence > 1
    )
  ) {
    throw new Error(
      "Luna accuracy prediction areaConfidence must be null or 0..1",
    );
  }
  if (
    prediction.areaConfidence !== undefined &&
    (
      (prediction.known && prediction.areaConfidence === null) ||
      (!prediction.known && prediction.areaConfidence !== null)
    )
  ) {
    throw new Error(
      "Luna accuracy prediction areaConfidence conflicts with known",
    );
  }
  if (
    typeof prediction.durationMs !== "number" ||
    !Number.isFinite(prediction.durationMs) ||
    prediction.durationMs < 0
  ) {
    throw new Error("Luna accuracy prediction duration must be non-negative");
  }
  if (!Array.isArray(prediction.areaScores)) {
    throw new Error("Luna accuracy prediction requires areaScores");
  }
  const scoredAreas = new Set<string>();
  for (const score of prediction.areaScores) {
    if (
      !isRecord(score) ||
      typeof score.areaId !== "string" ||
      !allowed.has(score.areaId) ||
      scoredAreas.has(score.areaId) ||
      typeof score.score !== "number" ||
      !Number.isFinite(score.score) ||
      score.score < 0 ||
      score.score > 1 ||
      !Array.isArray(score.evidenceIds) ||
      !score.evidenceIds.every((value) => typeof value === "string")
    ) {
      throw new Error("Luna accuracy prediction has invalid area scores");
    }
    scoredAreas.add(score.areaId);
  }
  for (const key of [
    "inputCharacters",
    "inputTokens",
    "cachedInputTokens",
    "outputTokens",
    "reasoningOutputTokens",
    "costUsd",
  ] as const) {
    const value = prediction[key];
    if (
      value !== undefined &&
      (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < 0
      )
    ) {
      throw new Error(`Luna accuracy prediction has invalid ${key}`);
    }
  }
};

const expectedStages = (
  architecture: LunaAccuracyArchitecture,
): LunaAccuracyCallStage[] => {
  if (architecture === "single_call") return ["single"];
  if (architecture === "self_consistency_3") return ["member"];
  return ["proposal", "verify", "revise"];
};

export const normalizeLunaAccuracyRetryPolicy = (
  input: Partial<LunaAccuracyRetryPolicy> = {},
): LunaAccuracyRetryPolicy => {
  const policy: LunaAccuracyRetryPolicy = {
    ...DEFAULT_RETRY_POLICY,
    ...input,
  };
  if (
    !Number.isInteger(policy.maxAttempts) ||
    policy.maxAttempts < 1 ||
    policy.maxAttempts > 20
  ) {
    throw new Error("Luna accuracy maxAttempts must be 1..20");
  }
  for (const [field, value] of [
    ["timeoutMs", policy.timeoutMs],
    ["initialBackoffMs", policy.initialBackoffMs],
    ["maximumBackoffMs", policy.maximumBackoffMs],
  ] as const) {
    if (!Number.isFinite(value) || value < (field === "timeoutMs" ? 1 : 0)) {
      throw new Error(`Invalid Luna accuracy retry ${field}`);
    }
  }
  if (
    policy.maximumBackoffMs < policy.initialBackoffMs ||
    !Number.isFinite(policy.backoffMultiplier) ||
    policy.backoffMultiplier < 1 ||
    policy.backoffMultiplier > 10 ||
    !Number.isFinite(policy.jitterFraction) ||
    policy.jitterFraction < 0 ||
    policy.jitterFraction > 1
  ) {
    throw new Error("Invalid Luna accuracy retry backoff policy");
  }
  return policy;
};

export const normalizeLunaAccuracyArms = (
  matrix: LunaAccuracyMatrixV2,
  arms?: readonly LunaAccuracyExperimentArm[],
): LunaAccuracyExperimentArm[] => {
  validateLunaAccuracyMatrixV2(matrix);
  const normalized = arms
    ? arms.map((arm) => ({ ...arm }))
    : matrix.variants.map((variant) => ({
        id: variant.id,
        variantId: variant.id,
        architecture: "single_call" as const,
      }));
  if (!normalized.length) {
    throw new Error("Luna accuracy run requires at least one experiment arm");
  }
  const variants = new Map(
    matrix.variants.map((variant) => [variant.id, variant]),
  );
  const ids = new Set<string>();
  for (const arm of normalized) {
    if (!safeId.test(arm.id)) {
      throw new Error(`Invalid Luna accuracy arm ID: ${arm.id}`);
    }
    if (ids.has(arm.id)) {
      throw new Error(`Duplicate Luna accuracy arm ID: ${arm.id}`);
    }
    ids.add(arm.id);
    if (!ARCHITECTURES.has(arm.architecture)) {
      throw new Error(
        `Invalid Luna accuracy architecture: ${String(arm.architecture)}`,
      );
    }
    const variant = variants.get(arm.variantId);
    if (!variant) {
      throw new Error(
        `Luna accuracy arm ${arm.id} references missing variant ${arm.variantId}`,
      );
    }
    if (
      arm.architecture === "self_consistency_3" &&
      variant.repetitions !== 3
    ) {
      throw new Error(
        `Self-consistency arm ${arm.id} requires exactly three repetitions`,
      );
    }
  }
  return normalized;
};

const uint32FromHash = (value: unknown): number =>
  Number.parseInt(contentHash(value).slice(0, 8), 16) >>> 0;

const seededRandom = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
};

const shuffle = <T>(values: readonly T[], random: () => number): T[] => {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [result[index], result[target]] = [result[target]!, result[index]!];
  }
  return result;
};

export const lunaAccuracyJobKey = (
  job: Omit<LunaAccuracyPipelineJob, "key">,
): string =>
  contentHash({
    schemaVersion: 1,
    armId: job.armId,
    variantId: job.variantId,
    architecture: job.architecture,
    taskEpisodeId: job.taskEpisodeId,
    repetitionIndex: job.repetitionIndex,
    seed: job.seed,
  });

export const lunaAccuracyCallKey = (
  job: LunaAccuracyPipelineJob,
  stage: LunaAccuracyCallStage,
): string =>
  contentHash({
    schemaVersion: 1,
    jobKey: job.key,
    armId: job.armId,
    variantId: job.variantId,
    taskEpisodeId: job.taskEpisodeId,
    repetitionIndex: job.repetitionIndex,
    seed: job.seed,
    stage,
  });

/**
 * Builds a deterministic, balanced schedule. Each arm's case/repetition jobs
 * are independently shuffled, then consumed round-robin with a shuffled arm
 * order on every round. This prevents a whole variant from being run in one
 * provider/time block while preserving exact reproducibility.
 */
export const buildLunaAccuracyJobSchedule = (input: {
  matrix: LunaAccuracyMatrixV2;
  episodes: readonly TaskEpisode[];
  arms?: readonly LunaAccuracyExperimentArm[];
  scheduleSeed?: number;
}): LunaAccuracyPipelineJob[] => {
  const arms = normalizeLunaAccuracyArms(input.matrix, input.arms);
  const scheduleSeed = input.scheduleSeed ?? 19_871;
  if (
    !Number.isInteger(scheduleSeed) ||
    scheduleSeed < 0 ||
    scheduleSeed > 0xffff_ffff
  ) {
    throw new Error("Luna accuracy schedule seed must be a uint32 integer");
  }
  if (!input.episodes.length) {
    throw new Error("Luna accuracy schedule requires at least one case");
  }
  const episodeIds = input.episodes.map((episode) => episode.id);
  if (
    episodeIds.some((id) => !id.trim()) ||
    new Set(episodeIds).size !== episodeIds.length
  ) {
    throw new Error("Luna accuracy schedule requires unique case IDs");
  }
  const variants = new Map(
    input.matrix.variants.map((variant) => [variant.id, variant]),
  );
  const buckets = new Map<string, LunaAccuracyPipelineJob[]>();
  for (const arm of [...arms].sort((left, right) =>
    lexicalCompare(left.id, right.id)
  )) {
    const variant = variants.get(arm.variantId)!;
    const jobs: LunaAccuracyPipelineJob[] = [];
    for (const taskEpisodeId of [...episodeIds].sort(lexicalCompare)) {
      for (
        let repetitionIndex = 0;
        repetitionIndex < variant.repetitions;
        repetitionIndex += 1
      ) {
        const withoutKey = {
          armId: arm.id,
          variantId: arm.variantId,
          architecture: arm.architecture,
          taskEpisodeId,
          repetitionIndex,
          seed: getLunaAccuracyRepetitionSeed(variant, repetitionIndex),
        };
        jobs.push({
          key: lunaAccuracyJobKey(withoutKey),
          ...withoutKey,
        });
      }
    }
    buckets.set(
      arm.id,
      shuffle(
        jobs,
        seededRandom(
          uint32FromHash({
            scheduleSeed,
            armId: arm.id,
            purpose: "within-arm",
          }),
        ),
      ),
    );
  }

  const offsets = new Map([...buckets.keys()].map((id) => [id, 0]));
  const result: LunaAccuracyPipelineJob[] = [];
  let round = 0;
  while (result.length < [...buckets.values()].flat().length) {
    const active = [...buckets.keys()].filter(
      (id) => (offsets.get(id) ?? 0) < (buckets.get(id)?.length ?? 0),
    );
    const orderedArms = shuffle(
      active.sort(lexicalCompare),
      seededRandom(
        uint32FromHash({
          scheduleSeed,
          round,
          purpose: "between-arms",
        }),
      ),
    );
    for (const armId of orderedArms) {
      const offset = offsets.get(armId) ?? 0;
      const job = buckets.get(armId)?.[offset];
      if (!job) {
        throw new Error(`Internal Luna accuracy schedule error for ${armId}`);
      }
      result.push(job);
      offsets.set(armId, offset + 1);
    }
    round += 1;
  }
  return result;
};

const runtimeEpisodeProjection = (episode: TaskEpisode): unknown => ({
  schemaVersion: episode.schemaVersion,
  id: episode.id,
  repositoryId: episode.repositoryId,
  repositorySnapshot: episode.repositorySnapshot,
  sessionHash: episode.sessionHash,
  lineageHash: episode.lineageHash,
  timestamp: episode.timestamp,
  split: episode.split,
  currentRequest: episode.currentRequest,
  taskAnchor: episode.taskAnchor ?? null,
  precedingAssistant: episode.precedingAssistant ?? null,
  earlierUserContext: episode.earlierUserContext ?? [],
  relevantDiagnostic: episode.relevantDiagnostic ?? null,
  source: episode.source,
});

const canonicalCards = (cards: readonly AreaCardV1[]): AreaCardV1[] =>
  [...cards].sort((left, right) =>
    lexicalCompare(left.areaId, right.areaId)
  );

const canonicalEpisodes = (episodes: readonly TaskEpisode[]): TaskEpisode[] =>
  [...episodes].sort((left, right) => lexicalCompare(left.id, right.id));

export const lunaAccuracyModelHash = (model: string): string =>
  contentHash(model);

export const lunaAccuracyProfileHash = (
  profile: RepositoryProfileV1,
): string => contentHash(profile);

export const lunaAccuracyAreaRegistryHash = (
  cards: readonly AreaCardV1[],
): string => contentHash(canonicalCards(cards));

export const lunaAccuracyRuntimeEpisodesHash = (
  episodes: readonly TaskEpisode[],
): string =>
  contentHash(
    canonicalEpisodes(episodes).map(runtimeEpisodeProjection),
  );

export const lunaAccuracyMatrixHash = (
  matrix: LunaAccuracyMatrixV2,
): string => contentHash(matrix);

export const lunaAccuracyArmsHash = (
  matrix: LunaAccuracyMatrixV2,
  arms?: readonly LunaAccuracyExperimentArm[],
): string => contentHash(normalizeLunaAccuracyArms(matrix, arms));

const bindLunaAccuracyTransportPreflight = (
  preflight: LunaAccuracyOpenRouterPreflight | undefined,
): {
  binding?: LunaAccuracyOpenRouterPreflightBinding;
  hash?: string;
} => {
  if (preflight === undefined) return {};
  if (
    preflight.schemaVersion !== 1 ||
    preflight.preflightVersion !== LUNA_ACCURACY_PREFLIGHT_VERSION ||
    !Number.isFinite(Date.parse(preflight.checkedAt)) ||
    preflight.requestedModel !== LUNA_ACCURACY_MODEL ||
    preflight.canonicalModel !== LUNA_ACCURACY_CANONICAL_MODEL ||
    preflight.providerName !== LUNA_ACCURACY_PROVIDER ||
    preflight.providerTag !== LUNA_ACCURACY_PROVIDER_SLUG ||
    preflight.endpointAvailable !== true ||
    contentHash(preflight.requiredParameters) !==
      contentHash([...LUNA_ACCURACY_REQUIRED_PROVIDER_PARAMETERS])
  ) {
    throw new Error("Invalid or mismatched Luna accuracy transport preflight");
  }
  const binding: LunaAccuracyOpenRouterPreflightBinding = {
    preflightVersion: preflight.preflightVersion,
    requestedModel: preflight.requestedModel,
    canonicalModel: preflight.canonicalModel,
    providerName: preflight.providerName,
    providerTag: preflight.providerTag,
    endpointAvailable: true,
    requiredParameters: [...preflight.requiredParameters],
    catalog: { ...preflight.catalog },
  };
  return {
    binding,
    hash: contentHash(binding),
  };
};

const validateRunInputs = (
  profile: RepositoryProfileV1,
  cards: AreaCardV1[],
  episodes: TaskEpisode[],
  matrix: LunaAccuracyMatrixV2,
): void => {
  validateRepositoryProfile(profile);
  validateAreaCards(cards, profile);
  validateEpisodes(episodes, cards);
  validateLunaAccuracyMatrixV2(matrix);
  if (!episodes.length) {
    throw new Error("Luna accuracy run requires at least one episode");
  }
  for (const episode of episodes) {
    if (episode.repositoryId !== profile.repositoryId) {
      throw new Error(
        `Luna accuracy episode repository mismatch: ${episode.id}`,
      );
    }
  }
  const registryVersions = new Set(cards.map((card) => card.registryVersion));
  if (registryVersions.size !== 1) {
    throw new Error("Luna accuracy run requires one frozen registry version");
  }
};

export const buildLunaAccuracyRunManifest = (input: {
  model: string;
  profile: RepositoryProfileV1;
  cards: AreaCardV1[];
  episodes: TaskEpisode[];
  matrix: LunaAccuracyMatrixV2;
  arms?: LunaAccuracyExperimentArm[];
  concurrency?: number;
  scheduleSeed?: number;
  retryPolicy?: Partial<LunaAccuracyRetryPolicy>;
  transportPreflight?: LunaAccuracyOpenRouterPreflight;
  createdAt?: string;
}): LunaAccuracyRunManifest => {
  validateRunInputs(
    input.profile,
    input.cards,
    input.episodes,
    input.matrix,
  );
  if (!input.model.trim()) {
    throw new Error("Luna accuracy run requires a model");
  }
  const arms = normalizeLunaAccuracyArms(input.matrix, input.arms);
  const concurrency = normalizeLunaAccuracyConcurrency(input.concurrency);
  const scheduleSeed = input.scheduleSeed ?? 19_871;
  if (
    !Number.isInteger(scheduleSeed) ||
    scheduleSeed < 0 ||
    scheduleSeed > 0xffff_ffff
  ) {
    throw new Error("Luna accuracy schedule seed must be a uint32 integer");
  }
  const retryPolicy = normalizeLunaAccuracyRetryPolicy(input.retryPolicy);
  const schedule = buildLunaAccuracyJobSchedule({
    matrix: input.matrix,
    episodes: input.episodes,
    arms,
    scheduleSeed,
  });
  const hashes = {
    profile: lunaAccuracyProfileHash(input.profile),
    registry: lunaAccuracyAreaRegistryHash(input.cards),
    runtimeEpisodes: lunaAccuracyRuntimeEpisodesHash(input.episodes),
    matrix: lunaAccuracyMatrixHash(input.matrix),
    arms: lunaAccuracyArmsHash(input.matrix, arms),
  };
  const preflight = bindLunaAccuracyTransportPreflight(
    input.transportPreflight,
  );
  const transport = {
    policyVersion: LUNA_ACCURACY_TRANSPORT_POLICY.version,
    policyHash: contentHash(LUNA_ACCURACY_TRANSPORT_POLICY),
    endpoint: LUNA_ACCURACY_TRANSPORT_POLICY.endpoint,
    requestedModel: LUNA_ACCURACY_TRANSPORT_POLICY.requestedModel,
    expectedCanonicalModel:
      LUNA_ACCURACY_TRANSPORT_POLICY.expectedCanonicalModel,
    expectedProviderName:
      LUNA_ACCURACY_TRANSPORT_POLICY.expectedProviderName,
    ...(preflight.binding
      ? {
          catalogPreflight: preflight.binding,
          catalogPreflightHash: preflight.hash!,
        }
      : {}),
  };
  const inputHash = contentHash({
    runnerVersion: LUNA_ACCURACY_RUNNER_VERSION,
    model: input.model,
    transport,
    hashes,
  });
  const expectedCalls = schedule.reduce(
    (sum, job) => sum + expectedStages(job.architecture).length,
    0,
  );
  const configurationHash = contentHash({
    inputHash,
    concurrency,
    scheduleSeed,
    retryPolicy,
    arms,
    expectedCalls,
  });
  const createdAt = input.createdAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(createdAt))) {
    throw new Error("Luna accuracy manifest createdAt must be an ISO date");
  }
  return {
    schemaVersion: 1,
    runnerVersion: LUNA_ACCURACY_RUNNER_VERSION,
    createdAt,
    configurationHash,
    inputHash,
    model: input.model,
    transport,
    concurrency,
    scheduleSeed,
    retryPolicy,
    repository: {
      repositoryIdHash: sha256(input.profile.repositoryId),
      snapshotHash: sha256(input.profile.snapshot),
    },
    hashes,
    counts: {
      cases: input.episodes.length,
      contextVariants: input.matrix.variants.length,
      experimentArms: arms.length,
      pipelineJobs: schedule.length,
      expectedCalls,
    },
    arms,
  };
};

const SHA256_HEX = /^[a-f0-9]{64}$/u;

/**
 * Validates that a persisted run manifest is internally coherent and, when
 * supplied, corresponds exactly to the runtime inputs used by a report or
 * locked-test run. This deliberately hashes only the runtime projection of
 * episodes, so oracle-only fields cannot become classifier inputs.
 */
export const validateLunaAccuracyRunManifestBinding = (input: {
  manifest: LunaAccuracyRunManifest;
  model: string;
  episodes?: readonly TaskEpisode[];
  matrix?: LunaAccuracyMatrixV2;
  arms?: readonly LunaAccuracyExperimentArm[];
  profile?: RepositoryProfileV1;
  cards?: readonly AreaCardV1[];
}): void => {
  const { manifest } = input;
  if (
    manifest.schemaVersion !== 1 ||
    manifest.runnerVersion !== LUNA_ACCURACY_RUNNER_VERSION ||
    !Number.isFinite(Date.parse(manifest.createdAt)) ||
    manifest.model !== input.model
  ) {
    throw new Error("Invalid or mismatched Luna accuracy run manifest");
  }
  for (const [name, hash] of [
    ["configurationHash", manifest.configurationHash],
    ["inputHash", manifest.inputHash],
    ["repositoryIdHash", manifest.repository?.repositoryIdHash],
    ["snapshotHash", manifest.repository?.snapshotHash],
    ["transportPolicyHash", manifest.transport?.policyHash],
    ["profileHash", manifest.hashes?.profile],
    ["registryHash", manifest.hashes?.registry],
    ["runtimeEpisodesHash", manifest.hashes?.runtimeEpisodes],
    ["matrixHash", manifest.hashes?.matrix],
    ["armsHash", manifest.hashes?.arms],
  ] as const) {
    if (typeof hash !== "string" || !SHA256_HEX.test(hash)) {
      throw new Error(`Invalid Luna accuracy manifest ${name}`);
    }
  }
  normalizeLunaAccuracyRetryPolicy(manifest.retryPolicy);
  normalizeLunaAccuracyConcurrency(manifest.concurrency);
  const expectedTransport = {
    policyVersion: LUNA_ACCURACY_TRANSPORT_POLICY.version,
    policyHash: contentHash(LUNA_ACCURACY_TRANSPORT_POLICY),
    endpoint: LUNA_ACCURACY_TRANSPORT_POLICY.endpoint,
    requestedModel: LUNA_ACCURACY_TRANSPORT_POLICY.requestedModel,
    expectedCanonicalModel:
      LUNA_ACCURACY_TRANSPORT_POLICY.expectedCanonicalModel,
    expectedProviderName:
      LUNA_ACCURACY_TRANSPORT_POLICY.expectedProviderName,
    ...(manifest.transport.catalogPreflight !== undefined
      ? {
          catalogPreflight: manifest.transport.catalogPreflight,
          catalogPreflightHash:
            contentHash(manifest.transport.catalogPreflight),
        }
      : {}),
  };
  if (contentHash(manifest.transport) !== contentHash(expectedTransport)) {
    throw new Error(
      "Luna accuracy run manifest uses an unpinned or changed transport policy",
    );
  }
  if (
    !Number.isInteger(manifest.scheduleSeed) ||
    manifest.scheduleSeed < 0 ||
    manifest.scheduleSeed > 0xffff_ffff ||
    !Array.isArray(manifest.arms) ||
    !manifest.arms.length
  ) {
    throw new Error("Invalid Luna accuracy manifest configuration");
  }
  if (
    (input.episodes !== undefined &&
      (manifest.hashes.runtimeEpisodes !==
        lunaAccuracyRuntimeEpisodesHash(input.episodes) ||
        manifest.counts.cases !== input.episodes.length)) ||
    manifest.hashes.arms !== contentHash(manifest.arms) ||
    manifest.counts.experimentArms !== manifest.arms.length
  ) {
    throw new Error(
      "Luna accuracy run manifest does not match the supplied runtime dataset",
    );
  }
  if (
    input.profile !== undefined &&
    manifest.hashes.profile !== lunaAccuracyProfileHash(input.profile)
  ) {
    throw new Error(
      "Luna accuracy run manifest does not match the repository profile",
    );
  }
  if (
    input.cards !== undefined &&
    manifest.hashes.registry !==
      lunaAccuracyAreaRegistryHash(input.cards)
  ) {
    throw new Error(
      "Luna accuracy run manifest does not match the Area Registry",
    );
  }
  if (input.arms !== undefined && input.matrix === undefined) {
    throw new Error(
      "Luna accuracy manifest arm validation requires the matrix",
    );
  }
  if (input.matrix !== undefined) {
    validateLunaAccuracyMatrixV2(input.matrix);
    const normalizedArms = normalizeLunaAccuracyArms(
      input.matrix,
      input.arms,
    );
    const schedule = buildLunaAccuracyJobSchedule({
      matrix: input.matrix,
      episodes: input.episodes ??
        Array.from(
          { length: manifest.counts.cases },
          (_, index) =>
            ({
              id: `manifest-placeholder-${index}`,
            }) as TaskEpisode,
        ),
      arms: normalizedArms,
      scheduleSeed: manifest.scheduleSeed,
    });
    const expectedCalls = schedule.reduce(
      (sum, job) => sum + expectedStages(job.architecture).length,
      0,
    );
    if (
      manifest.hashes.matrix !== lunaAccuracyMatrixHash(input.matrix) ||
      manifest.hashes.arms !==
        lunaAccuracyArmsHash(input.matrix, normalizedArms) ||
      contentHash(manifest.arms) !== contentHash(normalizedArms) ||
      manifest.counts.contextVariants !== input.matrix.variants.length ||
      manifest.counts.pipelineJobs !== schedule.length ||
      manifest.counts.expectedCalls !== expectedCalls
    ) {
      throw new Error(
        "Luna accuracy run manifest does not match the supplied matrix or arms",
      );
    }
  }
  const expectedInputHash = contentHash({
    runnerVersion: LUNA_ACCURACY_RUNNER_VERSION,
    model: manifest.model,
    transport: manifest.transport,
    hashes: manifest.hashes,
  });
  const expectedConfigurationHash = contentHash({
    inputHash: expectedInputHash,
    concurrency: manifest.concurrency,
    scheduleSeed: manifest.scheduleSeed,
    retryPolicy: manifest.retryPolicy,
    arms: manifest.arms,
    expectedCalls: manifest.counts.expectedCalls,
  });
  if (
    manifest.inputHash !== expectedInputHash ||
    manifest.configurationHash !== expectedConfigurationHash
  ) {
    throw new Error("Luna accuracy run manifest hashes are inconsistent");
  }
};

const atomicWrite = async (
  file: string,
  text: string,
  mode = 0o600,
): Promise<void> => {
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(
    directory,
    `.${path.basename(file)}.tmp-${process.pid}-${randomUUID()}`,
  );
  const handle = await open(temporary, "wx", mode);
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  try {
    const directoryHandle = await open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch {
    // Directory fsync is not available on every supported filesystem. The
    // file itself is still synced and atomically renamed.
  }
};

const atomicWriteJson = async (file: string, value: unknown): Promise<void> => {
  await atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
};

const atomicWriteJsonl = async (
  file: string,
  values: readonly unknown[],
): Promise<void> => {
  const text = values.length
    ? `${values.map((value) => JSON.stringify(value)).join("\n")}\n`
    : "";
  await atomicWrite(file, text);
};

const readJson = async (file: string): Promise<unknown> =>
  JSON.parse(await readFile(file, "utf8")) as unknown;

const createOrValidateManifest = async (
  file: string,
  expected: LunaAccuracyRunManifest,
): Promise<LunaAccuracyRunManifest> => {
  try {
    const existing = await readJson(file);
    if (
      !isRecord(existing) ||
      existing.schemaVersion !== 1 ||
      existing.runnerVersion !== LUNA_ACCURACY_RUNNER_VERSION ||
      existing.configurationHash !== expected.configurationHash ||
      existing.inputHash !== expected.inputHash
    ) {
      throw new Error(
        "Existing Luna accuracy run manifest does not match this run",
      );
    }
    return existing as unknown as LunaAccuracyRunManifest;
  } catch (error) {
    if (
      isRecord(error) &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      await atomicWriteJson(file, expected);
      return expected;
    }
    throw error;
  }
};

const callStateFile = (
  callStateDirectory: string,
  callKey: string,
): string => path.join(callStateDirectory, `${sha256(callKey)}.json`);

const validateCallRecordShape: (
  value: unknown,
) => asserts value is LunaAccuracyCallRecord = (value) => {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.runnerVersion !== LUNA_ACCURACY_RUNNER_VERSION ||
    typeof value.key !== "string" ||
    typeof value.jobKey !== "string" ||
    typeof value.inputHash !== "string" ||
    typeof value.promptHash !== "string" ||
    typeof value.armId !== "string" ||
    typeof value.variantId !== "string" ||
    !ARCHITECTURES.has(value.architecture as LunaAccuracyArchitecture) ||
    typeof value.taskEpisodeId !== "string" ||
    !Number.isInteger(value.repetitionIndex) ||
    !Number.isInteger(value.seed) ||
    !STAGES.has(value.stage as LunaAccuracyCallStage) ||
    !Number.isInteger(value.attemptCount) ||
    (value.attemptCount as number) < 1 ||
    typeof value.completedAt !== "string" ||
    !isRecord(value.prediction) ||
    !isRecord(value.transport) ||
    value.transport.policyVersion !==
      LUNA_ACCURACY_TRANSPORT_POLICY.version ||
    typeof value.transport.providerRequestHash !== "string" ||
    !SHA256_HEX.test(value.transport.providerRequestHash) ||
    value.transport.providerName !== LUNA_ACCURACY_PROVIDER ||
    value.transport.responseModel !== LUNA_ACCURACY_MODEL ||
    value.transport.catalogCanonicalModel !== LUNA_ACCURACY_CANONICAL_MODEL
  ) {
    throw new Error("Invalid Luna accuracy call-state record");
  }
};

const loadCallRecords = async (
  callStateDirectory: string,
): Promise<Map<string, LunaAccuracyCallRecord>> => {
  let entries: string[];
  try {
    entries = await readdir(callStateDirectory);
  } catch (error) {
    if (
      isRecord(error) &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return new Map();
    }
    throw error;
  }
  const records = new Map<string, LunaAccuracyCallRecord>();
  for (const entry of entries.sort(lexicalCompare)) {
    if (!entry.endsWith(".json")) continue;
    const file = path.join(callStateDirectory, entry);
    const record = await readJson(file);
    validateCallRecordShape(record);
    if (entry !== `${sha256(record.key)}.json`) {
      throw new Error(`Luna accuracy call-state filename mismatch: ${entry}`);
    }
    if (records.has(record.key)) {
      throw new Error(`Duplicate Luna accuracy call-state key ${record.key}`);
    }
    records.set(record.key, record);
  }
  return records;
};

const publicArchitectureDecision = (
  prediction: ClassifierPredictionV1,
): Record<string, unknown> => ({
  known: prediction.known,
  selected_area_ids: [...prediction.selectedAreaIds],
  unknown_type: prediction.unknownType ?? null,
  confidence: prediction.confidence,
  ranked_candidates: prediction.areaScores.slice(0, 5).map((score) => ({
    area_id: score.areaId,
    score: score.score,
  })),
});

/**
 * Builds the three prompts used by the accuracy-first deliberative
 * architecture. Only structured decisions are carried between stages. Raw
 * reasoning, traces, provider metadata, and task-derived free-form rationale
 * are deliberately excluded.
 */
export const buildLunaAccuracyArchitecturePrompt = (input: {
  base: LunaAccuracyPrompt;
  stage: "proposal" | "verify" | "revise";
  proposal?: ClassifierPredictionV1;
  verification?: ClassifierPredictionV1;
}): LunaAccuracyPrompt => {
  if (input.stage === "proposal") {
    if (input.proposal || input.verification) {
      throw new Error("Proposal prompt cannot include prior decisions");
    }
    return {
      ...input.base,
      system: `${input.base.system}

Architecture stage: proposal.
Independently produce the strongest initial classification. Check all gates and
the closest competing registered areas before returning the requested JSON.`,
      serializationVersion:
        `${input.base.serializationVersion}/pvr/proposal-v1`,
    };
  }
  if (!input.proposal) {
    throw new Error(`${input.stage} prompt requires a proposal`);
  }
  if (input.stage === "verify") {
    if (input.verification) {
      throw new Error("Verify prompt cannot include a later verification");
    }
    return {
      ...input.base,
      system: `${input.base.system}

Architecture stage: adversarial verification.
Treat the supplied proposal as untrusted. Re-solve the classification from the
task-aware context and frozen registry, look specifically for gate, boundary,
unknown-subtype, and multi-area errors, then return your own corrected complete
decision in the requested JSON schema.`,
      user: `${input.base.user}

[UNTRUSTED PROPOSAL — STRUCTURED DECISION ONLY]
${JSON.stringify(publicArchitectureDecision(input.proposal))}`,
      serializationVersion:
        `${input.base.serializationVersion}/pvr/verify-v1`,
    };
  }
  if (!input.verification) {
    throw new Error("Revision prompt requires a verification decision");
  }
  return {
    ...input.base,
    system: `${input.base.system}

Architecture stage: final revision.
Re-solve the task, compare the initial proposal with the independent
verification, and return the best final corrected classification. Do not
compromise between decisions; use the task-aware context and frozen registry as
the source of truth. Return only the requested JSON.`,
    user: `${input.base.user}

[INITIAL PROPOSAL — STRUCTURED DECISION ONLY]
${JSON.stringify(publicArchitectureDecision(input.proposal))}

[ADVERSARIAL VERIFICATION — STRUCTURED DECISION ONLY]
${JSON.stringify(publicArchitectureDecision(input.verification))}`,
    serializationVersion:
      `${input.base.serializationVersion}/pvr/revise-v1`,
  };
};

export class LunaAccuracyTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Luna accuracy call timed out after ${timeoutMs}ms`);
    this.name = "LunaAccuracyTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

const statusFromError = (error: unknown): number | undefined => {
  if (!isRecord(error)) return undefined;
  for (const field of ["status", "statusCode"]) {
    const value = error[field];
    if (typeof value === "number" && Number.isInteger(value)) return value;
  }
  return undefined;
};

const defaultShouldRetry = (error: unknown): boolean => {
  if (
    isRecord(error) &&
    "retryable" in error &&
    error.retryable === false
  ) {
    return false;
  }
  const status = statusFromError(error);
  if (status === undefined) return true;
  if ([408, 409, 425, 429].includes(status)) return true;
  if (status >= 500) return true;
  return false;
};

const retryAfterMsFromError = (error: unknown): number | undefined => {
  if (!isRecord(error)) return undefined;
  const value = error.retryAfterMs;
  return typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0
    ? value
    : undefined;
};

const defaultBackoffMs = (
  context: LunaAccuracyRetryContext,
  policy: LunaAccuracyRetryPolicy,
): number => {
  const base = Math.min(
    policy.maximumBackoffMs,
    policy.initialBackoffMs *
      policy.backoffMultiplier ** Math.max(0, context.attempt - 1),
  );
  if (base === 0 || policy.jitterFraction === 0) return Math.round(base);
  const random = seededRandom(
    uint32FromHash({
      jobKey: context.job.key,
      stage: context.stage,
      attempt: context.attempt,
      purpose: "retry-jitter",
    }),
  )();
  const multiplier =
    1 - policy.jitterFraction + random * policy.jitterFraction * 2;
  return Math.max(0, Math.round(base * multiplier));
};

const withTimeout = async <T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> => {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeoutError = new LunaAccuracyTimeoutError(timeoutMs);
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

export const executeLunaAccuracyCallWithRetry = async (input: {
  executor: LunaAccuracyCallExecutor;
  executorInput: Omit<
    LunaAccuracyExecutorInput,
    "attempt" | "signal"
  >;
  job: LunaAccuracyPipelineJob;
  stage: LunaAccuracyCallStage;
  promptHash: string;
  retryPolicy?: Partial<LunaAccuracyRetryPolicy>;
  hooks?: LunaAccuracyRunnerHooks;
}): Promise<{
  prediction: ClassifierPredictionV1;
  metadata?: LunaAccuracyCallMetadata;
  attempts: number;
}> => {
  const policy = normalizeLunaAccuracyRetryPolicy(input.retryPolicy);
  const sleep = input.hooks?.sleep ?? defaultSleep;
  let lastError: unknown;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    const context: LunaAccuracyRetryContext = {
      job: input.job,
      stage: input.stage,
      attempt,
      maximumAttempts: policy.maxAttempts,
    };
    await input.hooks?.onAttempt?.({
      ...context,
      promptHash: input.promptHash,
    });
    try {
      const result = await withTimeout(policy.timeoutMs, async (signal) =>
        input.executor({
          ...input.executorInput,
          attempt,
          signal,
        })
      );
      const prediction = (
          isRecord(result) &&
          "prediction" in result &&
          isRecord(result.prediction)
        )
        ? result.prediction as unknown as ClassifierPredictionV1
        : result as ClassifierPredictionV1;
      const metadata = (
          isRecord(result) &&
          "prediction" in result &&
          "metadata" in result &&
          isRecord(result.metadata)
        )
        ? result.metadata as unknown as LunaAccuracyCallMetadata
        : undefined;
      validatePrediction(
        prediction,
        input.executorInput.taskEpisodeId,
        input.executorInput.allowedAreaIds,
      );
      return {
        prediction: clonePrediction(
          prediction,
          input.executorInput.classifierLabel,
        ),
        ...(metadata ? { metadata } : {}),
        attempts: attempt,
      };
    } catch (error) {
      lastError = error;
      const retry =
        attempt < policy.maxAttempts &&
        (
          input.hooks?.shouldRetry?.(error, context) ??
            defaultShouldRetry(error)
      );
      if (!retry) throw error;
      const backoffMs =
        input.hooks?.backoffMs?.(context, policy) ??
          defaultBackoffMs(context, policy);
      const milliseconds = Math.min(
        policy.maximumBackoffMs,
        Math.max(
          0,
          Math.round(
            Math.max(backoffMs, retryAfterMsFromError(error) ?? 0),
          ),
        ),
      );
      await sleep(milliseconds);
    }
  }
  throw lastError;
};

export const aggregateLunaAccuracySelfConsistency3 = (
  predictions: readonly ClassifierPredictionV1[],
  classifierLabel = "luna-accuracy:self-consistency-3",
): ClassifierPredictionV1 => {
  if (predictions.length !== 3) {
    throw new Error("Luna self-consistency aggregation requires three calls");
  }
  const taskEpisodeId = predictions[0]!.taskEpisodeId;
  if (
    predictions.some(
      (prediction) => prediction.taskEpisodeId !== taskEpisodeId,
    )
  ) {
    throw new Error("Luna self-consistency calls must belong to one case");
  }
  const byDecision = new Map<
    string,
    { predictions: ClassifierPredictionV1[]; averageConfidence: number }
  >();
  for (const prediction of predictions) {
    const key = decisionKey(prediction);
    const group = byDecision.get(key)?.predictions ?? [];
    group.push(prediction);
    byDecision.set(key, {
      predictions: group,
      averageConfidence:
        group.reduce((sum, item) => sum + item.confidence, 0) /
        group.length,
    });
  }
  const winner = [...byDecision.entries()].sort(
    ([leftKey, left], [rightKey, right]) =>
      right.predictions.length - left.predictions.length ||
      right.averageConfidence - left.averageConfidence ||
      lexicalCompare(leftKey, rightKey),
  )[0]![1];
  const representative = [...winner.predictions].sort(
    (left, right) =>
      right.confidence - left.confidence ||
      lexicalCompare(left.classifier, right.classifier),
  )[0]!;
  const voteShare = winner.predictions.length / predictions.length;
  const inputCharacters = numericTotal(predictions, "inputCharacters");
  const inputTokens = numericTotal(predictions, "inputTokens");
  const cachedInputTokens = numericTotal(predictions, "cachedInputTokens");
  const outputTokens = numericTotal(predictions, "outputTokens");
  const reasoningOutputTokens = numericTotal(
    predictions,
    "reasoningOutputTokens",
  );
  const costUsd = numericTotal(predictions, "costUsd");
  return {
    ...clonePrediction(representative),
    classifier: classifierLabel,
    confidence: Math.min(1, winner.averageConfidence * voteShare),
    durationMs: Math.max(
      ...predictions.map((prediction) => prediction.durationMs),
    ),
    ...(inputCharacters !== undefined ? { inputCharacters } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined
      ? { reasoningOutputTokens }
      : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
};

export const combineLunaAccuracyProposalVerifyRevise = (
  proposal: ClassifierPredictionV1,
  verification: ClassifierPredictionV1,
  revision: ClassifierPredictionV1,
  classifierLabel = "luna-accuracy:proposal-verify-revise",
): ClassifierPredictionV1 => {
  const predictions = [proposal, verification, revision];
  if (
    predictions.some(
      (prediction) =>
        prediction.taskEpisodeId !== revision.taskEpisodeId,
    )
  ) {
    throw new Error("Luna deliberation stages must belong to one case");
  }
  const inputCharacters = numericTotal(predictions, "inputCharacters");
  const inputTokens = numericTotal(predictions, "inputTokens");
  const cachedInputTokens = numericTotal(predictions, "cachedInputTokens");
  const outputTokens = numericTotal(predictions, "outputTokens");
  const reasoningOutputTokens = numericTotal(
    predictions,
    "reasoningOutputTokens",
  );
  const costUsd = numericTotal(predictions, "costUsd");
  return {
    ...clonePrediction(revision),
    classifier: classifierLabel,
    durationMs: predictions.reduce(
      (sum, prediction) => sum + prediction.durationMs,
      0,
    ),
    ...(inputCharacters !== undefined ? { inputCharacters } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined
      ? { reasoningOutputTokens }
      : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
};

const expectedCallMetadata = (
  schedule: readonly LunaAccuracyPipelineJob[],
): Map<
  string,
  { job: LunaAccuracyPipelineJob; stage: LunaAccuracyCallStage }
> => {
  const expected = new Map<
    string,
    { job: LunaAccuracyPipelineJob; stage: LunaAccuracyCallStage }
  >();
  for (const job of schedule) {
    for (const stage of expectedStages(job.architecture)) {
      const key = lunaAccuracyCallKey(job, stage);
      if (expected.has(key)) {
        throw new Error(`Duplicate expected Luna accuracy call key ${key}`);
      }
      expected.set(key, { job, stage });
    }
  }
  return expected;
};

const assertRecordMetadata = (
  record: LunaAccuracyCallRecord,
  expected: {
    job: LunaAccuracyPipelineJob;
    stage: LunaAccuracyCallStage;
  },
  inputHash: string,
  allowedAreaIds: readonly string[],
): void => {
  const { job, stage } = expected;
  if (
    record.key !== lunaAccuracyCallKey(job, stage) ||
    record.jobKey !== job.key ||
    record.inputHash !== inputHash ||
    record.armId !== job.armId ||
    record.variantId !== job.variantId ||
    record.architecture !== job.architecture ||
    record.taskEpisodeId !== job.taskEpisodeId ||
    record.repetitionIndex !== job.repetitionIndex ||
    record.seed !== job.seed ||
    record.stage !== stage
  ) {
    throw new Error(`Stale or mismatched Luna accuracy call state ${record.key}`);
  }
  validatePrediction(record.prediction, job.taskEpisodeId, allowedAreaIds);
};

export const assertLunaAccuracyRunComplete = (input: {
  records: readonly LunaAccuracyCallRecord[];
  schedule: readonly LunaAccuracyPipelineJob[];
  inputHash: string;
  allowedAreaIds: readonly string[];
}): void => {
  const expected = expectedCallMetadata(input.schedule);
  const seen = new Set<string>();
  for (const record of input.records) {
    if (seen.has(record.key)) {
      throw new Error(`Duplicate completed Luna accuracy call ${record.key}`);
    }
    seen.add(record.key);
    const metadata = expected.get(record.key);
    if (!metadata) {
      throw new Error(`Unexpected completed Luna accuracy call ${record.key}`);
    }
    assertRecordMetadata(
      record,
      metadata,
      input.inputHash,
      input.allowedAreaIds,
    );
  }
  for (const key of expected.keys()) {
    if (!seen.has(key)) {
      throw new Error(`Missing completed Luna accuracy call ${key}`);
    }
  }
};

const exactCaseSet = (
  predictions: readonly ClassifierPredictionV1[],
  expectedCaseIds: readonly string[],
  label: string,
): void => {
  const ids = predictions.map((prediction) => prediction.taskEpisodeId);
  const expected = [...expectedCaseIds].sort(lexicalCompare);
  const actual = [...ids].sort(lexicalCompare);
  if (
    new Set(ids).size !== ids.length ||
    actual.length !== expected.length ||
    actual.some((id, index) => id !== expected[index])
  ) {
    throw new Error(
      `Luna accuracy prediction set ${label} is not a complete exact case set`,
    );
  }
};

export const buildLunaAccuracyPredictionSets = (input: {
  records: readonly LunaAccuracyCallRecord[];
  episodes: readonly TaskEpisode[];
  matrix: LunaAccuracyMatrixV2;
  arms?: readonly LunaAccuracyExperimentArm[];
}): LunaAccuracyPredictionSet[] => {
  const arms = normalizeLunaAccuracyArms(input.matrix, input.arms);
  const variants = new Map(
    input.matrix.variants.map((variant) => [variant.id, variant]),
  );
  const expectedCaseIds = input.episodes.map((episode) => episode.id);
  const recordFor = (
    armId: string,
    caseId: string,
    repetitionIndex: number,
    stage: LunaAccuracyCallStage,
  ): LunaAccuracyCallRecord => {
    const matches = input.records.filter(
      (record) =>
        record.armId === armId &&
        record.taskEpisodeId === caseId &&
        record.repetitionIndex === repetitionIndex &&
        record.stage === stage,
    );
    if (matches.length !== 1) {
      throw new Error(
        `Expected one ${stage} call for ${armId}/${caseId}/${repetitionIndex}`,
      );
    }
    return matches[0]!;
  };

  const sets: LunaAccuracyPredictionSet[] = [];
  for (const arm of arms) {
    const variant = variants.get(arm.variantId)!;
    if (arm.architecture === "self_consistency_3") {
      const predictions = [...expectedCaseIds]
        .sort(lexicalCompare)
        .map((caseId) =>
          aggregateLunaAccuracySelfConsistency3(
            [0, 1, 2].map(
              (repetitionIndex) =>
                recordFor(
                  arm.id,
                  caseId,
                  repetitionIndex,
                  "member",
                ).prediction,
            ),
            `llm:accuracy:${arm.id}:self-consistency-3`,
          )
        );
      exactCaseSet(predictions, expectedCaseIds, arm.id);
      sets.push({
        id: `${arm.id}:ensemble`,
        armId: arm.id,
        variantId: arm.variantId,
        architecture: arm.architecture,
        repetitionIndex: null,
        seeds: variant.fixedSeedList.slice(0, 3),
        predictions,
      });
      continue;
    }
    for (
      let repetitionIndex = 0;
      repetitionIndex < variant.repetitions;
      repetitionIndex += 1
    ) {
      const predictions = [...expectedCaseIds]
        .sort(lexicalCompare)
        .map((caseId) => {
          if (arm.architecture === "single_call") {
            return clonePrediction(
              recordFor(
                arm.id,
                caseId,
                repetitionIndex,
                "single",
              ).prediction,
            );
          }
          return combineLunaAccuracyProposalVerifyRevise(
            recordFor(
              arm.id,
              caseId,
              repetitionIndex,
              "proposal",
            ).prediction,
            recordFor(
              arm.id,
              caseId,
              repetitionIndex,
              "verify",
            ).prediction,
            recordFor(
              arm.id,
              caseId,
              repetitionIndex,
              "revise",
            ).prediction,
            `llm:accuracy:${arm.id}:proposal-verify-revise`,
          );
        });
      exactCaseSet(
        predictions,
        expectedCaseIds,
        `${arm.id}:repeat-${repetitionIndex + 1}`,
      );
      sets.push({
        id: `${arm.id}:repeat-${repetitionIndex + 1}`,
        armId: arm.id,
        variantId: arm.variantId,
        architecture: arm.architecture,
        repetitionIndex,
        seeds: [getLunaAccuracyRepetitionSeed(variant, repetitionIndex)],
        predictions,
      });
    }
  }
  return sets;
};

const safeFilename = (value: string): string => {
  if (!safeId.test(value)) {
    throw new Error(`Unsafe Luna accuracy artifact ID ${value}`);
  }
  return value;
};

const canonicalCompletedCalls = (
  records: readonly LunaAccuracyCallRecord[],
): LunaAccuracyCallRecord[] =>
  [...records].sort(
    (left, right) =>
      lexicalCompare(left.armId, right.armId) ||
      lexicalCompare(left.taskEpisodeId, right.taskEpisodeId) ||
      left.repetitionIndex - right.repetitionIndex ||
      lexicalCompare(left.stage, right.stage),
  );

const canonicalPredictionSets = (
  predictionSets: readonly LunaAccuracyPredictionSet[],
): LunaAccuracyPredictionSet[] =>
  predictionSets.map((predictionSet) => ({
    ...predictionSet,
    seeds: [...predictionSet.seeds],
    predictions: [...predictionSet.predictions].sort((left, right) =>
      lexicalCompare(left.taskEpisodeId, right.taskEpisodeId)
    ),
  }));

const completedAtFromCalls = (
  records: readonly LunaAccuracyCallRecord[],
): string => {
  if (records.length === 0) {
    throw new Error("Cannot finalize a Luna accuracy run without calls");
  }
  let latest = records[0]!.completedAt;
  let latestTime = Date.parse(latest);
  if (!Number.isFinite(latestTime)) {
    throw new Error("Invalid Luna accuracy call completion time");
  }
  for (const record of records.slice(1)) {
    const time = Date.parse(record.completedAt);
    if (!Number.isFinite(time)) {
      throw new Error("Invalid Luna accuracy call completion time");
    }
    if (time > latestTime || (time === latestTime && record.completedAt > latest)) {
      latest = record.completedAt;
      latestTime = time;
    }
  }
  return latest;
};

const buildLunaAccuracyRunSummary = (input: {
  manifest: LunaAccuracyRunManifest;
  completed: readonly LunaAccuracyCallRecord[];
  predictionSets: readonly LunaAccuracyPredictionSet[];
}): LunaAccuracyRunSummary => ({
  schemaVersion: 1,
  runnerVersion: LUNA_ACCURACY_RUNNER_VERSION,
  completedAt: completedAtFromCalls(input.completed),
  configurationHash: input.manifest.configurationHash,
  inputHash: input.manifest.inputHash,
  concurrency: input.manifest.concurrency,
  cases: input.manifest.counts.cases,
  arms: input.manifest.counts.experimentArms,
  pipelineJobs: input.manifest.counts.pipelineJobs,
  completedCalls: input.completed.length,
  predictionSets: input.predictionSets.map((predictionSet) => ({
    id: predictionSet.id,
    armId: predictionSet.armId,
    architecture: predictionSet.architecture,
    repetitionIndex: predictionSet.repetitionIndex,
    seeds: [...predictionSet.seeds],
    predictions: predictionSet.predictions.length,
  })),
});

const buildLunaAccuracyRunFinalization = (input: {
  manifest: LunaAccuracyRunManifest;
  completed: readonly LunaAccuracyCallRecord[];
  predictionSets: readonly LunaAccuracyPredictionSet[];
  summary: LunaAccuracyRunSummary;
}): LunaAccuracyRunFinalization => ({
  schemaVersion: 1,
  finalizationVersion: LUNA_ACCURACY_FINALIZATION_VERSION,
  completedAt: input.summary.completedAt,
  configurationHash: input.manifest.configurationHash,
  inputHash: input.manifest.inputHash,
  transportPolicyHash: input.manifest.transport.policyHash,
  completedCalls: {
    count: input.completed.length,
    hash: contentHash(input.completed),
  },
  predictionSets: {
    count: input.predictionSets.length,
    hash: contentHash(input.predictionSets),
  },
  summaryHash: contentHash(input.summary),
});

export const runLunaAccuracyExperiment = async (
  input: RunLunaAccuracyExperimentInput,
): Promise<LunaAccuracyRunResult> => {
  const now = input.hooks?.now ?? (() => new Date().toISOString());
  const arms = normalizeLunaAccuracyArms(input.matrix, input.arms);
  const concurrency = normalizeLunaAccuracyConcurrency(input.concurrency);
  const retryPolicy = normalizeLunaAccuracyRetryPolicy(input.retryPolicy);
  const scheduleSeed = input.scheduleSeed ?? 19_871;
  const expectedManifest = buildLunaAccuracyRunManifest({
    model: input.model,
    profile: input.profile,
    cards: input.cards,
    episodes: input.episodes,
    matrix: input.matrix,
    arms,
    concurrency,
    scheduleSeed,
    retryPolicy,
    ...(input.transportPreflight
      ? { transportPreflight: input.transportPreflight }
      : {}),
    createdAt: now(),
  });
  const schedule = buildLunaAccuracyJobSchedule({
    matrix: input.matrix,
    episodes: input.episodes,
    arms,
    scheduleSeed,
  });
  const manifestPath = path.join(input.runDirectory, "manifest.lock.json");
  const callStateDirectory = path.join(
    input.runDirectory,
    "private",
    "call-state",
  );
  const callsJsonl = path.join(
    input.runDirectory,
    "private",
    "completed-calls.jsonl",
  );
  const predictionSetsDirectory = path.join(
    input.runDirectory,
    "private",
    "prediction-sets",
  );
  const summaryPath = path.join(input.runDirectory, "summary.json");
  const finalizationPath = path.join(
    input.runDirectory,
    "finalization.json",
  );
  await mkdir(input.runDirectory, { recursive: true, mode: 0o700 });
  const manifest = await createOrValidateManifest(
    manifestPath,
    expectedManifest,
  );
  const allowedAreaIds = input.cards.map((card) => card.areaId);
  const expected = expectedCallMetadata(schedule);
  const records = await loadCallRecords(callStateDirectory);
  for (const record of records.values()) {
    const metadata = expected.get(record.key);
    if (!metadata) {
      throw new Error(`Unexpected Luna accuracy call state ${record.key}`);
    }
    assertRecordMetadata(
      record,
      metadata,
      manifest.inputHash,
      allowedAreaIds,
    );
  }

  const variants = new Map(
    input.matrix.variants.map((variant) => [variant.id, variant]),
  );
  const episodes = new Map(
    input.episodes.map((episode) => [episode.id, episode]),
  );
  let executedCalls = 0;
  let resumedCalls = 0;
  let attempts = 0;

  const executeOrReuse = async (
    job: LunaAccuracyPipelineJob,
    stage: LunaAccuracyCallStage,
    prompt: LunaAccuracyPrompt,
    variant: LunaAccuracyVariantV2,
  ): Promise<LunaAccuracyCallRecord> => {
    const key = lunaAccuracyCallKey(job, stage);
    const promptHash = contentHash(prompt);
    const providerRequestHash = contentHash(
      buildLunaAccuracyProviderRequest({
        model: input.model,
        prompt,
        variant,
        allowedAreaIds,
        stage: stage === "single" || stage === "member"
          ? "classify"
          : stage,
        seed: job.seed,
      }),
    );
    const prior = records.get(key);
    if (prior) {
      assertRecordMetadata(
        prior,
        { job, stage },
        manifest.inputHash,
        allowedAreaIds,
      );
      if (prior.promptHash !== promptHash) {
        throw new Error(
          `Luna accuracy prompt changed for completed call ${key}`,
        );
      }
      if (
        prior.transport.policyVersion !==
          LUNA_ACCURACY_TRANSPORT_POLICY.version ||
        prior.transport.providerRequestHash !== providerRequestHash ||
        prior.transport.providerName !== LUNA_ACCURACY_PROVIDER ||
        prior.transport.responseModel !== LUNA_ACCURACY_MODEL ||
        prior.transport.catalogCanonicalModel !==
          LUNA_ACCURACY_CANONICAL_MODEL
      ) {
        throw new Error(
          `Luna accuracy transport changed for completed call ${key}`,
        );
      }
      resumedCalls += 1;
      return prior;
    }
    const classifierLabel = [
      "llm",
      input.model,
      "accuracy",
      job.armId,
      stage,
      `repeat-${job.repetitionIndex + 1}`,
    ].join(":");
    const executed = await executeLunaAccuracyCallWithRetry({
      executor: input.executor,
      executorInput: {
        model: input.model,
        taskEpisodeId: job.taskEpisodeId,
        armId: job.armId,
        variantId: job.variantId,
        architecture: job.architecture,
        stage,
        repetitionIndex: job.repetitionIndex,
        seed: job.seed,
        prompt,
        variant,
        allowedAreaIds,
        classifierLabel,
      },
      job,
      stage,
      promptHash,
      retryPolicy,
      ...(input.hooks ? { hooks: input.hooks } : {}),
    });
    const record: LunaAccuracyCallRecord = {
      schemaVersion: 1,
      runnerVersion: LUNA_ACCURACY_RUNNER_VERSION,
      key,
      jobKey: job.key,
      inputHash: manifest.inputHash,
      promptHash,
      armId: job.armId,
      variantId: job.variantId,
      architecture: job.architecture,
      taskEpisodeId: job.taskEpisodeId,
      repetitionIndex: job.repetitionIndex,
      seed: job.seed,
      stage,
      attemptCount: executed.attempts,
      completedAt: now(),
      prediction: executed.prediction,
      transport: persistedTransportMetadata(
        executed.metadata,
        providerRequestHash,
      ),
    };
    const stateFile = callStateFile(callStateDirectory, key);
    await atomicWriteJson(stateFile, record);
    records.set(key, record);
    executedCalls += 1;
    attempts += executed.attempts;
    return record;
  };

  const executeJob = async (job: LunaAccuracyPipelineJob): Promise<void> => {
    const episode = episodes.get(job.taskEpisodeId);
    const variant = variants.get(job.variantId);
    if (!episode || !variant) {
      throw new Error(`Invalid scheduled Luna accuracy job ${job.key}`);
    }
    const base = buildLunaAccuracyPrompt({
      episode,
      profile: input.profile,
      cards: input.cards,
      variant,
      repetitionIndex: job.repetitionIndex,
    });
    if (job.architecture === "single_call") {
      await executeOrReuse(job, "single", base, variant);
      return;
    }
    if (job.architecture === "self_consistency_3") {
      await executeOrReuse(job, "member", base, variant);
      return;
    }
    const proposal = await executeOrReuse(
      job,
      "proposal",
      buildLunaAccuracyArchitecturePrompt({
        base,
        stage: "proposal",
      }),
      variant,
    );
    const verification = await executeOrReuse(
      job,
      "verify",
      buildLunaAccuracyArchitecturePrompt({
        base,
        stage: "verify",
        proposal: proposal.prediction,
      }),
      variant,
    );
    await executeOrReuse(
      job,
      "revise",
      buildLunaAccuracyArchitecturePrompt({
        base,
        stage: "revise",
        proposal: proposal.prediction,
        verification: verification.prediction,
      }),
      variant,
    );
  };

  let nextJobIndex = 0;
  let firstJobError: unknown;
  const worker = async (): Promise<void> => {
    while (firstJobError === undefined) {
      const jobIndex = nextJobIndex;
      nextJobIndex += 1;
      const job = schedule[jobIndex];
      if (!job) return;
      try {
        await executeJob(job);
      } catch (error) {
        if (firstJobError === undefined) firstJobError = error;
        return;
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, schedule.length) },
      () => worker(),
    ),
  );
  if (firstJobError !== undefined) {
    throw firstJobError;
  }

  const completed = canonicalCompletedCalls([...records.values()]);
  assertLunaAccuracyRunComplete({
    records: completed,
    schedule,
    inputHash: manifest.inputHash,
    allowedAreaIds,
  });
  const predictionSets = canonicalPredictionSets(
    buildLunaAccuracyPredictionSets({
      records: completed,
      episodes: input.episodes,
      matrix: input.matrix,
      arms,
    }),
  );
  const summary = buildLunaAccuracyRunSummary({
    manifest,
    completed,
    predictionSets,
  });
  const finalization = buildLunaAccuracyRunFinalization({
    manifest,
    completed,
    predictionSets,
    summary,
  });

  await atomicWriteJsonl(callsJsonl, completed);
  await rm(predictionSetsDirectory, { recursive: true, force: true });
  for (const predictionSet of predictionSets) {
    const filename = `${safeFilename(predictionSet.armId)}-${
      predictionSet.repetitionIndex === null
        ? "ensemble"
        : `repeat-${predictionSet.repetitionIndex + 1}`
    }.jsonl`;
    await atomicWriteJsonl(
      path.join(predictionSetsDirectory, filename),
      predictionSet.predictions,
    );
  }
  await atomicWriteJson(summaryPath, summary);
  // Commit marker is deliberately written last. A missing or corrupt marker
  // means aggregate artifacts must be deterministically rebuilt from call
  // state; it never authorizes another hosted call.
  await atomicWriteJson(finalizationPath, finalization);

  // Recheck private artifact permissions so a permissive pre-existing
  // directory cannot silently expose task data.
  const predictionSetFiles = await readdir(predictionSetsDirectory);
  for (const file of [
    callsJsonl,
    ...completed.map((record) =>
      callStateFile(callStateDirectory, record.key)
    ),
    ...predictionSetFiles.map((entry) =>
      path.join(predictionSetsDirectory, entry)
    ),
  ]) {
    const information = await stat(file);
    if ((information.mode & 0o077) !== 0) {
      throw new Error(`Luna accuracy private artifact is too permissive: ${file}`);
    }
  }

  return {
    manifest,
    schedule,
    callRecords: completed,
    predictionSets,
    executedCalls,
    resumedCalls,
    attempts,
    paths: {
      manifest: manifestPath,
      callStateDirectory,
      callsJsonl,
      predictionSetsDirectory,
      summary: summaryPath,
      finalization: finalizationPath,
    },
  };
};
