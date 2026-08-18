import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { BudgetLedger } from "./budget.ts";
import { estimateTokens, maximumCallCost, type ModelPrice } from "./cost.ts";
import {
  buildLunaAccuracyPrompt,
  validateLunaAccuracyMatrixV2,
  type LunaAccuracyMatrixV2,
} from "./luna-accuracy-context.ts";
import {
  assertLunaAccuracyTreatmentsDistinct,
  auditLunaAccuracyTreatmentDistinctness,
  type LunaAccuracyTreatmentDistinctnessAudit,
} from "./luna-accuracy-distinctness.ts";
import {
  assertLunaAccuracyFreezeInputs,
  validateLunaAccuracyFreezeRecord,
  type LunaAccuracyFreezeRecord,
} from "./luna-accuracy-design.ts";
import { contentHash } from "./hash.ts";
import {
  preflightLunaAccuracyOpenRouter,
  type LunaAccuracyOpenRouterPreflight,
} from "./luna-accuracy-openrouter.ts";
import {
  buildLunaAccuracyJobSchedule,
  buildLunaAccuracyRunManifest,
  normalizeLunaAccuracyArms,
  normalizeLunaAccuracyConcurrency,
  runLunaAccuracyExperiment,
  type LunaAccuracyCallExecutor,
  type LunaAccuracyCallRecord,
  type LunaAccuracyExperimentArm,
  type LunaAccuracyRunResult,
  type LunaAccuracyRetryPolicy,
  type LunaAccuracyRunManifest,
  type LunaAccuracyRunnerHooks,
} from "./luna-accuracy-runner.ts";
import type {
  AreaCardV1,
  RepositoryProfileV1,
  TaskEpisode,
} from "./types.ts";
import {
  validateAreaCards,
  validateEpisodes,
  validateRepositoryProfile,
} from "./validation.ts";

export const LUNA_ACCURACY_WORKFLOW_MODEL =
  "openai/gpt-5.6-luna" as const;

/**
 * Covers JSON-schema/messages/request framing that is not represented in the
 * prompt strings. Proposal/verification stages receive additional bounded
 * structured decisions, accounted for separately below.
 */
export const LUNA_ACCURACY_REQUEST_OVERHEAD_TOKENS = 2_000 as const;
export const LUNA_ACCURACY_VERIFY_PRIOR_TOKENS = 1_000 as const;
export const LUNA_ACCURACY_REVISE_PRIOR_TOKENS = 2_000 as const;

export type LunaAccuracyDatasetRole =
  | "burned_development"
  | "validation"
  | "locked_test";

export interface LunaAccuracyArmCostPlan {
  armId: string;
  variantId: string;
  architecture: LunaAccuracyExperimentArm["architecture"];
  pipelineJobs: number;
  calls: number;
  estimatedInputTokens: number;
  reservedOutputTokens: number;
  projectedMaximumCostUsd: number;
}

export interface LunaAccuracyCostPlan {
  schemaVersion: 1;
  model: typeof LUNA_ACCURACY_WORKFLOW_MODEL;
  cases: number;
  variants: number;
  arms: number;
  concurrency: number;
  pipelineJobs: number;
  calls: number;
  estimatedInputTokens: number;
  reservedOutputTokens: number;
  projectedMaximumCostUsd: number;
  price: {
    promptUsdPerToken: number;
    completionUsdPerToken: number;
    contextLength: number;
  };
  byArm: LunaAccuracyArmCostPlan[];
  assumptions: {
    requestOverheadTokensPerCall: number;
    verifierPriorTokens: number;
    revisionPriorTokens: number;
    latestRequestOnlySupported: false;
  };
  warnings: string[];
}

const stageCount = (
  architecture: LunaAccuracyExperimentArm["architecture"],
): number => architecture === "proposal_verify_revise" ? 3 : 1;

const assertModel = (model: string): void => {
  if (model !== LUNA_ACCURACY_WORKFLOW_MODEL) {
    throw new Error(
      `Luna accuracy workflow requires ${LUNA_ACCURACY_WORKFLOW_MODEL}`,
    );
  }
};

export const validateLunaAccuracyDatasetRole = (
  episodes: readonly TaskEpisode[],
  role: LunaAccuracyDatasetRole,
  freeze?: LunaAccuracyFreezeRecord,
): void => {
  if (!episodes.length) {
    throw new Error("Luna accuracy workflow requires at least one episode");
  }
  if (role === "validation") {
    if (episodes.some((episode) => episode.split !== "validation")) {
      throw new Error(
        "Validation selection may contain only validation episodes",
      );
    }
    if (freeze !== undefined) {
      throw new Error("Validation selection must not use a locked-test freeze");
    }
    return;
  }
  if (role === "locked_test") {
    if (episodes.some((episode) => episode.split !== "test")) {
      throw new Error("Locked-test evaluation may contain only test episodes");
    }
    if (!freeze) {
      throw new Error(
        "Locked-test evaluation requires a complete freeze record",
      );
    }
    validateLunaAccuracyFreezeRecord(freeze);
    return;
  }
  if (freeze !== undefined) {
    throw new Error("Burned development runs must not use a test freeze");
  }
  if (episodes.some((episode) => episode.split === "reference")) {
    throw new Error(
      "Burned development evaluation cannot include reference examples",
    );
  }
};

export const planLunaAccuracyWorkflow = (input: {
  model: string;
  profile: RepositoryProfileV1;
  cards: AreaCardV1[];
  episodes: TaskEpisode[];
  matrix: LunaAccuracyMatrixV2;
  price: ModelPrice;
  arms?: LunaAccuracyExperimentArm[];
  concurrency?: number;
  scheduleSeed?: number;
  datasetRole?: LunaAccuracyDatasetRole;
  freeze?: LunaAccuracyFreezeRecord;
}): LunaAccuracyCostPlan => {
  assertModel(input.model);
  if (input.price.id !== input.model) {
    throw new Error("Luna accuracy price does not match the fixed model");
  }
  validateRepositoryProfile(input.profile);
  validateAreaCards(input.cards, input.profile);
  validateEpisodes(input.episodes, input.cards);
  validateLunaAccuracyMatrixV2(input.matrix);
  validateLunaAccuracyDatasetRole(
    input.episodes,
    input.datasetRole ?? "validation",
    input.freeze,
  );
  if (input.datasetRole === "locked_test" && input.freeze) {
    assertLunaAccuracyFreezeInputs({
      freeze: input.freeze,
      model: input.model,
      profile: input.profile,
      cards: input.cards,
      episodes: input.episodes,
      matrix: input.matrix,
      ...(input.arms ? { arms: input.arms } : {}),
    });
  }
  const arms = normalizeLunaAccuracyArms(input.matrix, input.arms);
  const concurrency = normalizeLunaAccuracyConcurrency(input.concurrency);
  const schedule = buildLunaAccuracyJobSchedule({
    matrix: input.matrix,
    episodes: input.episodes,
    arms,
    ...(input.scheduleSeed === undefined
      ? {}
      : { scheduleSeed: input.scheduleSeed }),
  });
  const variants = new Map(
    input.matrix.variants.map((variant) => [variant.id, variant]),
  );
  const episodes = new Map(
    input.episodes.map((episode) => [episode.id, episode]),
  );
  const armPlans = new Map<
    string,
    Omit<LunaAccuracyArmCostPlan, "projectedMaximumCostUsd">
  >();
  let maximumEstimatedCallTokens = 0;
  for (const job of schedule) {
    const variant = variants.get(job.variantId)!;
    const episode = episodes.get(job.taskEpisodeId)!;
    const prompt = buildLunaAccuracyPrompt({
      episode,
      profile: input.profile,
      cards: input.cards,
      variant,
      repetitionIndex: job.repetitionIndex,
    });
    const baseInputTokens =
      estimateTokens(`${prompt.system}\n${prompt.user}`) +
      LUNA_ACCURACY_REQUEST_OVERHEAD_TOKENS;
    const perJobInputTokens =
      job.architecture === "proposal_verify_revise"
        ? baseInputTokens * 3 +
          LUNA_ACCURACY_VERIFY_PRIOR_TOKENS +
          LUNA_ACCURACY_REVISE_PRIOR_TOKENS
        : baseInputTokens;
    const calls = stageCount(job.architecture);
    const outputTokens = calls * variant.maxOutputTokens;
    maximumEstimatedCallTokens = Math.max(
      maximumEstimatedCallTokens,
      baseInputTokens +
        (job.architecture === "proposal_verify_revise"
          ? LUNA_ACCURACY_REVISE_PRIOR_TOKENS
          : 0) +
        variant.maxOutputTokens,
    );
    const current = armPlans.get(job.armId) ?? {
      armId: job.armId,
      variantId: job.variantId,
      architecture: job.architecture,
      pipelineJobs: 0,
      calls: 0,
      estimatedInputTokens: 0,
      reservedOutputTokens: 0,
    };
    current.pipelineJobs += 1;
    current.calls += calls;
    current.estimatedInputTokens += perJobInputTokens;
    current.reservedOutputTokens += outputTokens;
    armPlans.set(job.armId, current);
  }
  const byArm = [...armPlans.values()]
    .sort((left, right) => left.armId.localeCompare(right.armId))
    .map((arm): LunaAccuracyArmCostPlan => ({
      ...arm,
      projectedMaximumCostUsd: maximumCallCost(
        input.price,
        arm.estimatedInputTokens,
        arm.reservedOutputTokens,
      ),
    }));
  const estimatedInputTokens = byArm.reduce(
    (sum, arm) => sum + arm.estimatedInputTokens,
    0,
  );
  const reservedOutputTokens = byArm.reduce(
    (sum, arm) => sum + arm.reservedOutputTokens,
    0,
  );
  const warnings: string[] = [];
  if (
    input.price.contextLength > 0 &&
    maximumEstimatedCallTokens > input.price.contextLength
  ) {
    warnings.push(
      "At least one conservatively estimated call exceeds the catalog context length.",
    );
  }
  if (input.datasetRole === "burned_development") {
    warnings.push(
      "Burned development results are for harness debugging only and cannot select the product configuration.",
    );
  }
  if (input.datasetRole === "locked_test") {
    warnings.push(
      "This is the one-time locked-test path; do not rerun it or tune from case-level results.",
    );
  }
  return {
    schemaVersion: 1,
    model: LUNA_ACCURACY_WORKFLOW_MODEL,
    cases: input.episodes.length,
    variants: input.matrix.variants.length,
    arms: arms.length,
    concurrency,
    pipelineJobs: schedule.length,
    calls: byArm.reduce((sum, arm) => sum + arm.calls, 0),
    estimatedInputTokens,
    reservedOutputTokens,
    projectedMaximumCostUsd: maximumCallCost(
      input.price,
      estimatedInputTokens,
      reservedOutputTokens,
    ),
    price: {
      promptUsdPerToken: input.price.promptUsdPerToken,
      completionUsdPerToken: input.price.completionUsdPerToken,
      contextLength: input.price.contextLength,
    },
    byArm,
    assumptions: {
      requestOverheadTokensPerCall:
        LUNA_ACCURACY_REQUEST_OVERHEAD_TOKENS,
      verifierPriorTokens: LUNA_ACCURACY_VERIFY_PRIOR_TOKENS,
      revisionPriorTokens: LUNA_ACCURACY_REVISE_PRIOR_TOKENS,
      latestRequestOnlySupported: false,
    },
    warnings,
  };
};

export interface LunaAccuracyProviderStatus {
  usageUsd: number;
  limitRemainingUsd: number | null;
  accountUsageUsd: number | null;
  accountRemainingUsd: number | null;
}

const providerUsage = (status: LunaAccuracyProviderStatus): number =>
  status.accountUsageUsd ?? status.usageUsd;

const assertProviderCapacity = (
  status: LunaAccuracyProviderStatus,
  reservationUsd: number,
): void => {
  const remaining = [
    status.limitRemainingUsd,
    status.accountRemainingUsd,
  ].filter((value): value is number => value !== null);
  if (
    remaining.length > 0 &&
    Math.min(...remaining) + 1e-9 < reservationUsd
  ) {
    throw new Error(
      `OpenRouter has only $${Math.min(...remaining).toFixed(6)} available; reservation requires $${reservationUsd.toFixed(6)}`,
    );
  }
};

const readCallRecords = async (
  callStateDirectory: string,
): Promise<LunaAccuracyCallRecord[]> => {
  let entries: string[];
  try {
    entries = await readdir(callStateDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records: LunaAccuracyCallRecord[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".json")) continue;
    records.push(
      JSON.parse(
        await readFile(path.join(callStateDirectory, entry), "utf8"),
      ) as LunaAccuracyCallRecord,
    );
  }
  return records;
};

const recordedCallCost = (
  record: LunaAccuracyCallRecord,
  matrix: LunaAccuracyMatrixV2,
  price: ModelPrice,
): number => {
  if (
    record.prediction.costUsd !== undefined &&
    Number.isFinite(record.prediction.costUsd)
  ) {
    return record.prediction.costUsd;
  }
  const variant = matrix.variants.find(
    (candidate) => candidate.id === record.variantId,
  );
  if (!variant) {
    throw new Error(
      `Cannot cost completed call for missing variant ${record.variantId}`,
    );
  }
  const inputTokens =
    record.prediction.inputTokens ??
    (record.prediction.inputCharacters === undefined
      ? LUNA_ACCURACY_REQUEST_OVERHEAD_TOKENS
      : Math.ceil(record.prediction.inputCharacters / 3.5) +
        LUNA_ACCURACY_REQUEST_OVERHEAD_TOKENS);
  const outputTokens =
    record.prediction.outputTokens ?? variant.maxOutputTokens;
  return maximumCallCost(price, inputTokens, outputTokens);
};

export interface BudgetedLunaAccuracyRunResult {
  run: LunaAccuracyRunResult;
  transportPreflight: LunaAccuracyOpenRouterPreflight;
  treatmentDistinctness: LunaAccuracyTreatmentDistinctnessAudit;
  accounting: {
    reservedUsd: number;
    actualUsd: number;
    providerMeteredUsd: number;
    recordedCallUsd: number;
    newlyAccountedCalls: number;
  };
}

interface LunaAccuracyLockedTestEvaluationMarker {
  schemaVersion: 1;
  freezeHash: string;
  runConfigurationHash: string;
  runInputHash: string;
  startedAt: string;
  status: "in_progress" | "completed";
  completedAt?: string;
}

const lockedTestMarkerPath = (runDirectory: string): string =>
  path.join(runDirectory, "..", ".locked-test-evaluation.json");

const beginLockedTestEvaluation = async (input: {
  runDirectory: string;
  freeze: LunaAccuracyFreezeRecord;
  expectedManifest: LunaAccuracyRunManifest;
}): Promise<{
  path: string;
  marker: LunaAccuracyLockedTestEvaluationMarker;
}> => {
  const markerPath = lockedTestMarkerPath(input.runDirectory);
  const freezeHash = contentHash(input.freeze);
  const expected = {
    freezeHash,
    runConfigurationHash: input.expectedManifest.configurationHash,
    runInputHash: input.expectedManifest.inputHash,
  };
  await mkdir(path.dirname(markerPath), { recursive: true, mode: 0o700 });
  try {
    const handle = await open(markerPath, "wx", 0o600);
    const marker: LunaAccuracyLockedTestEvaluationMarker = {
      schemaVersion: 1,
      ...expected,
      startedAt: new Date().toISOString(),
      status: "in_progress",
    };
    try {
      await handle.writeFile(`${JSON.stringify(marker, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return { path: markerPath, marker };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const marker = JSON.parse(
      await readFile(markerPath, "utf8"),
    ) as LunaAccuracyLockedTestEvaluationMarker;
    if (
      marker.schemaVersion !== 1 ||
      marker.freezeHash !== expected.freezeHash ||
      marker.runConfigurationHash !== expected.runConfigurationHash ||
      marker.runInputHash !== expected.runInputHash
    ) {
      throw new Error(
        "A different locked-test evaluation has already been started",
      );
    }
    if (marker.status === "completed") {
      const existingManifestPath = path.join(
        input.runDirectory,
        "manifest.lock.json",
      );
      try {
        const existing = JSON.parse(
          await readFile(existingManifestPath, "utf8"),
        ) as LunaAccuracyRunManifest;
        if (
          existing.configurationHash !== expected.runConfigurationHash ||
          existing.inputHash !== expected.runInputHash
        ) {
          throw new Error(
            "Completed locked-test marker does not match this run",
          );
        }
      } catch (manifestError) {
        if ((manifestError as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error(
            "Locked-test evaluation is already complete and cannot be rerun",
          );
        }
        throw manifestError;
      }
      const completed = await readCallRecords(
        path.join(input.runDirectory, "private", "call-state"),
      );
      if (
        completed.length !== input.expectedManifest.counts.expectedCalls ||
        new Set(completed.map((record) => record.key)).size !==
          completed.length ||
        completed.some(
          (record) =>
            record.inputHash !== input.expectedManifest.inputHash,
        )
      ) {
        throw new Error(
          "Locked-test evaluation is already complete; incomplete artifacts cannot be re-executed",
        );
      }
    } else if (marker.status !== "in_progress") {
      throw new Error("Invalid locked-test evaluation marker");
    }
    return { path: markerPath, marker };
  }
};

const completeLockedTestEvaluation = async (
  markerPath: string,
  marker: LunaAccuracyLockedTestEvaluationMarker,
): Promise<void> => {
  const temporary = `${markerPath}.${process.pid}.tmp`;
  await writeFile(
    temporary,
    `${JSON.stringify({
      ...marker,
      status: "completed",
      completedAt: new Date().toISOString(),
    }, null, 2)}\n`,
    { mode: 0o600, flag: "wx" },
  );
  await rename(temporary, markerPath);
};

/**
 * Adds budget and provider-credit accounting around the resumable runner.
 * Existing call-state keys are excluded so a normal resume does not double
 * charge the local ledger. On an exception, newly persisted calls are still
 * settled before the error is rethrown.
 */
export const runBudgetedLunaAccuracyWorkflow = async (input: {
  runDirectory: string;
  model: string;
  profile: RepositoryProfileV1;
  cards: AreaCardV1[];
  episodes: TaskEpisode[];
  matrix: LunaAccuracyMatrixV2;
  price: ModelPrice;
  reservationUsd: number;
  budgetLedger: BudgetLedger;
  getProviderStatus: () => Promise<LunaAccuracyProviderStatus>;
  /**
   * Public, no-inference transport preflight. Tests inject a deterministic
   * fixture; production callers default to two unauthenticated catalog GETs.
   */
  preflightTransport?: () => Promise<LunaAccuracyOpenRouterPreflight>;
  executor: LunaAccuracyCallExecutor;
  arms?: LunaAccuracyExperimentArm[];
  concurrency?: number;
  scheduleSeed?: number;
  retryPolicy?: Partial<LunaAccuracyRetryPolicy>;
  hooks?: LunaAccuracyRunnerHooks;
  datasetRole?: LunaAccuracyDatasetRole;
  freeze?: LunaAccuracyFreezeRecord;
  allowEquivalentTreatmentReplicates?: boolean;
}): Promise<BudgetedLunaAccuracyRunResult> => {
  assertModel(input.model);
  if (
    !Number.isFinite(input.reservationUsd) ||
    input.reservationUsd < 0
  ) {
    throw new Error("Invalid Luna accuracy workflow reservation");
  }
  const plan = planLunaAccuracyWorkflow({
    model: input.model,
    profile: input.profile,
    cards: input.cards,
    episodes: input.episodes,
    matrix: input.matrix,
    price: input.price,
    ...(input.arms ? { arms: input.arms } : {}),
    ...(input.concurrency === undefined
      ? {}
      : { concurrency: input.concurrency }),
    ...(input.scheduleSeed === undefined
      ? {}
      : { scheduleSeed: input.scheduleSeed }),
    datasetRole: input.datasetRole ?? "validation",
    ...(input.freeze ? { freeze: input.freeze } : {}),
  });
  if (input.reservationUsd + 1e-9 < plan.projectedMaximumCostUsd) {
    throw new Error(
      `Reservation $${input.reservationUsd.toFixed(6)} is below the projected maximum $${plan.projectedMaximumCostUsd.toFixed(6)}`,
    );
  }
  const treatmentDistinctness =
    auditLunaAccuracyTreatmentDistinctness({
      model: input.model,
      profile: input.profile,
      cards: input.cards,
      episodes: input.episodes,
      matrix: input.matrix,
      ...(input.arms ? { arms: input.arms } : {}),
    });
  assertLunaAccuracyTreatmentsDistinct(
    treatmentDistinctness,
    input.allowEquivalentTreatmentReplicates ?? false,
  );
  const transportPreflight = await (
    input.preflightTransport ?? preflightLunaAccuracyOpenRouter
  )();
  let lockedTestMarker:
    | Awaited<ReturnType<typeof beginLockedTestEvaluation>>
    | undefined;
  if (input.datasetRole === "locked_test") {
    if (!input.freeze) {
      throw new Error(
        "Locked-test evaluation requires a complete freeze record",
      );
    }
    assertLunaAccuracyFreezeInputs({
      freeze: input.freeze,
      model: input.model,
      profile: input.profile,
      cards: input.cards,
      episodes: input.episodes,
      matrix: input.matrix,
      ...(input.arms ? { arms: input.arms } : {}),
    });
    const expectedManifest = buildLunaAccuracyRunManifest({
      model: input.model,
      profile: input.profile,
      cards: input.cards,
      episodes: input.episodes,
      matrix: input.matrix,
      ...(input.arms ? { arms: input.arms } : {}),
      ...(input.concurrency === undefined
        ? {}
        : { concurrency: input.concurrency }),
      ...(input.scheduleSeed === undefined
        ? {}
        : { scheduleSeed: input.scheduleSeed }),
      ...(input.retryPolicy ? { retryPolicy: input.retryPolicy } : {}),
      transportPreflight,
      createdAt: input.freeze.frozenAt,
    });
    lockedTestMarker = await beginLockedTestEvaluation({
      runDirectory: input.runDirectory,
      freeze: input.freeze,
      expectedManifest,
    });
  }
  const callStateDirectory = path.join(
    input.runDirectory,
    "private",
    "call-state",
  );
  const existingKeys = new Set(
    (await readCallRecords(callStateDirectory)).map((record) => record.key),
  );
  await input.budgetLedger.reserve(input.reservationUsd);
  let before: LunaAccuracyProviderStatus | undefined;
  let run: LunaAccuracyRunResult | undefined;
  let originalError: unknown;
  try {
    before = await input.getProviderStatus();
    assertProviderCapacity(before, input.reservationUsd);
    run = await runLunaAccuracyExperiment({
      runDirectory: input.runDirectory,
      model: input.model,
      profile: input.profile,
      cards: input.cards,
      episodes: input.episodes,
      matrix: input.matrix,
      executor: input.executor,
      transportPreflight,
      ...(input.arms ? { arms: input.arms } : {}),
      ...(input.concurrency === undefined
        ? {}
        : { concurrency: input.concurrency }),
      ...(input.scheduleSeed === undefined
        ? {}
        : { scheduleSeed: input.scheduleSeed }),
      ...(input.retryPolicy ? { retryPolicy: input.retryPolicy } : {}),
      ...(input.hooks ? { hooks: input.hooks } : {}),
    });
  } catch (error) {
    originalError = error;
  }

  let accountingError: unknown;
  let accounting:
    | BudgetedLunaAccuracyRunResult["accounting"]
    | undefined;
  try {
    if (!before) {
      await input.budgetLedger.release(input.reservationUsd);
    } else {
      const completed = run?.callRecords ??
        await readCallRecords(callStateDirectory);
      const newlyCompleted = completed.filter(
        (record) => !existingKeys.has(record.key),
      );
      const recordedCallUsd = newlyCompleted.reduce(
        (sum, record) =>
          sum + recordedCallCost(record, input.matrix, input.price),
        0,
      );
      let providerMeteredUsd = 0;
      try {
        const after = await input.getProviderStatus();
        providerMeteredUsd = Math.max(
          0,
          providerUsage(after) - providerUsage(before),
        );
      } catch {
        // Provider accounting is useful corroboration, but a transient status
        // failure must never strand a committed reservation. Persisted call
        // records contain either the provider cost or a conservative
        // token-based estimate, so they remain a safe settlement fallback.
      }
      const actualUsd = Math.max(recordedCallUsd, providerMeteredUsd);
      await input.budgetLedger.settle(input.reservationUsd, actualUsd);
      accounting = {
        reservedUsd: input.reservationUsd,
        actualUsd,
        providerMeteredUsd,
        recordedCallUsd,
        newlyAccountedCalls: newlyCompleted.length,
      };
    }
  } catch (error) {
    accountingError = error;
  }
  if (originalError) throw originalError;
  if (accountingError) throw accountingError;
  if (!run || !accounting) {
    throw new Error("Luna accuracy workflow ended without a run result");
  }
  if (lockedTestMarker) {
    await completeLockedTestEvaluation(
      lockedTestMarker.path,
      lockedTestMarker.marker,
    );
  }
  return {
    run,
    transportPreflight,
    accounting,
    treatmentDistinctness,
  };
};
