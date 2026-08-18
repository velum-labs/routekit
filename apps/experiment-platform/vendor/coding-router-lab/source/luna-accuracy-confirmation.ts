import {
  lunaAccuracySelectionComponents,
  lunaAccuracySelectionScore,
} from "./luna-accuracy-report.ts";
import {
  buildSessionLineageClusters,
  calculateLunaAccuracyMetrics,
} from "./luna-accuracy-metrics.ts";
import {
  assertLunaAccuracyRunComplete,
  buildLunaAccuracyJobSchedule,
  buildLunaAccuracyPredictionSets,
  lunaAccuracyCallKey,
  lunaAccuracyArmsHash,
  lunaAccuracyMatrixHash,
  lunaAccuracyModelHash,
  lunaAccuracyRuntimeEpisodesHash,
  normalizeLunaAccuracyArms,
  validateLunaAccuracyRunManifestBinding,
  type LunaAccuracyCallRecord,
  type LunaAccuracyExperimentArm,
  type LunaAccuracyPredictionSet,
  type LunaAccuracyRunManifest,
} from "./luna-accuracy-runner.ts";
import {
  buildLunaAccuracyPrompt,
  type LunaAccuracyMatrixV2,
} from "./luna-accuracy-context.ts";
import {
  codingEpisodeIdsFromAnnotations,
  type LunaAccuracyCodingAnnotation,
} from "./luna-accuracy-coding-annotations.ts";
import {
  auditLunaAccuracyTreatmentDistinctness,
  type LunaAccuracyTreatmentDistinctnessAudit,
} from "./luna-accuracy-distinctness.ts";
import { buildLunaAccuracyProviderRequest } from "./luna-accuracy-openrouter.ts";
import { contentHash } from "./hash.ts";
import type {
  AreaCardV1,
  ClassifierPredictionV1,
  RepositoryProfileV1,
  SilverLabelV1,
  TaskEpisode,
} from "./types.ts";
import { validateBenchmarkDataset } from "./validation.ts";

export const LUNA_ACCURACY_PHASE_TWO_B_BASELINE_VARIANT_ID =
  "p2b-a-labeled-6k-medium" as const;
export const LUNA_ACCURACY_PHASE_TWO_B_EXPECTED_REPETITIONS = 7 as const;
export const LUNA_ACCURACY_PHASE_TWO_B_BOOTSTRAP_ITERATIONS = 10_000 as const;
export const LUNA_ACCURACY_PHASE_TWO_B_BOOTSTRAP_SEED = 19_871 as const;

export const LUNA_ACCURACY_PHASE_TWO_B_STABILITY_GATES = Object.freeze({
  requiredCompletedSeedBlocks: 7,
  knownCodingMeanMinimum: 0.8,
  knownCodingWorstSeedMinimum: 0.625,
  unanimityMinimum: 0.8,
});

export const LUNA_ACCURACY_PHASE_TWO_B_PRACTICAL_WIN_RULE = Object.freeze({
  meanSelectionScoreLeadMinimum: 0.01,
  pairedClusterBootstrapSuperiorityMinimum: 0.8,
});

export interface LunaAccuracyPhaseTwoBPairedComparison {
  challengerVariantId: string;
  baselineVariantId: typeof LUNA_ACCURACY_PHASE_TWO_B_BASELINE_VARIANT_ID;
  clusterDefinition: "session_or_lineage_connected_component";
  seedPairing: "repetition_index";
  iterationsRequested: 10_000;
  iterationsCompleted: number;
  discardedIterations: number;
  bootstrapSeed: 19_871;
  cases: number;
  clusters: number;
  clusterSizes: number[];
  observed: {
    challengerMeanSelectionScore: number;
    baselineMeanSelectionScore: number;
    meanLead: number;
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
}

export interface LunaAccuracyPhaseTwoBVariantAnalysis {
  variantId: string;
  seedResults: Array<{
    repetitionIndex: number;
    seed: number;
    selectionScore: number;
    knownCodingExactSetAccuracy: number;
  }>;
  stability: {
    completedSeedBlocks: number;
    requiredCompletedSeedBlocks: 7;
    knownCodingMean: number;
    knownCodingWorstSeed: number;
    unanimityRate: number;
    passed: boolean;
    failures: string[];
  };
  meanSelectionScore: number;
}

export interface LunaAccuracyPhaseTwoBSelection {
  schemaVersion: 1;
  protocol: "luna-accuracy-phase2b-confirmation-v1";
  generatedAt: string;
  model: string;
  datasetRole: "validation";
  dataSource: "real_user";
  provenance: {
    modelHash: string;
    runtimeEpisodesHash: string;
    labelsHash: string;
    codingAnnotationsHash: string;
    matrixHash: string;
    armsHash: string;
    runManifestHash: string;
    completedCallsHash: string;
    distinctnessAuditHash: string;
    runInputHash: string;
    runConfigurationHash: string;
  };
  selectedVariantId: string;
  baselineVariantId: typeof LUNA_ACCURACY_PHASE_TWO_B_BASELINE_VARIANT_ID;
  outcome:
    | "practical_winner"
    | "conservative_baseline"
    | "no_stable_configuration";
  reason: string;
  variants: LunaAccuracyPhaseTwoBVariantAnalysis[];
  comparisons: LunaAccuracyPhaseTwoBPairedComparison[];
}

const mean = (values: readonly number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

const decisionKey = (prediction: ClassifierPredictionV1): string =>
  JSON.stringify({
    known: prediction.known,
    selectedAreaIds: [...prediction.selectedAreaIds].sort(),
    unknownType: prediction.unknownType ?? null,
  });

const exactCaseIds = (
  expected: ReadonlySet<string>,
  set: LunaAccuracyPredictionSet,
): void => {
  const ids = set.predictions.map((prediction) => prediction.taskEpisodeId);
  if (
    ids.length !== expected.size ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !expected.has(id))
  ) {
    throw new Error(
      `Phase 2b prediction set ${set.id} is not an exact episode join`,
    );
  }
};

const lexicalCompare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const canonicalLabels = (
  labels: readonly SilverLabelV1[],
): SilverLabelV1[] =>
  [...labels].sort((left, right) =>
    lexicalCompare(left.taskEpisodeId, right.taskEpisodeId)
  );

const canonicalAnnotations = (
  annotations: readonly LunaAccuracyCodingAnnotation[],
): LunaAccuracyCodingAnnotation[] =>
  [...annotations].sort((left, right) =>
    lexicalCompare(left.taskEpisodeId, right.taskEpisodeId)
  );

const canonicalCalls = (
  calls: readonly LunaAccuracyCallRecord[],
): LunaAccuracyCallRecord[] =>
  [...calls].sort((left, right) => lexicalCompare(left.key, right.key));

const unanimityRate = (
  sets: readonly LunaAccuracyPredictionSet[],
): number => {
  const bySet = sets.map(
    (set) =>
      new Map(
        set.predictions.map((prediction) => [
          prediction.taskEpisodeId,
          decisionKey(prediction),
        ]),
      ),
  );
  const caseIds = [...bySet[0]!.keys()];
  const unanimous = caseIds.filter(
    (caseId) =>
      new Set(bySet.map((values) => values.get(caseId))).size === 1,
  ).length;
  return unanimous / caseIds.length;
};

const analyzeVariant = (input: {
  variantId: string;
  labels: readonly SilverLabelV1[];
  codingEpisodeIds: ReadonlySet<string>;
  predictionSets: readonly LunaAccuracyPredictionSet[];
}): LunaAccuracyPhaseTwoBVariantAnalysis => {
  if (
    input.predictionSets.length !==
      LUNA_ACCURACY_PHASE_TWO_B_EXPECTED_REPETITIONS
  ) {
    throw new Error(
      `Phase 2b variant ${input.variantId} requires exactly seven prediction sets`,
    );
  }
  const repetitionIndices = input.predictionSets.map(
    (set) => set.repetitionIndex,
  );
  if (
    repetitionIndices.some((value) => value === null) ||
    new Set(repetitionIndices).size !==
      LUNA_ACCURACY_PHASE_TWO_B_EXPECTED_REPETITIONS ||
    [...repetitionIndices]
      .sort((left, right) => left! - right!)
      .some((value, index) => value !== index)
  ) {
    throw new Error(
      `Phase 2b variant ${input.variantId} needs repetition indices 0 through 6`,
    );
  }
  const ordered = [...input.predictionSets].sort(
    (left, right) => left.repetitionIndex! - right.repetitionIndex!,
  );
  const seedResults = ordered.map((set) => {
    if (set.seeds.length !== 1) {
      throw new Error(
        `Phase 2b set ${set.id} must contain exactly one paired seed`,
      );
    }
    const metrics = calculateLunaAccuracyMetrics(
      input.labels,
      set.predictions,
      { codingEpisodeIds: input.codingEpisodeIds },
    );
    const components = lunaAccuracySelectionComponents(metrics);
    const knownCoding = metrics.knownCodingExactSet.accuracy;
    if (components === null || knownCoding === null) {
      throw new Error(
        `Phase 2b set ${set.id} has an undefined required accuracy metric`,
      );
    }
    return {
      repetitionIndex: set.repetitionIndex!,
      seed: set.seeds[0]!,
      selectionScore: lunaAccuracySelectionScore(components),
      knownCodingExactSetAccuracy: knownCoding,
    };
  });
  const knownCodingMean = mean(
    seedResults.map((result) => result.knownCodingExactSetAccuracy),
  );
  const knownCodingWorstSeed = Math.min(
    ...seedResults.map((result) => result.knownCodingExactSetAccuracy),
  );
  const repeatUnanimity = unanimityRate(ordered);
  const completedSeedBlocks = seedResults.length;
  const failures: string[] = [];
  if (
    completedSeedBlocks !==
      LUNA_ACCURACY_PHASE_TWO_B_STABILITY_GATES
        .requiredCompletedSeedBlocks
  ) {
    failures.push(
      `Only ${completedSeedBlocks}/7 paired seed blocks were complete`,
    );
  }
  if (
    knownCodingMean <
      LUNA_ACCURACY_PHASE_TWO_B_STABILITY_GATES.knownCodingMeanMinimum
  ) {
    failures.push("Mean known-coding exact-set accuracy was below 0.80");
  }
  if (
    knownCodingWorstSeed <
      LUNA_ACCURACY_PHASE_TWO_B_STABILITY_GATES
        .knownCodingWorstSeedMinimum
  ) {
    failures.push(
      "Worst-seed known-coding exact-set accuracy was below 0.625",
    );
  }
  if (
    repeatUnanimity <
      LUNA_ACCURACY_PHASE_TWO_B_STABILITY_GATES.unanimityMinimum
  ) {
    failures.push("Cross-seed semantic-decision unanimity was below 0.80");
  }
  return {
    variantId: input.variantId,
    seedResults,
    stability: {
      completedSeedBlocks,
      requiredCompletedSeedBlocks: 7,
      knownCodingMean,
      knownCodingWorstSeed,
      unanimityRate: repeatUnanimity,
      passed: failures.length === 0,
      failures,
    },
    meanSelectionScore: mean(
      seedResults.map((result) => result.selectionScore),
    ),
  };
};

interface LunaAccuracyPhaseTwoBSelectionCoreInput {
  episodes: readonly TaskEpisode[];
  labels: readonly SilverLabelV1[];
  codingEpisodeIds: ReadonlySet<string>;
  predictionSets: readonly LunaAccuracyPredictionSet[];
  pairedComparisons: readonly LunaAccuracyPhaseTwoBPairedComparison[];
}

interface LunaAccuracyPhaseTwoBSelectionCoreResult {
  selectedVariantId: string;
  baselineVariantId: typeof LUNA_ACCURACY_PHASE_TWO_B_BASELINE_VARIANT_ID;
  outcome:
    | "practical_winner"
    | "conservative_baseline"
    | "no_stable_configuration";
  reason: string;
  variants: LunaAccuracyPhaseTwoBVariantAnalysis[];
  comparisons: LunaAccuracyPhaseTwoBPairedComparison[];
}

const selectLunaAccuracyPhaseTwoBCore = (
  input: LunaAccuracyPhaseTwoBSelectionCoreInput,
): LunaAccuracyPhaseTwoBSelectionCoreResult => {
  const expectedIds = new Set(input.episodes.map((episode) => episode.id));
  if (
    expectedIds.size === 0 ||
    input.labels.length !== expectedIds.size ||
    new Set(input.labels.map((label) => label.taskEpisodeId)).size !==
      expectedIds.size ||
    input.labels.some((label) => !expectedIds.has(label.taskEpisodeId))
  ) {
    throw new Error("Phase 2b episodes and labels require an exact join");
  }
  // Establish the preregistered dependence unit even though the bootstrap is
  // supplied externally. This rejects malformed episode dependence metadata.
  buildSessionLineageClusters(input.episodes);

  const byVariant = new Map<string, LunaAccuracyPredictionSet[]>();
  for (const set of input.predictionSets) {
    if (set.architecture !== "single_call") {
      throw new Error("Phase 2b confirmation permits single-call arms only");
    }
    exactCaseIds(expectedIds, set);
    byVariant.set(set.variantId, [
      ...(byVariant.get(set.variantId) ?? []),
      set,
    ]);
  }
  const expectedVariantIds = [
    LUNA_ACCURACY_PHASE_TWO_B_BASELINE_VARIANT_ID,
    "p2b-b-chronological-16k-medium",
    "p2b-c-labeled-6k-high",
  ];
  if (
    byVariant.size !== expectedVariantIds.length ||
    expectedVariantIds.some((id) => !byVariant.has(id))
  ) {
    throw new Error(
      "Phase 2b selection requires exactly the three preregistered variants",
    );
  }
  const variants = expectedVariantIds.map((variantId) =>
    analyzeVariant({
      variantId,
      labels: input.labels,
      codingEpisodeIds: input.codingEpisodeIds,
      predictionSets: byVariant.get(variantId)!,
    })
  );
  const comparisons = [...input.pairedComparisons];
  const comparisonByChallenger = new Map(
    comparisons.map((comparison) => [
      comparison.challengerVariantId,
      comparison,
    ]),
  );
  if (
    comparisons.length !== 2 ||
    comparisonByChallenger.size !== 2 ||
    expectedVariantIds.slice(1).some(
      (id) => !comparisonByChallenger.has(id),
    )
  ) {
    throw new Error(
      "Phase 2b requires one cluster/seed-paired comparison for B versus A and C versus A",
    );
  }
  for (const comparison of comparisons) {
    if (
      comparison.baselineVariantId !==
        LUNA_ACCURACY_PHASE_TWO_B_BASELINE_VARIANT_ID ||
      comparison.clusterDefinition !==
        "session_or_lineage_connected_component" ||
      comparison.seedPairing !== "repetition_index" ||
      comparison.iterationsRequested !==
        LUNA_ACCURACY_PHASE_TWO_B_BOOTSTRAP_ITERATIONS ||
      comparison.bootstrapSeed !==
        LUNA_ACCURACY_PHASE_TWO_B_BOOTSTRAP_SEED ||
      !Number.isFinite(
        comparison.bootstrap.probabilityChallengerBetter,
      ) ||
      comparison.bootstrap.probabilityChallengerBetter < 0 ||
      comparison.bootstrap.probabilityChallengerBetter > 1
    ) {
      throw new Error("Invalid Phase 2b paired comparison");
    }
  }
  const baseline = variants[0]!;
  const practicallyWinningChallengers = variants
    .slice(1)
    .filter((variant) => {
      const comparison = comparisonByChallenger.get(variant.variantId)!;
      return (
        variant.stability.passed &&
        variant.meanSelectionScore - baseline.meanSelectionScore >=
          LUNA_ACCURACY_PHASE_TWO_B_PRACTICAL_WIN_RULE
            .meanSelectionScoreLeadMinimum &&
        comparison.bootstrap.probabilityChallengerBetter >=
          LUNA_ACCURACY_PHASE_TWO_B_PRACTICAL_WIN_RULE
            .pairedClusterBootstrapSuperiorityMinimum
      );
    })
    .sort(
      (left, right) =>
        right.meanSelectionScore - left.meanSelectionScore ||
        left.variantId.localeCompare(right.variantId),
    );
  const practicalWinner = practicallyWinningChallengers[0];
  if (practicalWinner) {
    return {
      selectedVariantId: practicalWinner.variantId,
      baselineVariantId:
        LUNA_ACCURACY_PHASE_TWO_B_BASELINE_VARIANT_ID,
      outcome: "practical_winner",
      reason:
        "The selected challenger passed every stability gate, led A by at least 0.01 mean selection score, and reached at least 0.80 paired cluster-bootstrap superiority.",
      variants,
      comparisons,
    };
  }
  return {
    selectedVariantId:
      LUNA_ACCURACY_PHASE_TWO_B_BASELINE_VARIANT_ID,
    baselineVariantId: LUNA_ACCURACY_PHASE_TWO_B_BASELINE_VARIANT_ID,
    outcome: baseline.stability.passed
      ? "conservative_baseline"
      : "no_stable_configuration",
    reason: baseline.stability.passed
      ? "No challenger met the full practical-win rule; select conservative A by preregistration."
      : "No challenger met the full practical-win rule and conservative A failed a stability gate; A is returned as the fail-closed placeholder and must not be frozen for product use.",
    variants,
    comparisons,
  };
};

const exactSemanticDecisionCorrect = (
  label: SilverLabelV1,
  prediction: ClassifierPredictionV1,
): boolean => {
  if (label.known !== prediction.known) return false;
  if (label.known) {
    const expected = [...label.selectedAreaIds].sort();
    const actual = [...prediction.selectedAreaIds].sort();
    return expected.length === actual.length &&
      expected.every((areaId, index) => areaId === actual[index]);
  }
  return (
    prediction.selectedAreaIds.length === 0 &&
    prediction.unknownType === label.unknownType
  );
};

const taskStratum = (
  label: SilverLabelV1,
): "known_single" | "known_multi" | NonNullable<SilverLabelV1["unknownType"]> =>
  label.known
    ? label.selectedAreaIds.length === 1
      ? "known_single"
      : "known_multi"
    : label.unknownType!;

const scoreSample = (input: {
  labels: readonly SilverLabelV1[];
  predictions: readonly ClassifierPredictionV1[];
  codingEpisodeIds: ReadonlySet<string>;
}): number | null => {
  const predictionById = new Map(
    input.predictions.map((prediction) => [
      prediction.taskEpisodeId,
      prediction,
    ]),
  );
  const exact: boolean[] = [];
  const knownCoding: boolean[] = [];
  const knownDecision: boolean[] = [];
  const unknownDecision: boolean[] = [];
  const byStratum = new Map<string, boolean[]>();
  const areaIds = new Set<string>();
  const unknownTypes = [
    "new_repository_area",
    "insufficient_information",
    "outside_scope",
  ] as const;
  for (const label of input.labels) {
    const prediction = predictionById.get(label.taskEpisodeId);
    if (!prediction) {
      throw new Error(
        `Phase 2b bootstrap is missing prediction ${label.taskEpisodeId}`,
      );
    }
    const semantic = exactSemanticDecisionCorrect(label, prediction);
    exact.push(semantic);
    const stratum = taskStratum(label);
    byStratum.set(stratum, [...(byStratum.get(stratum) ?? []), semantic]);
    if (label.known) {
      knownDecision.push(prediction.known);
      label.selectedAreaIds.forEach((areaId) => areaIds.add(areaId));
      prediction.selectedAreaIds.forEach((areaId) => areaIds.add(areaId));
      if (input.codingEpisodeIds.has(label.taskEpisodeId)) {
        knownCoding.push(semantic);
      }
    } else {
      unknownDecision.push(!prediction.known);
    }
  }
  const averageBooleans = (values: readonly boolean[]): number | null =>
    values.length
      ? values.filter(Boolean).length / values.length
      : null;
  const knownCodingAccuracy = averageBooleans(knownCoding);
  const exactAccuracy = averageBooleans(exact);
  const knownAccuracy = averageBooleans(knownDecision);
  const unknownAccuracy = averageBooleans(unknownDecision);
  const representedStratumAccuracies = [...byStratum.values()]
    .map(averageBooleans)
    .filter((value): value is number => value !== null);
  const macroStratumAccuracy = representedStratumAccuracies.length
    ? mean(representedStratumAccuracies)
    : null;
  const knownUnknownBalancedAccuracy =
    knownAccuracy === null || unknownAccuracy === null
      ? null
      : (knownAccuracy + unknownAccuracy) / 2;
  const f1 = (
    truePositive: number,
    falsePositive: number,
    falseNegative: number,
  ): number | null => {
    const denominator = 2 * truePositive + falsePositive + falseNegative;
    return denominator ? 2 * truePositive / denominator : null;
  };
  const perAreaValues = [...areaIds].sort().map((areaId) => {
    let truePositive = 0;
    let falsePositive = 0;
    let falseNegative = 0;
    for (const label of input.labels) {
      const prediction = predictionById.get(label.taskEpisodeId)!;
      const expected = label.selectedAreaIds.includes(areaId);
      const actual = prediction.selectedAreaIds.includes(areaId);
      if (expected && actual) truePositive += 1;
      else if (!expected && actual) falsePositive += 1;
      else if (expected && !actual) falseNegative += 1;
    }
    return f1(truePositive, falsePositive, falseNegative);
  }).filter((value): value is number => value !== null);
  const unknownLabels = input.labels.filter((label) => !label.known);
  const subtypeValues = unknownTypes.map((unknownType) => {
    let truePositive = 0;
    let falsePositive = 0;
    let falseNegative = 0;
    for (const label of unknownLabels) {
      const prediction = predictionById.get(label.taskEpisodeId)!;
      const expected = !label.known && label.unknownType === unknownType;
      const actual = !prediction.known &&
        prediction.unknownType === unknownType;
      if (expected && actual) truePositive += 1;
      else if (!expected && actual) falsePositive += 1;
      else if (expected && !actual) falseNegative += 1;
    }
    return f1(truePositive, falsePositive, falseNegative);
  }).filter((value): value is number => value !== null);
  if (
    knownCodingAccuracy === null ||
    macroStratumAccuracy === null ||
    exactAccuracy === null ||
    knownUnknownBalancedAccuracy === null ||
    perAreaValues.length === 0 ||
    subtypeValues.length === 0
  ) {
    return null;
  }
  return lunaAccuracySelectionScore({
    knownCodingExactSetAccuracy: knownCodingAccuracy,
    macroTaskStratumAccuracy: macroStratumAccuracy,
    exactSemanticDecisionAccuracy: exactAccuracy,
    knownUnknownBalancedAccuracy,
    perAreaMacroF1: mean(perAreaValues),
    unknownSubtypeMacroF1: mean(subtypeValues),
  });
};

const quantile = (
  sortedValues: readonly number[],
  probability: number,
): number =>
  sortedValues[Math.floor((sortedValues.length - 1) * probability)]!;

/**
 * Paired two-dimensional bootstrap for Phase 2b. Each draw:
 *
 * 1. samples session/lineage-connected clusters with replacement;
 * 2. samples the seven seed indices with replacement; and
 * 3. evaluates challenger and A on the same sampled clusters and seeds.
 *
 * This keeps both dependence dimensions paired and never treats individual
 * episode/seed cells as independent observations.
 */
export const compareLunaAccuracyPhaseTwoBPaired = (input: {
  episodes: readonly TaskEpisode[];
  labels: readonly SilverLabelV1[];
  codingEpisodeIds: ReadonlySet<string>;
  baselineSets: readonly LunaAccuracyPredictionSet[];
  challengerSets: readonly LunaAccuracyPredictionSet[];
  challengerVariantId: string;
}): LunaAccuracyPhaseTwoBPairedComparison => {
  const ordered = (sets: readonly LunaAccuracyPredictionSet[]) => {
    if (
      sets.length !== LUNA_ACCURACY_PHASE_TWO_B_EXPECTED_REPETITIONS ||
      sets.some((set) => set.repetitionIndex === null)
    ) {
      throw new Error(
        "Phase 2b paired bootstrap requires seven indexed prediction sets",
      );
    }
    const result = [...sets].sort(
      (left, right) => left.repetitionIndex! - right.repetitionIndex!,
    );
    if (
      result.some(
        (set, index) =>
          set.repetitionIndex !== index || set.seeds.length !== 1,
      )
    ) {
      throw new Error(
        "Phase 2b paired bootstrap requires repetition indices 0 through 6",
      );
    }
    return result;
  };
  const baseline = ordered(input.baselineSets);
  const challenger = ordered(input.challengerSets);
  const episodeIds = new Set(input.episodes.map((episode) => episode.id));
  for (const set of [...baseline, ...challenger]) {
    exactCaseIds(episodeIds, set);
  }
  if (
    baseline.some(
      (set, index) =>
        set.seeds[0] !== challenger[index]!.seeds[0],
    )
  ) {
    throw new Error("Phase 2b challenger and A must use paired seeds");
  }
  const labelsById = new Map(
    input.labels.map((label) => [label.taskEpisodeId, label]),
  );
  const clusters = buildSessionLineageClusters(input.episodes);
  const fullScore = (sets: readonly LunaAccuracyPredictionSet[]): number =>
    mean(sets.map((set) => {
      const metrics = calculateLunaAccuracyMetrics(
        input.labels,
        set.predictions,
        { codingEpisodeIds: input.codingEpisodeIds },
      );
      const components = lunaAccuracySelectionComponents(metrics);
      if (components === null) {
        throw new Error(
          `Phase 2b set ${set.id} has undefined full-set score`,
        );
      }
      return lunaAccuracySelectionScore(components);
    }));
  const observedBaseline = fullScore(baseline);
  const observedChallenger = fullScore(challenger);
  const bySeedAndCase = (
    sets: readonly LunaAccuracyPredictionSet[],
  ): Array<Map<string, ClassifierPredictionV1>> =>
    sets.map(
      (set) =>
        new Map(
          set.predictions.map((prediction) => [
            prediction.taskEpisodeId,
            prediction,
          ]),
        ),
    );
  const baselinePredictions = bySeedAndCase(baseline);
  const challengerPredictions = bySeedAndCase(challenger);
  let state = LUNA_ACCURACY_PHASE_TWO_B_BOOTSTRAP_SEED >>> 0;
  const random = (): number => {
    state = (1_664_525 * state + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
  const differences: number[] = [];
  let discardedIterations = 0;
  for (
    let iteration = 0;
    iteration < LUNA_ACCURACY_PHASE_TWO_B_BOOTSTRAP_ITERATIONS;
    iteration += 1
  ) {
    const sampledIds: string[] = [];
    for (let draw = 0; draw < clusters.length; draw += 1) {
      const cluster = clusters[Math.floor(random() * clusters.length)]!;
      sampledIds.push(...cluster.episodeIds);
    }
    const sampledLabels = sampledIds.map((id) => labelsById.get(id)!);
    const sampledCodingIds = new Set(
      sampledIds.filter((id) => input.codingEpisodeIds.has(id)),
    );
    const sampledSeedIndices = Array.from(
      { length: LUNA_ACCURACY_PHASE_TWO_B_EXPECTED_REPETITIONS },
      () =>
        Math.floor(
          random() * LUNA_ACCURACY_PHASE_TWO_B_EXPECTED_REPETITIONS,
        ),
    );
    const averageSampledScore = (
      predictions: readonly Map<string, ClassifierPredictionV1>[],
    ): number | null => {
      const values: number[] = [];
      for (const seedIndex of sampledSeedIndices) {
        const selected = predictions[seedIndex]!;
        const score = scoreSample({
          labels: sampledLabels,
          predictions: sampledIds.map((id) => selected.get(id)!),
          codingEpisodeIds: sampledCodingIds,
        });
        if (score === null) return null;
        values.push(score);
      }
      return mean(values);
    };
    const baselineScore = averageSampledScore(baselinePredictions);
    const challengerScore = averageSampledScore(challengerPredictions);
    if (baselineScore === null || challengerScore === null) {
      discardedIterations += 1;
      continue;
    }
    differences.push(challengerScore - baselineScore);
  }
  if (differences.length === 0) {
    throw new Error("Every Phase 2b bootstrap draw was undefined");
  }
  const bootstrapMean = mean(differences);
  const variance = differences.length > 1
    ? differences.reduce(
      (total, value) => total + (value - bootstrapMean) ** 2,
      0,
    ) / (differences.length - 1)
    : 0;
  const sorted = [...differences].sort((left, right) => left - right);
  const better = differences.filter((difference) => difference > 0).length;
  const tied = differences.filter((difference) => difference === 0).length;
  const nonPositive = differences.filter(
    (difference) => difference <= 0,
  ).length;
  const nonNegative = differences.filter(
    (difference) => difference >= 0,
  ).length;
  return {
    challengerVariantId: input.challengerVariantId,
    baselineVariantId: LUNA_ACCURACY_PHASE_TWO_B_BASELINE_VARIANT_ID,
    clusterDefinition: "session_or_lineage_connected_component",
    seedPairing: "repetition_index",
    iterationsRequested: LUNA_ACCURACY_PHASE_TWO_B_BOOTSTRAP_ITERATIONS,
    iterationsCompleted: differences.length,
    discardedIterations,
    bootstrapSeed: LUNA_ACCURACY_PHASE_TWO_B_BOOTSTRAP_SEED,
    cases: input.episodes.length,
    clusters: clusters.length,
    clusterSizes: clusters
      .map((cluster) => cluster.episodeIds.length)
      .sort((left, right) => left - right),
    observed: {
      challengerMeanSelectionScore: observedChallenger,
      baselineMeanSelectionScore: observedBaseline,
      meanLead: observedChallenger - observedBaseline,
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
  };
};

const assertPhaseTwoBDesign = (
  matrix: LunaAccuracyMatrixV2,
  arms: readonly LunaAccuracyExperimentArm[],
  runManifest: LunaAccuracyRunManifest,
): void => {
  const expectedIds = [
    LUNA_ACCURACY_PHASE_TWO_B_BASELINE_VARIANT_ID,
    "p2b-b-chronological-16k-medium",
    "p2b-c-labeled-6k-high",
  ];
  if (
    matrix.variants.length !== 3 ||
    expectedIds.some(
      (id, index) => matrix.variants[index]?.id !== id,
    ) ||
    matrix.variants.some(
      (variant) =>
        variant.repetitions !==
          LUNA_ACCURACY_PHASE_TWO_B_EXPECTED_REPETITIONS,
    ) ||
    arms.length !== 3 ||
    arms.some(
      (arm, index) =>
        arm.id !== expectedIds[index] ||
        arm.variantId !== expectedIds[index] ||
        arm.architecture !== "single_call",
    ) ||
    runManifest.scheduleSeed !==
      LUNA_ACCURACY_PHASE_TWO_B_BOOTSTRAP_SEED
  ) {
    throw new Error(
      "Phase 2b analysis requires the exact preregistered matrix, arms, and schedule seed",
    );
  }
};

export interface BuildLunaAccuracyPhaseTwoBSelectionInput {
  model: string;
  profile: RepositoryProfileV1;
  cards: AreaCardV1[];
  episodes: TaskEpisode[];
  labels: SilverLabelV1[];
  codingAnnotations: LunaAccuracyCodingAnnotation[];
  matrix: LunaAccuracyMatrixV2;
  calls: LunaAccuracyCallRecord[];
  runManifest: LunaAccuracyRunManifest;
  arms?: LunaAccuracyExperimentArm[];
  distinctnessAudit?: LunaAccuracyTreatmentDistinctnessAudit;
  generatedAt?: string;
}

/**
 * Rebuilds the Phase 2b decision from immutable run inputs. The returned
 * aggregate-only artifact is bound to the manifest, completed calls, labels,
 * coding annotations, exact matrix/arms, and provider-request distinctness
 * audit. No caller-supplied accuracy or superiority statistic is accepted.
 */
export const buildLunaAccuracyPhaseTwoBSelection = (
  input: BuildLunaAccuracyPhaseTwoBSelectionInput,
): LunaAccuracyPhaseTwoBSelection => {
  if (input.model !== "openai/gpt-5.6-luna") {
    throw new Error(
      "Phase 2b selection requires the pinned openai/gpt-5.6-luna model",
    );
  }
  if (
    input.episodes.length === 0 ||
    input.episodes.some((episode) => episode.split !== "validation")
  ) {
    throw new Error(
      "Phase 2b selection requires a non-empty validation-only dataset",
    );
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
  assertPhaseTwoBDesign(input.matrix, arms, input.runManifest);
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
  const variantById = new Map(
    input.matrix.variants.map((variant) => [variant.id, variant]),
  );
  const episodeById = new Map(
    input.episodes.map((episode) => [episode.id, episode]),
  );
  const allowedAreaIds = input.cards.map((card) => card.areaId);
  const jobByCallKey = new Map(
    schedule.map((job) => [lunaAccuracyCallKey(job, "single"), job]),
  );
  for (const call of input.calls) {
    const job = jobByCallKey.get(call.key);
    const variant = variantById.get(call.variantId);
    const episode = episodeById.get(call.taskEpisodeId);
    if (!job || !variant || !episode || call.stage !== "single") {
      throw new Error(
        `Phase 2b call is not a preregistered single-call job: ${call.key}`,
      );
    }
    const prompt = buildLunaAccuracyPrompt({
      episode,
      profile: input.profile,
      cards: input.cards,
      variant,
      repetitionIndex: call.repetitionIndex,
    });
    const expectedPromptHash = contentHash(prompt);
    const expectedProviderRequestHash = contentHash(
      buildLunaAccuracyProviderRequest({
        model: input.model,
        prompt,
        variant,
        allowedAreaIds,
        stage: "classify",
        seed: job.seed,
      }),
    );
    if (
      call.promptHash !== expectedPromptHash ||
      call.transport?.providerRequestHash !== expectedProviderRequestHash
    ) {
      throw new Error(
        `Phase 2b call prompt or provider request hash does not match bound runtime inputs: ${call.key}`,
      );
    }
  }
  const predictionSets = buildLunaAccuracyPredictionSets({
    records: input.calls,
    episodes: input.episodes,
    matrix: input.matrix,
    arms,
  });
  const distinctnessAudit = input.distinctnessAudit ??
    auditLunaAccuracyTreatmentDistinctness({
      model: input.model,
      profile: input.profile,
      cards: input.cards,
      episodes: input.episodes,
      matrix: input.matrix,
      arms,
    });
  const expectedDistinctness =
    auditLunaAccuracyTreatmentDistinctness({
      model: input.model,
      profile: input.profile,
      cards: input.cards,
      episodes: input.episodes,
      matrix: input.matrix,
      arms,
    });
  if (
    contentHash(distinctnessAudit) !== contentHash(expectedDistinctness) ||
    distinctnessAudit.equivalentPairs.length > 0 ||
    distinctnessAudit.equivalenceClasses.length > 0
  ) {
    throw new Error(
      "Phase 2b distinctness audit is stale or contains provider-identical treatments",
    );
  }
  const setsByVariant = new Map<string, LunaAccuracyPredictionSet[]>();
  for (const set of predictionSets) {
    setsByVariant.set(set.variantId, [
      ...(setsByVariant.get(set.variantId) ?? []),
      set,
    ]);
  }
  const baselineSets = setsByVariant.get(
    LUNA_ACCURACY_PHASE_TWO_B_BASELINE_VARIANT_ID,
  )!;
  const comparisons = [
    "p2b-b-chronological-16k-medium",
    "p2b-c-labeled-6k-high",
  ].map((challengerVariantId) =>
    compareLunaAccuracyPhaseTwoBPaired({
      episodes: input.episodes,
      labels: input.labels,
      codingEpisodeIds,
      baselineSets,
      challengerSets: setsByVariant.get(challengerVariantId)!,
      challengerVariantId,
    })
  );
  const selection = selectLunaAccuracyPhaseTwoBCore({
    episodes: input.episodes,
    labels: input.labels,
    codingEpisodeIds,
    predictionSets,
    pairedComparisons: comparisons,
  });
  const generatedAt = input.generatedAt ?? input.runManifest.createdAt;
  if (!Number.isFinite(Date.parse(generatedAt))) {
    throw new Error("Phase 2b generatedAt must be an ISO date");
  }
  return {
    schemaVersion: 1,
    protocol: "luna-accuracy-phase2b-confirmation-v1",
    generatedAt,
    model: input.model,
    datasetRole: "validation",
    dataSource: "real_user",
    provenance: {
      modelHash: lunaAccuracyModelHash(input.model),
      runtimeEpisodesHash:
        lunaAccuracyRuntimeEpisodesHash(input.episodes),
      labelsHash: contentHash(canonicalLabels(input.labels)),
      codingAnnotationsHash:
        contentHash(canonicalAnnotations(input.codingAnnotations)),
      matrixHash: lunaAccuracyMatrixHash(input.matrix),
      armsHash: lunaAccuracyArmsHash(input.matrix, arms),
      runManifestHash: contentHash(input.runManifest),
      completedCallsHash: contentHash(canonicalCalls(input.calls)),
      distinctnessAuditHash: contentHash(distinctnessAudit),
      runInputHash: input.runManifest.inputHash,
      runConfigurationHash: input.runManifest.configurationHash,
    },
    ...selection,
  };
};

export const validateLunaAccuracyPhaseTwoBSelection = (
  input: BuildLunaAccuracyPhaseTwoBSelectionInput & {
    selection: LunaAccuracyPhaseTwoBSelection;
  },
): LunaAccuracyPhaseTwoBSelection => {
  const rebuilt = buildLunaAccuracyPhaseTwoBSelection({
    ...input,
    generatedAt: input.selection.generatedAt,
  });
  if (contentHash(rebuilt) !== contentHash(input.selection)) {
    throw new Error(
      "Phase 2b selection artifact does not match its bound raw inputs",
    );
  }
  return rebuilt;
};
