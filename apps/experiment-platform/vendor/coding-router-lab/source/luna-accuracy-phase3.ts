import { contentHash } from "./hash.ts";
import {
  buildLunaAccuracyArchitecturePrompt,
  buildLunaAccuracyJobSchedule,
  buildLunaAccuracyPredictionSets,
  assertLunaAccuracyRunComplete,
  lunaAccuracyAreaRegistryHash,
  lunaAccuracyArmsHash,
  lunaAccuracyCallKey,
  lunaAccuracyMatrixHash,
  lunaAccuracyModelHash,
  lunaAccuracyProfileHash,
  lunaAccuracyRuntimeEpisodesHash,
  normalizeLunaAccuracyArms,
  validateLunaAccuracyRunManifestBinding,
  LUNA_ACCURACY_RUNNER_VERSION,
  type LunaAccuracyArchitecture,
  type LunaAccuracyCallRecord,
  type LunaAccuracyCallStage,
  type LunaAccuracyExperimentArm,
  type LunaAccuracyPipelineJob,
  type LunaAccuracyPredictionSet,
  type LunaAccuracyRunManifest,
} from "./luna-accuracy-runner.ts";
import {
  buildLunaAccuracyPrompt,
  type LunaAccuracyMatrixV2,
  type LunaAccuracyVariantV2,
} from "./luna-accuracy-context.ts";
import {
  buildSessionLineageClusters,
  calculateLunaAccuracyMetrics,
  isExactSemanticDecision,
  type LunaAccuracyMetrics,
} from "./luna-accuracy-metrics.ts";
import {
  assessLunaAccuracyDatasetSupport,
  lunaAccuracySelectionComponents,
  lunaAccuracySelectionScore,
  type LunaAccuracyDatasetSupport,
} from "./luna-accuracy-report.ts";
import {
  codingEpisodeIdsFromAnnotations,
  type LunaAccuracyCodingAnnotation,
} from "./luna-accuracy-coding-annotations.ts";
import {
  LUNA_ACCURACY_PHASE_THREE_ARCHITECTURES,
  LUNA_ACCURACY_PHASE_THREE_CONTEXT_KEYS,
  LUNA_ACCURACY_PHASE_THREE_PIPELINE_REPETITIONS,
  LUNA_ACCURACY_PHASE_THREE_SELF_CONSISTENCY_MEMBERS,
  LUNA_ACCURACY_PHASE_THREE_SINGLE_REPETITIONS,
  LUNA_ACCURACY_PHASE_TWO_B_FIXED_SEED_LIST,
  LUNA_ACCURACY_PHASE_TWO_B_SCHEDULE_SEED,
} from "./luna-accuracy-design.ts";
import {
  buildLunaAccuracyProviderRequest,
  LUNA_ACCURACY_CANONICAL_MODEL,
  LUNA_ACCURACY_MODEL,
  LUNA_ACCURACY_PROVIDER,
  LUNA_ACCURACY_TRANSPORT_POLICY,
} from "./luna-accuracy-openrouter.ts";
import type {
  AreaCardV1,
  ClassifierPredictionV1,
  RepositoryProfileV1,
  SilverLabelV1,
  TaskEpisode,
  UnknownType,
} from "./types.ts";
import { validateBenchmarkDataset } from "./validation.ts";

export const LUNA_ACCURACY_PHASE_THREE_PROTOCOL =
  "luna-accuracy-phase3-architecture-selection-v1" as const;
export const LUNA_ACCURACY_PHASE_THREE_EXPECTED_CASES = 26 as const;
export const LUNA_ACCURACY_PHASE_THREE_EXPECTED_CALLS = 468 as const;
export const LUNA_ACCURACY_PHASE_THREE_BOOTSTRAP_ITERATIONS = 10_000 as const;
export const LUNA_ACCURACY_PHASE_THREE_BOOTSTRAP_SEED = 19_871 as const;

/**
 * Frozen before Phase 3 results are inspected. Selection is deliberately
 * conservative: a multi-call architecture must transfer to both frozen
 * contexts and pass every guardrail in both of them.
 */
export const LUNA_ACCURACY_PHASE_THREE_WIN_RULE = Object.freeze({
  minimumObservedSelectionScoreLeadPerContext: 0.01,
  minimumBootstrapProbabilityPerContext: 0.8,
  maximumObservedSelectionScoreDegradationPerContext: 0.03,
  maximumKnownCodingMeanAccuracyLossPerContext: 0,
  maximumKnownCodingCorrectDeficitFromBestSinglePerContext: 1,
  maximumFalseKnownIncreaseOverSingleMeanPerContext: 1,
  minimumCompletedBootstrapFraction: 0.8,
});

export type LunaAccuracyPhaseThreeContextKey =
  typeof LUNA_ACCURACY_PHASE_THREE_CONTEXT_KEYS[number];
export type LunaAccuracyPhaseThreeChallengerArchitecture = Exclude<
  LunaAccuracyArchitecture,
  "single_call"
>;

export interface LunaAccuracyPhaseThreeCandidateSummary {
  contextKey: LunaAccuracyPhaseThreeContextKey;
  armId: string;
  variantId: string;
  architecture: LunaAccuracyArchitecture;
  predictionSetIds: string[];
  evaluatedPredictionSets: number;
  casesPerPredictionSet: number;
  metricsByPredictionSet: Array<{
    predictionSetId: string;
    repetitionIndex: number | null;
    seeds: number[];
    metrics: LunaAccuracyMetrics;
    selectionScore: number;
    knownCodingCorrect: number;
    knownCodingCases: number;
    falseKnownErrors: number;
  }>;
  meanSelectionScore: number;
  knownCoding: {
    cases: number;
    meanAccuracy: number;
    meanCorrect: number;
    minimumCorrect: number;
    maximumCorrect: number;
  };
  falseKnown: {
    unknownCases: number;
    meanErrors: number;
    minimumErrors: number;
    maximumErrors: number;
  };
  meanCostUsdPerDecision: number | null;
}

export interface LunaAccuracyPhaseThreeBootstrapComparison {
  estimand:
    "fixed_challenger_decision_set_minus_mean_three_single_call_repetitions";
  clusterDefinition: "session_or_lineage_connected_component";
  singleCallResampling: "three_repetition_indices_with_replacement";
  challengerResampling:
    "fixed_final_decision_set_reused_for_each_sampled_single_repetition";
  iterationsRequested: 10_000;
  iterationsCompleted: number;
  discardedIterations: number;
  bootstrapSeed: 19_871;
  cases: number;
  clusters: number;
  clusterSizes: number[];
  observed: {
    challengerSelectionScore: number;
    singleCallMeanSelectionScore: number;
    lead: number;
  };
  bootstrap: {
    meanLead: number;
    standardError: number;
    confidenceInterval95: {
      lower: number;
      upper: number;
    };
    probabilityChallengerBetter: number;
    twoSidedSignPValue: number;
  };
  limitation: string;
}

export interface LunaAccuracyPhaseThreeContextComparison {
  contextKey: LunaAccuracyPhaseThreeContextKey;
  architecture: LunaAccuracyPhaseThreeChallengerArchitecture;
  baselineArmId: string;
  challengerArmId: string;
  baseline: LunaAccuracyPhaseThreeCandidateSummary;
  challenger: LunaAccuracyPhaseThreeCandidateSummary;
  bootstrap: LunaAccuracyPhaseThreeBootstrapComparison;
  observed: {
    selectionScoreLead: number;
    selectionScoreDegradation: number;
    knownCodingMeanAccuracyLead: number;
    knownCodingCorrectDeficitFromBestSingle: number;
    falseKnownIncreaseOverSingleMean: number;
  };
  gates: {
    completeBootstrap: boolean;
    minimumSelectionScoreLead: boolean;
    minimumBootstrapProbability: boolean;
    maximumObservedDegradation: boolean;
    noKnownCodingMeanAccuracyLoss: boolean;
    maximumKnownCodingCorrectDeficit: boolean;
    maximumFalseKnownIncrease: boolean;
    passed: boolean;
  };
  failures: string[];
}

export interface LunaAccuracyPhaseThreeArchitectureAnalysis {
  architecture: LunaAccuracyPhaseThreeChallengerArchitecture;
  contexts: LunaAccuracyPhaseThreeContextComparison[];
  passedBothContexts: boolean;
  averageObservedSelectionScoreLead: number;
  minimumObservedSelectionScoreLead: number;
  averageChallengerSelectionScore: number;
  meanCostUsdPerDecision: number | null;
}

export interface LunaAccuracyPhaseThreeSelection {
  schemaVersion: 1;
  protocol: typeof LUNA_ACCURACY_PHASE_THREE_PROTOCOL;
  generatedAt: string;
  model: typeof LUNA_ACCURACY_MODEL;
  datasetRole: "validation";
  dataSource: "real_user";
  provenance: {
    modelHash: string;
    profileHash: string;
    areaRegistryHash: string;
    runtimeEpisodesHash: string;
    labelsHash: string;
    codingAnnotationsHash: string;
    matrixHash: string;
    armsHash: string;
    runManifestHash: string;
    completedCallsHash: string;
    transportPolicyHash: string;
    analysisPolicyHash: string;
    runInputHash: string;
    runConfigurationHash: string;
  };
  design: {
    contexts: 2;
    arms: 6;
    cases: 26;
    expectedProviderCalls: 468;
    scheduleSeed: 19_871;
    contextConfigurationHashes: Record<
      LunaAccuracyPhaseThreeContextKey,
      string
    >;
    bootstrapIterations: 10_000;
    bootstrapSeed: 19_871;
    winRule: typeof LUNA_ACCURACY_PHASE_THREE_WIN_RULE;
  };
  datasetSupport: LunaAccuracyDatasetSupport;
  candidates: LunaAccuracyPhaseThreeCandidateSummary[];
  architectureAnalyses: LunaAccuracyPhaseThreeArchitectureAnalysis[];
  selection: {
    selectedArchitecture: LunaAccuracyArchitecture;
    selectedPrimaryArmId: string;
    selectedPrimaryVariantId: string;
    outcome: "multi_call_winner" | "single_call_default";
    reason: string;
  };
  limitations: string[];
}

export interface BuildLunaAccuracyPhaseThreeSelectionInput {
  model: string;
  profile: RepositoryProfileV1;
  cards: AreaCardV1[];
  episodes: TaskEpisode[];
  labels: SilverLabelV1[];
  codingAnnotations: LunaAccuracyCodingAnnotation[];
  matrix: LunaAccuracyMatrixV2;
  arms: LunaAccuracyExperimentArm[];
  calls: LunaAccuracyCallRecord[];
  runManifest: LunaAccuracyRunManifest;
  generatedAt?: string;
}

const lexicalCompare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const mean = (values: readonly number[]): number => {
  if (values.length === 0) throw new Error("Cannot average an empty list");
  return values.reduce((sum, value) => sum + value, 0) / values.length;
};

const quantile = (
  sortedValues: readonly number[],
  probability: number,
): number => sortedValues[Math.floor((sortedValues.length - 1) * probability)]!;

const canonicalLabels = (
  values: readonly SilverLabelV1[],
): SilverLabelV1[] => [...values].sort((left, right) =>
  lexicalCompare(left.taskEpisodeId, right.taskEpisodeId)
);

const canonicalAnnotations = (
  values: readonly LunaAccuracyCodingAnnotation[],
): LunaAccuracyCodingAnnotation[] => [...values].sort((left, right) =>
  lexicalCompare(left.taskEpisodeId, right.taskEpisodeId)
);

const canonicalCalls = (
  values: readonly LunaAccuracyCallRecord[],
): LunaAccuracyCallRecord[] => [...values].sort((left, right) =>
  lexicalCompare(left.key, right.key)
);

const expectedArmId = (
  contextKey: LunaAccuracyPhaseThreeContextKey,
  architecture: LunaAccuracyArchitecture,
): string => {
  const suffix = architecture === "single_call"
    ? "single"
    : architecture === "self_consistency_3"
    ? "sc3"
    : "pvr";
  return `p3-${contextKey}-${suffix}`;
};

const contextConfiguration = (
  variant: LunaAccuracyVariantV2,
): Record<string, unknown> => ({
  schemaVersion: variant.schemaVersion,
  taskFormat: variant.taskFormat,
  taskBudget: variant.taskBudget,
  repositoryProfileDetail: variant.repositoryProfileDetail,
  areaFieldBundle: variant.areaFieldBundle,
  registryFormat: variant.registryFormat,
  cardOrdering: variant.cardOrdering,
  reasoningEffort: variant.reasoningEffort,
  promptProcedure: variant.promptProcedure,
  outputSchema: variant.outputSchema,
  maxOutputTokens: variant.maxOutputTokens,
});

const sameNumberList = (
  left: readonly number[],
  right: readonly number[],
): boolean => left.length === right.length &&
  left.every((value, index) => value === right[index]);

const assertExactPhaseThreeDesign = (input: {
  matrix: LunaAccuracyMatrixV2;
  arms: readonly LunaAccuracyExperimentArm[];
  manifest: LunaAccuracyRunManifest;
  episodes: readonly TaskEpisode[];
}): Record<LunaAccuracyPhaseThreeContextKey, string> => {
  if (input.episodes.length !== LUNA_ACCURACY_PHASE_THREE_EXPECTED_CASES) {
    throw new Error(
      `Phase 3 requires the frozen ${LUNA_ACCURACY_PHASE_THREE_EXPECTED_CASES}-case validation set`,
    );
  }
  if (input.episodes.some((episode) => episode.split !== "validation")) {
    throw new Error("Phase 3 may analyze validation episodes only");
  }
  if (
    input.manifest.scheduleSeed !==
      LUNA_ACCURACY_PHASE_TWO_B_SCHEDULE_SEED ||
    input.manifest.counts.expectedCalls !==
      LUNA_ACCURACY_PHASE_THREE_EXPECTED_CALLS
  ) {
    throw new Error(
      "Phase 3 manifest does not use the preregistered schedule or 468-call design",
    );
  }
  const expectedIds = LUNA_ACCURACY_PHASE_THREE_CONTEXT_KEYS.flatMap(
    (contextKey) =>
      LUNA_ACCURACY_PHASE_THREE_ARCHITECTURES.map((architecture) =>
        expectedArmId(contextKey, architecture)
      ),
  );
  const variantsById = new Map(
    input.matrix.variants.map((variant) => [variant.id, variant]),
  );
  const armsById = new Map(input.arms.map((arm) => [arm.id, arm]));
  if (
    input.matrix.variants.length !== expectedIds.length ||
    variantsById.size !== expectedIds.length ||
    input.arms.length !== expectedIds.length ||
    armsById.size !== expectedIds.length ||
    expectedIds.some(
      (id) => !variantsById.has(id) || !armsById.has(id),
    )
  ) {
    throw new Error(
      "Phase 3 requires exactly the preregistered two-context/six-arm design",
    );
  }
  const firstThreeSeeds = LUNA_ACCURACY_PHASE_TWO_B_FIXED_SEED_LIST.slice(
    0,
    3,
  );
  const firstSeed = LUNA_ACCURACY_PHASE_TWO_B_FIXED_SEED_LIST.slice(0, 1);
  const contextHashes = {} as Record<
    LunaAccuracyPhaseThreeContextKey,
    string
  >;
  for (const contextKey of LUNA_ACCURACY_PHASE_THREE_CONTEXT_KEYS) {
    const configurationHashes: string[] = [];
    for (const architecture of LUNA_ACCURACY_PHASE_THREE_ARCHITECTURES) {
      const id = expectedArmId(contextKey, architecture);
      const arm = armsById.get(id)!;
      const variant = variantsById.get(id)!;
      if (
        arm.variantId !== id ||
        arm.architecture !== architecture
      ) {
        throw new Error(`Phase 3 arm topology is invalid: ${id}`);
      }
      const repetitions = architecture === "single_call"
        ? LUNA_ACCURACY_PHASE_THREE_SINGLE_REPETITIONS
        : architecture === "self_consistency_3"
        ? LUNA_ACCURACY_PHASE_THREE_SELF_CONSISTENCY_MEMBERS
        : LUNA_ACCURACY_PHASE_THREE_PIPELINE_REPETITIONS;
      const seeds = architecture === "proposal_verify_revise"
        ? firstSeed
        : firstThreeSeeds;
      if (
        variant.repetitions !== repetitions ||
        !sameNumberList(variant.fixedSeedList, seeds)
      ) {
        throw new Error(
          `Phase 3 arm ${id} does not use its preregistered repetitions and seeds`,
        );
      }
      configurationHashes.push(contentHash(contextConfiguration(variant)));
    }
    if (new Set(configurationHashes).size !== 1) {
      throw new Error(
        `Phase 3 ${contextKey} arms changed context settings alongside architecture`,
      );
    }
    contextHashes[contextKey] = configurationHashes[0]!;
  }
  if (contextHashes.primary === contextHashes.alternative) {
    throw new Error(
      "Phase 3 primary and alternative contexts must be provider-distinct",
    );
  }
  return contextHashes;
};

const stageForProvider = (
  stage: LunaAccuracyCallStage,
): "classify" | "proposal" | "verify" | "revise" =>
  stage === "single" || stage === "member" ? "classify" : stage;

const assertPinnedCall = (input: {
  call: LunaAccuracyCallRecord;
  job: LunaAccuracyPipelineJob;
  stage: LunaAccuracyCallStage;
  prompt: ReturnType<typeof buildLunaAccuracyPrompt>;
  variant: LunaAccuracyVariantV2;
  model: string;
  allowedAreaIds: readonly string[];
}): void => {
  const { call } = input;
  if (
    call.schemaVersion !== 1 ||
    call.runnerVersion !== LUNA_ACCURACY_RUNNER_VERSION ||
    call.key !== lunaAccuracyCallKey(input.job, input.stage) ||
    call.promptHash !== contentHash(input.prompt) ||
    !Number.isFinite(Date.parse(call.completedAt)) ||
    !Number.isInteger(call.attemptCount) ||
    call.attemptCount < 1 ||
    call.transport?.policyVersion !==
      LUNA_ACCURACY_TRANSPORT_POLICY.version ||
    call.transport.providerName !== LUNA_ACCURACY_PROVIDER ||
    call.transport.responseModel !== LUNA_ACCURACY_MODEL ||
    call.transport.catalogCanonicalModel !==
      LUNA_ACCURACY_CANONICAL_MODEL
  ) {
    throw new Error(
      `Phase 3 call is not a complete provider-pinned record: ${call.key}`,
    );
  }
  const expectedProviderRequestHash = contentHash(
    buildLunaAccuracyProviderRequest({
      model: input.model,
      prompt: input.prompt,
      variant: input.variant,
      allowedAreaIds: input.allowedAreaIds,
      stage: stageForProvider(input.stage),
      seed: input.job.seed,
    }),
  );
  if (call.transport.providerRequestHash !== expectedProviderRequestHash) {
    throw new Error(
      `Phase 3 provider request hash is stale or mismatched: ${call.key}`,
    );
  }
};

/** Reconstructs every prompt/request hash, including dependent PVR stages. */
const assertPhaseThreeCallBindings = (input: {
  model: string;
  profile: RepositoryProfileV1;
  cards: readonly AreaCardV1[];
  episodes: readonly TaskEpisode[];
  matrix: LunaAccuracyMatrixV2;
  arms: readonly LunaAccuracyExperimentArm[];
  calls: readonly LunaAccuracyCallRecord[];
  schedule: readonly LunaAccuracyPipelineJob[];
}): void => {
  const variantById = new Map(
    input.matrix.variants.map((variant) => [variant.id, variant]),
  );
  const episodeById = new Map(
    input.episodes.map((episode) => [episode.id, episode]),
  );
  const callByKey = new Map(input.calls.map((call) => [call.key, call]));
  const allowedAreaIds = input.cards.map((card) => card.areaId);
  for (const job of input.schedule) {
    const variant = variantById.get(job.variantId)!;
    const episode = episodeById.get(job.taskEpisodeId)!;
    const base = buildLunaAccuracyPrompt({
      episode,
      profile: input.profile,
      cards: [...input.cards],
      variant,
      repetitionIndex: job.repetitionIndex,
    });
    const bound = (
      stage: LunaAccuracyCallStage,
      prompt: ReturnType<typeof buildLunaAccuracyPrompt>,
    ): LunaAccuracyCallRecord => {
      const call = callByKey.get(lunaAccuracyCallKey(job, stage));
      if (!call) {
        throw new Error(`Phase 3 is missing call ${job.key}/${stage}`);
      }
      assertPinnedCall({
        call,
        job,
        stage,
        prompt,
        variant,
        model: input.model,
        allowedAreaIds,
      });
      return call;
    };
    if (job.architecture === "single_call") {
      bound("single", base);
    } else if (job.architecture === "self_consistency_3") {
      bound("member", base);
    } else {
      const proposalPrompt = buildLunaAccuracyArchitecturePrompt({
        base,
        stage: "proposal",
      });
      const proposal = bound("proposal", proposalPrompt);
      const verifyPrompt = buildLunaAccuracyArchitecturePrompt({
        base,
        stage: "verify",
        proposal: proposal.prediction,
      });
      const verification = bound("verify", verifyPrompt);
      const revisePrompt = buildLunaAccuracyArchitecturePrompt({
        base,
        stage: "revise",
        proposal: proposal.prediction,
        verification: verification.prediction,
      });
      bound("revise", revisePrompt);
    }
  }
};

const sameSet = (
  left: readonly string[],
  right: readonly string[],
): boolean => {
  const a = [...new Set(left)].sort(lexicalCompare);
  const b = [...new Set(right)].sort(lexicalCompare);
  return a.length === b.length &&
    a.every((value, index) => value === b[index]);
};

const taskStratum = (
  label: SilverLabelV1,
): "known_single" | "known_multi" | UnknownType =>
  label.known
    ? label.selectedAreaIds.length === 1
      ? "known_single"
      : "known_multi"
    : label.unknownType!;

const ratio = (numerator: number, denominator: number): number | null =>
  denominator > 0 ? numerator / denominator : null;

const f1 = (
  truePositive: number,
  falsePositive: number,
  falseNegative: number,
): number | null => ratio(
  2 * truePositive,
  2 * truePositive + falsePositive + falseNegative,
);

/**
 * Lean bootstrap-only implementation of the frozen selection score. It uses
 * exactly the same six components and weights as the public metric report,
 * while permitting duplicated cases created by cluster resampling.
 */
const selectionScoreForSample = (input: {
  labels: readonly SilverLabelV1[];
  predictionById: ReadonlyMap<string, ClassifierPredictionV1>;
  codingEpisodeIds: ReadonlySet<string>;
}): number | null => {
  const exact: boolean[] = [];
  const knownCoding: boolean[] = [];
  const knownGate: boolean[] = [];
  const unknownGate: boolean[] = [];
  const byStratum = new Map<string, boolean[]>();
  const areaIds = new Set<string>();
  for (const label of input.labels) {
    const prediction = input.predictionById.get(label.taskEpisodeId);
    if (!prediction) {
      throw new Error(
        `Phase 3 bootstrap is missing prediction ${label.taskEpisodeId}`,
      );
    }
    const semantic = isExactSemanticDecision(label, prediction);
    exact.push(semantic);
    const stratum = taskStratum(label);
    byStratum.set(stratum, [...(byStratum.get(stratum) ?? []), semantic]);
    label.selectedAreaIds.forEach((areaId) => areaIds.add(areaId));
    prediction.selectedAreaIds.forEach((areaId) => areaIds.add(areaId));
    if (label.known) {
      knownGate.push(prediction.known);
      if (input.codingEpisodeIds.has(label.taskEpisodeId)) {
        knownCoding.push(
          prediction.known &&
            sameSet(label.selectedAreaIds, prediction.selectedAreaIds),
        );
      }
    } else {
      unknownGate.push(!prediction.known);
    }
  }
  const booleanMean = (values: readonly boolean[]): number | null =>
    values.length > 0 ? values.filter(Boolean).length / values.length : null;
  const exactAccuracy = booleanMean(exact);
  const knownCodingAccuracy = booleanMean(knownCoding);
  const knownAccuracy = booleanMean(knownGate);
  const unknownAccuracy = booleanMean(unknownGate);
  const stratumAccuracies = [...byStratum.values()]
    .map(booleanMean)
    .filter((value): value is number => value !== null);
  const macroTaskStratumAccuracy = stratumAccuracies.length > 0
    ? mean(stratumAccuracies)
    : null;
  const knownUnknownBalancedAccuracy =
    knownAccuracy === null || unknownAccuracy === null
      ? null
      : (knownAccuracy + unknownAccuracy) / 2;
  const perAreaF1 = [...areaIds].sort(lexicalCompare).map((areaId) => {
    let truePositive = 0;
    let falsePositive = 0;
    let falseNegative = 0;
    for (const label of input.labels) {
      const prediction = input.predictionById.get(label.taskEpisodeId)!;
      const expected = label.selectedAreaIds.includes(areaId);
      const actual = prediction.selectedAreaIds.includes(areaId);
      if (expected && actual) truePositive += 1;
      else if (!expected && actual) falsePositive += 1;
      else if (expected && !actual) falseNegative += 1;
    }
    return f1(truePositive, falsePositive, falseNegative);
  }).filter((value): value is number => value !== null);
  const unknownTypes = [
    "new_repository_area",
    "insufficient_information",
    "outside_scope",
  ] as const satisfies readonly UnknownType[];
  const unknownLabels = input.labels.filter((label) => !label.known);
  const unknownSubtypeF1 = unknownTypes.map((unknownType) => {
    let truePositive = 0;
    let falsePositive = 0;
    let falseNegative = 0;
    for (const label of unknownLabels) {
      const prediction = input.predictionById.get(label.taskEpisodeId)!;
      const expected = label.unknownType === unknownType;
      const actual = !prediction.known &&
        prediction.unknownType === unknownType;
      if (expected && actual) truePositive += 1;
      else if (!expected && actual) falsePositive += 1;
      else if (expected && !actual) falseNegative += 1;
    }
    return f1(truePositive, falsePositive, falseNegative);
  }).filter((value): value is number => value !== null);
  if (
    exactAccuracy === null ||
    knownCodingAccuracy === null ||
    macroTaskStratumAccuracy === null ||
    knownUnknownBalancedAccuracy === null ||
    perAreaF1.length === 0 ||
    unknownSubtypeF1.length === 0
  ) {
    return null;
  }
  return lunaAccuracySelectionScore({
    knownCodingExactSetAccuracy: knownCodingAccuracy,
    macroTaskStratumAccuracy,
    exactSemanticDecisionAccuracy: exactAccuracy,
    knownUnknownBalancedAccuracy,
    perAreaMacroF1: mean(perAreaF1),
    unknownSubtypeMacroF1: mean(unknownSubtypeF1),
  });
};

const falseKnownErrors = (
  labels: readonly SilverLabelV1[],
  predictions: readonly ClassifierPredictionV1[],
): number => {
  const byId = new Map(
    predictions.map((prediction) => [prediction.taskEpisodeId, prediction]),
  );
  return labels.filter((label) =>
    !label.known && byId.get(label.taskEpisodeId)?.known === true
  ).length;
};

const candidateSummary = (input: {
  contextKey: LunaAccuracyPhaseThreeContextKey;
  arm: LunaAccuracyExperimentArm;
  labels: readonly SilverLabelV1[];
  codingEpisodeIds: ReadonlySet<string>;
  predictionSets: readonly LunaAccuracyPredictionSet[];
}): LunaAccuracyPhaseThreeCandidateSummary => {
  if (input.predictionSets.length === 0) {
    throw new Error(`Phase 3 arm ${input.arm.id} has no prediction set`);
  }
  const metricsByPredictionSet = input.predictionSets.map((set) => {
    const metrics = calculateLunaAccuracyMetrics(
      input.labels,
      set.predictions,
      { codingEpisodeIds: input.codingEpisodeIds },
    );
    const components = lunaAccuracySelectionComponents(metrics);
    if (
      components === null ||
      metrics.knownCodingExactSet.accuracy === null
    ) {
      throw new Error(
        `Phase 3 arm ${input.arm.id} has an undefined required selection metric`,
      );
    }
    return {
      predictionSetId: set.id,
      repetitionIndex: set.repetitionIndex,
      seeds: [...set.seeds],
      metrics,
      selectionScore: lunaAccuracySelectionScore(components),
      knownCodingCorrect: metrics.knownCodingExactSet.correct,
      knownCodingCases: metrics.knownCodingExactSet.count,
      falseKnownErrors: falseKnownErrors(input.labels, set.predictions),
    };
  });
  const codingCaseCounts = new Set(
    metricsByPredictionSet.map((value) => value.knownCodingCases),
  );
  if (codingCaseCounts.size !== 1 || [...codingCaseCounts][0] === 0) {
    throw new Error(
      `Phase 3 arm ${input.arm.id} lacks a stable known-coding denominator`,
    );
  }
  const unknownCases = input.labels.filter((label) => !label.known).length;
  const costs = input.predictionSets.flatMap((set) =>
    set.predictions.map((prediction) => prediction.costUsd)
  );
  const meanCostUsdPerDecision = costs.every(
      (value): value is number =>
        typeof value === "number" && Number.isFinite(value) && value >= 0,
    )
    ? mean(costs)
    : null;
  const correct = metricsByPredictionSet.map(
    (value) => value.knownCodingCorrect,
  );
  const falseKnown = metricsByPredictionSet.map(
    (value) => value.falseKnownErrors,
  );
  const codingCases = [...codingCaseCounts][0]!;
  return {
    contextKey: input.contextKey,
    armId: input.arm.id,
    variantId: input.arm.variantId,
    architecture: input.arm.architecture,
    predictionSetIds: metricsByPredictionSet.map(
      (value) => value.predictionSetId,
    ),
    evaluatedPredictionSets: metricsByPredictionSet.length,
    casesPerPredictionSet: input.labels.length,
    metricsByPredictionSet,
    meanSelectionScore: mean(
      metricsByPredictionSet.map((value) => value.selectionScore),
    ),
    knownCoding: {
      cases: codingCases,
      meanAccuracy: mean(correct) / codingCases,
      meanCorrect: mean(correct),
      minimumCorrect: Math.min(...correct),
      maximumCorrect: Math.max(...correct),
    },
    falseKnown: {
      unknownCases,
      meanErrors: mean(falseKnown),
      minimumErrors: Math.min(...falseKnown),
      maximumErrors: Math.max(...falseKnown),
    },
    meanCostUsdPerDecision,
  };
};

const predictionsById = (
  set: LunaAccuracyPredictionSet,
): Map<string, ClassifierPredictionV1> => new Map(
  set.predictions.map((prediction) => [
    prediction.taskEpisodeId,
    prediction,
  ]),
);

export const compareLunaAccuracyPhaseThreePaired = (input: {
  episodes: readonly TaskEpisode[];
  labels: readonly SilverLabelV1[];
  codingEpisodeIds: ReadonlySet<string>;
  singleCallSets: readonly LunaAccuracyPredictionSet[];
  challengerSet: LunaAccuracyPredictionSet;
}): LunaAccuracyPhaseThreeBootstrapComparison => {
  if (
    input.singleCallSets.length !==
      LUNA_ACCURACY_PHASE_THREE_SINGLE_REPETITIONS ||
    input.singleCallSets.some(
      (set) => set.architecture !== "single_call" ||
        set.repetitionIndex === null || set.seeds.length !== 1,
    ) ||
    input.challengerSet.architecture === "single_call"
  ) {
    throw new Error(
      "Phase 3 bootstrap requires three indexed single-call sets and one multi-call challenger set",
    );
  }
  const singleCallSets = [...input.singleCallSets].sort(
    (left, right) => left.repetitionIndex! - right.repetitionIndex!,
  );
  if (
    singleCallSets.some((set, index) => set.repetitionIndex !== index)
  ) {
    throw new Error(
      "Phase 3 single-call repetitions must be indexed 0 through 2",
    );
  }
  const expectedIds = new Set(input.episodes.map((episode) => episode.id));
  const assertExactSet = (set: LunaAccuracyPredictionSet): void => {
    const ids = set.predictions.map((prediction) => prediction.taskEpisodeId);
    if (
      ids.length !== expectedIds.size ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !expectedIds.has(id))
    ) {
      throw new Error(
        `Phase 3 prediction set ${set.id} is not an exact episode join`,
      );
    }
  };
  [...singleCallSets, input.challengerSet].forEach(assertExactSet);
  const labelById = new Map(
    input.labels.map((label) => [label.taskEpisodeId, label]),
  );
  if (
    labelById.size !== expectedIds.size ||
    [...expectedIds].some((id) => !labelById.has(id))
  ) {
    throw new Error("Phase 3 bootstrap requires an exact episode/label join");
  }
  const singlePredictions = singleCallSets.map(predictionsById);
  const challengerPredictions = predictionsById(input.challengerSet);
  const fullScore = (
    predictionById: ReadonlyMap<string, ClassifierPredictionV1>,
  ): number => {
    const value = selectionScoreForSample({
      labels: input.labels,
      predictionById,
      codingEpisodeIds: input.codingEpisodeIds,
    });
    if (value === null) {
      throw new Error("Phase 3 full-set selection score is undefined");
    }
    return value;
  };
  const observedSingle = mean(singlePredictions.map(fullScore));
  const observedChallenger = fullScore(challengerPredictions);
  const clusters = buildSessionLineageClusters(input.episodes);
  let state = LUNA_ACCURACY_PHASE_THREE_BOOTSTRAP_SEED >>> 0;
  const random = (): number => {
    state = (1_664_525 * state + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
  const differences: number[] = [];
  let discardedIterations = 0;
  for (
    let iteration = 0;
    iteration < LUNA_ACCURACY_PHASE_THREE_BOOTSTRAP_ITERATIONS;
    iteration += 1
  ) {
    const sampledLabels: SilverLabelV1[] = [];
    for (let draw = 0; draw < clusters.length; draw += 1) {
      const cluster = clusters[Math.floor(random() * clusters.length)]!;
      sampledLabels.push(
        ...cluster.episodeIds.map((id) => labelById.get(id)!),
      );
    }
    const challengerScore = selectionScoreForSample({
      labels: sampledLabels,
      predictionById: challengerPredictions,
      codingEpisodeIds: input.codingEpisodeIds,
    });
    const sampledSingleScores: number[] = [];
    for (
      let draw = 0;
      draw < LUNA_ACCURACY_PHASE_THREE_SINGLE_REPETITIONS;
      draw += 1
    ) {
      const repetitionIndex = Math.floor(
        random() * LUNA_ACCURACY_PHASE_THREE_SINGLE_REPETITIONS,
      );
      const score = selectionScoreForSample({
        labels: sampledLabels,
        predictionById: singlePredictions[repetitionIndex]!,
        codingEpisodeIds: input.codingEpisodeIds,
      });
      if (score === null) break;
      sampledSingleScores.push(score);
    }
    if (
      challengerScore === null ||
      sampledSingleScores.length !==
        LUNA_ACCURACY_PHASE_THREE_SINGLE_REPETITIONS
    ) {
      discardedIterations += 1;
      continue;
    }
    differences.push(challengerScore - mean(sampledSingleScores));
  }
  if (differences.length === 0) {
    throw new Error("Every Phase 3 bootstrap draw was undefined");
  }
  const bootstrapMean = mean(differences);
  const variance = differences.length > 1
    ? differences.reduce(
      (total, value) => total + (value - bootstrapMean) ** 2,
      0,
    ) / (differences.length - 1)
    : 0;
  const sorted = [...differences].sort((left, right) => left - right);
  const better = differences.filter((value) => value > 0).length;
  const tied = differences.filter((value) => value === 0).length;
  const nonPositive = differences.filter((value) => value <= 0).length;
  const nonNegative = differences.filter((value) => value >= 0).length;
  return {
    estimand:
      "fixed_challenger_decision_set_minus_mean_three_single_call_repetitions",
    clusterDefinition: "session_or_lineage_connected_component",
    singleCallResampling: "three_repetition_indices_with_replacement",
    challengerResampling:
      "fixed_final_decision_set_reused_for_each_sampled_single_repetition",
    iterationsRequested: LUNA_ACCURACY_PHASE_THREE_BOOTSTRAP_ITERATIONS,
    iterationsCompleted: differences.length,
    discardedIterations,
    bootstrapSeed: LUNA_ACCURACY_PHASE_THREE_BOOTSTRAP_SEED,
    cases: input.episodes.length,
    clusters: clusters.length,
    clusterSizes: clusters.map((cluster) => cluster.episodeIds.length)
      .sort((left, right) => left - right),
    observed: {
      challengerSelectionScore: observedChallenger,
      singleCallMeanSelectionScore: observedSingle,
      lead: observedChallenger - observedSingle,
    },
    bootstrap: {
      meanLead: bootstrapMean,
      standardError: Math.sqrt(variance),
      confidenceInterval95: {
        lower: quantile(sorted, 0.025),
        upper: quantile(sorted, 0.975),
      },
      probabilityChallengerBetter:
        (better + 0.5 * tied) / differences.length,
      twoSidedSignPValue: Math.min(
        1,
        2 * Math.min(
          nonPositive / differences.length,
          nonNegative / differences.length,
        ),
      ),
    },
    limitation:
      "The challenger has one frozen final decision set. The bootstrap resamples dependence clusters and the three single-call trials, but cannot estimate independent challenger run-to-run variability.",
  };
};

const compareContext = (input: {
  contextKey: LunaAccuracyPhaseThreeContextKey;
  architecture: LunaAccuracyPhaseThreeChallengerArchitecture;
  episodes: readonly TaskEpisode[];
  labels: readonly SilverLabelV1[];
  codingEpisodeIds: ReadonlySet<string>;
  baseline: LunaAccuracyPhaseThreeCandidateSummary;
  challenger: LunaAccuracyPhaseThreeCandidateSummary;
  baselineSets: readonly LunaAccuracyPredictionSet[];
  challengerSet: LunaAccuracyPredictionSet;
}): LunaAccuracyPhaseThreeContextComparison => {
  const bootstrap = compareLunaAccuracyPhaseThreePaired({
    episodes: input.episodes,
    labels: input.labels,
    codingEpisodeIds: input.codingEpisodeIds,
    singleCallSets: input.baselineSets,
    challengerSet: input.challengerSet,
  });
  const selectionScoreLead =
    input.challenger.meanSelectionScore - input.baseline.meanSelectionScore;
  const selectionScoreDegradation = Math.max(0, -selectionScoreLead);
  const knownCodingMeanAccuracyLead =
    input.challenger.knownCoding.meanAccuracy -
    input.baseline.knownCoding.meanAccuracy;
  const knownCodingCorrectDeficitFromBestSingle = Math.max(
    0,
    input.baseline.knownCoding.maximumCorrect -
      input.challenger.knownCoding.meanCorrect,
  );
  const falseKnownIncreaseOverSingleMean =
    input.challenger.falseKnown.meanErrors -
    input.baseline.falseKnown.meanErrors;
  const completeBootstrap =
    bootstrap.iterationsCompleted /
        bootstrap.iterationsRequested >=
      LUNA_ACCURACY_PHASE_THREE_WIN_RULE.minimumCompletedBootstrapFraction;
  const minimumSelectionScoreLead =
    selectionScoreLead + Number.EPSILON >=
      LUNA_ACCURACY_PHASE_THREE_WIN_RULE
        .minimumObservedSelectionScoreLeadPerContext;
  const minimumBootstrapProbability =
    bootstrap.bootstrap.probabilityChallengerBetter + Number.EPSILON >=
      LUNA_ACCURACY_PHASE_THREE_WIN_RULE
        .minimumBootstrapProbabilityPerContext;
  const maximumObservedDegradation =
    selectionScoreDegradation <=
      LUNA_ACCURACY_PHASE_THREE_WIN_RULE
        .maximumObservedSelectionScoreDegradationPerContext +
        Number.EPSILON;
  const noKnownCodingMeanAccuracyLoss =
    knownCodingMeanAccuracyLead + Number.EPSILON >=
      -LUNA_ACCURACY_PHASE_THREE_WIN_RULE
        .maximumKnownCodingMeanAccuracyLossPerContext;
  const maximumKnownCodingCorrectDeficit =
    knownCodingCorrectDeficitFromBestSingle <=
      LUNA_ACCURACY_PHASE_THREE_WIN_RULE
        .maximumKnownCodingCorrectDeficitFromBestSinglePerContext +
        Number.EPSILON;
  const maximumFalseKnownIncrease =
    falseKnownIncreaseOverSingleMean <=
      LUNA_ACCURACY_PHASE_THREE_WIN_RULE
        .maximumFalseKnownIncreaseOverSingleMeanPerContext +
        Number.EPSILON;
  const gatesWithoutPassed = {
    completeBootstrap,
    minimumSelectionScoreLead,
    minimumBootstrapProbability,
    maximumObservedDegradation,
    noKnownCodingMeanAccuracyLoss,
    maximumKnownCodingCorrectDeficit,
    maximumFalseKnownIncrease,
  };
  const failures: string[] = [];
  if (!completeBootstrap) {
    failures.push("Fewer than 80% of preregistered bootstrap draws were defined");
  }
  if (!minimumSelectionScoreLead) {
    failures.push("Observed selection-score lead was below 0.01");
  }
  if (!minimumBootstrapProbability) {
    failures.push("Paired bootstrap probability of superiority was below 0.80");
  }
  if (!maximumObservedDegradation) {
    failures.push("Observed selection-score degradation exceeded 0.03");
  }
  if (!noKnownCodingMeanAccuracyLoss) {
    failures.push("Mean known-coding exact-set accuracy was lower than single-call");
  }
  if (!maximumKnownCodingCorrectDeficit) {
    failures.push(
      "Known-coding correct count was more than one below the best single-call trial",
    );
  }
  if (!maximumFalseKnownIncrease) {
    failures.push("False-known errors increased by more than one over the single-call mean");
  }
  return {
    contextKey: input.contextKey,
    architecture: input.architecture,
    baselineArmId: input.baseline.armId,
    challengerArmId: input.challenger.armId,
    baseline: input.baseline,
    challenger: input.challenger,
    bootstrap,
    observed: {
      selectionScoreLead,
      selectionScoreDegradation,
      knownCodingMeanAccuracyLead,
      knownCodingCorrectDeficitFromBestSingle,
      falseKnownIncreaseOverSingleMean,
    },
    gates: {
      ...gatesWithoutPassed,
      passed: Object.values(gatesWithoutPassed).every(Boolean),
    },
    failures,
  };
};

const exactCostTieBreak = (
  left: LunaAccuracyPhaseThreeArchitectureAnalysis,
  right: LunaAccuracyPhaseThreeArchitectureAnalysis,
): number => {
  if (
    left.meanCostUsdPerDecision !== null &&
    right.meanCostUsdPerDecision !== null &&
    left.meanCostUsdPerDecision !== right.meanCostUsdPerDecision
  ) {
    return left.meanCostUsdPerDecision - right.meanCostUsdPerDecision;
  }
  const fixedOrder: LunaAccuracyPhaseThreeChallengerArchitecture[] = [
    "self_consistency_3",
    "proposal_verify_revise",
  ];
  return fixedOrder.indexOf(left.architecture) -
    fixedOrder.indexOf(right.architecture);
};

export const buildLunaAccuracyPhaseThreeSelection = (
  input: BuildLunaAccuracyPhaseThreeSelectionInput,
): LunaAccuracyPhaseThreeSelection => {
  if (input.model !== LUNA_ACCURACY_MODEL) {
    throw new Error(`Phase 3 requires ${LUNA_ACCURACY_MODEL}`);
  }
  validateBenchmarkDataset(
    input.profile,
    input.cards,
    input.episodes,
    input.labels,
  );
  const codingEpisodeIds = codingEpisodeIdsFromAnnotations(
    input.episodes,
    input.codingAnnotations,
  );
  const datasetSupport = assessLunaAccuracyDatasetSupport(
    input.labels,
    codingEpisodeIds,
  );
  if (!datasetSupport.eligibleForSelection) {
    throw new Error(
      `Phase 3 dataset is ineligible for selection: ${datasetSupport.ineligibilityReasons.join("; ")}`,
    );
  }
  const arms = normalizeLunaAccuracyArms(input.matrix, input.arms);
  validateLunaAccuracyRunManifestBinding({
    manifest: input.runManifest,
    model: input.model,
    profile: input.profile,
    cards: input.cards,
    episodes: input.episodes,
    matrix: input.matrix,
    arms,
  });
  const contextConfigurationHashes = assertExactPhaseThreeDesign({
    matrix: input.matrix,
    arms,
    manifest: input.runManifest,
    episodes: input.episodes,
  });
  const schedule = buildLunaAccuracyJobSchedule({
    matrix: input.matrix,
    episodes: input.episodes,
    arms,
    scheduleSeed: input.runManifest.scheduleSeed,
  });
  assertLunaAccuracyRunComplete({
    records: input.calls,
    schedule,
    inputHash: input.runManifest.inputHash,
    allowedAreaIds: input.cards.map((card) => card.areaId),
  });
  assertPhaseThreeCallBindings({
    model: input.model,
    profile: input.profile,
    cards: input.cards,
    episodes: input.episodes,
    matrix: input.matrix,
    arms,
    calls: input.calls,
    schedule,
  });
  const predictionSets = buildLunaAccuracyPredictionSets({
    records: input.calls,
    episodes: input.episodes,
    matrix: input.matrix,
    arms,
  });
  const setsByArm = new Map<string, LunaAccuracyPredictionSet[]>();
  for (const set of predictionSets) {
    setsByArm.set(set.armId, [...(setsByArm.get(set.armId) ?? []), set]);
  }
  const armsById = new Map(arms.map((arm) => [arm.id, arm]));
  const candidates: LunaAccuracyPhaseThreeCandidateSummary[] = [];
  for (const contextKey of LUNA_ACCURACY_PHASE_THREE_CONTEXT_KEYS) {
    for (const architecture of LUNA_ACCURACY_PHASE_THREE_ARCHITECTURES) {
      const armId = expectedArmId(contextKey, architecture);
      const sets = setsByArm.get(armId) ?? [];
      const expectedSets = architecture === "single_call" ? 3 : 1;
      if (sets.length !== expectedSets) {
        throw new Error(
          `Phase 3 arm ${armId} produced ${sets.length}/${expectedSets} prediction sets`,
        );
      }
      candidates.push(candidateSummary({
        contextKey,
        arm: armsById.get(armId)!,
        labels: input.labels,
        codingEpisodeIds,
        predictionSets: sets,
      }));
    }
  }
  const candidateByArm = new Map(
    candidates.map((candidate) => [candidate.armId, candidate]),
  );
  const architectureAnalyses = ([
    "self_consistency_3",
    "proposal_verify_revise",
  ] as const).map((architecture): LunaAccuracyPhaseThreeArchitectureAnalysis => {
    const contexts = LUNA_ACCURACY_PHASE_THREE_CONTEXT_KEYS.map(
      (contextKey) => {
        const baselineId = expectedArmId(contextKey, "single_call");
        const challengerId = expectedArmId(contextKey, architecture);
        const challengerSets = setsByArm.get(challengerId)!;
        return compareContext({
          contextKey,
          architecture,
          episodes: input.episodes,
          labels: input.labels,
          codingEpisodeIds,
          baseline: candidateByArm.get(baselineId)!,
          challenger: candidateByArm.get(challengerId)!,
          baselineSets: setsByArm.get(baselineId)!,
          challengerSet: challengerSets[0]!,
        });
      },
    );
    const costs = contexts.map(
      (context) => context.challenger.meanCostUsdPerDecision,
    );
    return {
      architecture,
      contexts,
      passedBothContexts: contexts.every((context) => context.gates.passed),
      averageObservedSelectionScoreLead: mean(
        contexts.map((context) => context.observed.selectionScoreLead),
      ),
      minimumObservedSelectionScoreLead: Math.min(
        ...contexts.map((context) => context.observed.selectionScoreLead),
      ),
      averageChallengerSelectionScore: mean(
        contexts.map((context) => context.challenger.meanSelectionScore),
      ),
      meanCostUsdPerDecision: costs.every(
          (value): value is number => value !== null,
        )
        ? mean(costs)
        : null,
    };
  });
  const qualified = architectureAnalyses
    .filter((analysis) => analysis.passedBothContexts)
    .sort((left, right) => {
      const meanLead = right.averageObservedSelectionScoreLead -
        left.averageObservedSelectionScoreLead;
      if (Math.abs(meanLead) > Number.EPSILON) return meanLead;
      const worstContextLead = right.minimumObservedSelectionScoreLead -
        left.minimumObservedSelectionScoreLead;
      if (Math.abs(worstContextLead) > Number.EPSILON) {
        return worstContextLead;
      }
      return exactCostTieBreak(left, right);
    });
  const winner = qualified[0];
  const selectedArchitecture: LunaAccuracyArchitecture =
    winner?.architecture ?? "single_call";
  const selectedPrimaryArmId = expectedArmId(
    "primary",
    selectedArchitecture,
  );
  const generatedAt = input.generatedAt ?? input.runManifest.createdAt;
  if (!Number.isFinite(Date.parse(generatedAt))) {
    throw new Error("Phase 3 generatedAt must be an ISO date");
  }
  return {
    schemaVersion: 1,
    protocol: LUNA_ACCURACY_PHASE_THREE_PROTOCOL,
    generatedAt,
    model: LUNA_ACCURACY_MODEL,
    datasetRole: "validation",
    dataSource: "real_user",
    provenance: {
      modelHash: lunaAccuracyModelHash(input.model),
      profileHash: lunaAccuracyProfileHash(input.profile),
      areaRegistryHash: lunaAccuracyAreaRegistryHash(input.cards),
      runtimeEpisodesHash: lunaAccuracyRuntimeEpisodesHash(input.episodes),
      labelsHash: contentHash(canonicalLabels(input.labels)),
      codingAnnotationsHash: contentHash(
        canonicalAnnotations(input.codingAnnotations),
      ),
      matrixHash: lunaAccuracyMatrixHash(input.matrix),
      armsHash: lunaAccuracyArmsHash(input.matrix, arms),
      runManifestHash: contentHash(input.runManifest),
      completedCallsHash: contentHash(canonicalCalls(input.calls)),
      transportPolicyHash: contentHash(LUNA_ACCURACY_TRANSPORT_POLICY),
      analysisPolicyHash: contentHash({
        protocol: LUNA_ACCURACY_PHASE_THREE_PROTOCOL,
        bootstrapIterations:
          LUNA_ACCURACY_PHASE_THREE_BOOTSTRAP_ITERATIONS,
        bootstrapSeed: LUNA_ACCURACY_PHASE_THREE_BOOTSTRAP_SEED,
        winRule: LUNA_ACCURACY_PHASE_THREE_WIN_RULE,
      }),
      runInputHash: input.runManifest.inputHash,
      runConfigurationHash: input.runManifest.configurationHash,
    },
    design: {
      contexts: 2,
      arms: 6,
      cases: LUNA_ACCURACY_PHASE_THREE_EXPECTED_CASES,
      expectedProviderCalls: LUNA_ACCURACY_PHASE_THREE_EXPECTED_CALLS,
      scheduleSeed: LUNA_ACCURACY_PHASE_TWO_B_SCHEDULE_SEED,
      contextConfigurationHashes,
      bootstrapIterations: LUNA_ACCURACY_PHASE_THREE_BOOTSTRAP_ITERATIONS,
      bootstrapSeed: LUNA_ACCURACY_PHASE_THREE_BOOTSTRAP_SEED,
      winRule: LUNA_ACCURACY_PHASE_THREE_WIN_RULE,
    },
    datasetSupport,
    candidates,
    architectureAnalyses,
    selection: winner
      ? {
          selectedArchitecture,
          selectedPrimaryArmId,
          selectedPrimaryVariantId: selectedPrimaryArmId,
          outcome: "multi_call_winner",
          reason:
            "The selected multi-call architecture passed every preregistered accuracy, paired-bootstrap, coding-safety, and false-known gate in both frozen contexts. Among passing architectures it had the strongest accuracy result; cost was considered only after exact accuracy ties.",
        }
      : {
          selectedArchitecture: "single_call",
          selectedPrimaryArmId,
          selectedPrimaryVariantId: selectedPrimaryArmId,
          outcome: "single_call_default",
          reason:
            "No multi-call architecture passed every preregistered gate in both frozen contexts, so the single-call primary-context baseline wins by default.",
        },
    limitations: [
      "The product recommendation remains provisional because it is selected on 26 real-user validation cases with only eight known-coding labels.",
      "Each multi-call architecture contributes one frozen final decision set per context, so Phase 3 does not estimate independent multi-call run-to-run variance.",
      "Primary and alternative context scores are never pooled into a single headline accuracy; both-context gates are applied separately.",
      "Repository-derived and synthetic stress results are excluded from this real-user selection artifact and must be reported separately.",
    ],
  };
};

export const validateLunaAccuracyPhaseThreeSelection = (
  input: BuildLunaAccuracyPhaseThreeSelectionInput & {
    selection: LunaAccuracyPhaseThreeSelection;
  },
): LunaAccuracyPhaseThreeSelection => {
  const rebuilt = buildLunaAccuracyPhaseThreeSelection({
    ...input,
    generatedAt: input.selection.generatedAt,
  });
  if (contentHash(rebuilt) !== contentHash(input.selection)) {
    throw new Error(
      "Phase 3 selection artifact does not match its bound raw inputs",
    );
  }
  return rebuilt;
};
