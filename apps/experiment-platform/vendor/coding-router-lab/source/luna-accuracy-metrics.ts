import type {
  ClassifierPredictionV1,
  SilverLabelV1,
  TaskEpisode,
  UnknownType,
} from "./types.ts";

export const LUNA_ACCURACY_TASK_STRATA = [
  "known_single",
  "known_multi",
  "new_repository_area",
  "insufficient_information",
  "outside_scope",
] as const;

export type LunaAccuracyTaskStratum =
  (typeof LUNA_ACCURACY_TASK_STRATA)[number];

export const LUNA_UNKNOWN_TYPES = [
  "new_repository_area",
  "insufficient_information",
  "outside_scope",
] as const satisfies readonly UnknownType[];

export interface AccuracyCount {
  correct: number;
  count: number;
  accuracy: number | null;
}

export interface F1Count {
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
}

export interface CalibrationBin {
  index: number;
  lowerBound: number;
  upperBound: number;
  includesUpperBound: boolean;
  count: number;
  weight: number;
  meanKnownProbability: number | null;
  observedKnownRate: number | null;
  absoluteCalibrationError: number | null;
}

export interface RiskCoveragePoint {
  minimumConfidence: number;
  coveredCases: number;
  correctCases: number;
  coverage: number;
  selectiveAccuracy: number | null;
  risk: number | null;
}

export interface LunaAccuracyMetrics {
  schemaVersion: 1;
  cases: number;
  exactSemanticDecision: AccuracyCount;
  knownUnknown: {
    knownRecall: AccuracyCount;
    unknownRecall: AccuracyCount;
    balancedAccuracy: number | null;
  };
  knownCodingExactSet: AccuracyCount;
  taskStrata: Record<LunaAccuracyTaskStratum, AccuracyCount>;
  /**
   * An unweighted mean of the represented task-stratum accuracies. Missing
   * strata are reported explicitly and are not silently assigned a score.
   */
  macroTaskStratumAccuracy: number | null;
  representedTaskStrata: LunaAccuracyTaskStratum[];
  missingTaskStrata: LunaAccuracyTaskStratum[];
  perArea: Record<string, F1Count>;
  perAreaMacroF1: number | null;
  unknownSubtype: Record<UnknownType, F1Count>;
  unknownSubtypeMacroF1: number | null;
  knownProbability: {
    /**
     * ClassifierPredictionV1 confidence is confidence in the emitted decision.
     * Therefore p(known) is confidence for a known decision and 1-confidence
     * for an unknown decision.
     */
    derivation: "decision_confidence";
    brierScore: number;
    expectedCalibrationError: number;
    binCount: number;
    bins: CalibrationBin[];
  };
  /**
   * Coverage keeps decisions at or above the listed confidence threshold;
   * risk is the exact-semantic error rate among those retained decisions.
   */
  riskCoverage: RiskCoveragePoint[];
}

export interface LunaAccuracyMetricOptions {
  calibrationBinCount?: number;
  riskCoverageThresholds?: readonly number[];
  /**
   * Explicit IDs for the coding-first subset. This must come from a frozen,
   * source-independent annotation file; label.known is not a proxy for coding.
   * When omitted, knownCodingExactSet is intentionally undefined.
   */
  codingEpisodeIds?: ReadonlySet<string>;
}

interface JoinedAccuracyCase {
  label: SilverLabelV1;
  prediction: ClassifierPredictionV1;
}

const sortedUnique = (values: readonly string[]): string[] =>
  [...new Set(values)].sort();

const sameSet = (
  left: readonly string[],
  right: readonly string[],
): boolean => {
  const a = sortedUnique(left);
  const b = sortedUnique(right);
  return a.length === b.length &&
    a.every((value, index) => value === b[index]);
};

const ratio = (numerator: number, denominator: number): number | null =>
  denominator > 0 ? numerator / denominator : null;

const mean = (values: readonly number[]): number | null =>
  values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;

const accuracyCount = (correct: number, count: number): AccuracyCount => ({
  correct,
  count,
  accuracy: ratio(correct, count),
});

const f1Count = (
  truePositive: number,
  falsePositive: number,
  falseNegative: number,
): F1Count => ({
  truePositive,
  falsePositive,
  falseNegative,
  precision: ratio(truePositive, truePositive + falsePositive),
  recall: ratio(truePositive, truePositive + falseNegative),
  f1: ratio(
    2 * truePositive,
    2 * truePositive + falsePositive + falseNegative,
  ),
});

const duplicateIds = <T>(
  values: readonly T[],
  idOf: (value: T) => string,
): string[] => {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    const id = idOf(value);
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  return [...duplicates].sort();
};

const formatIds = (ids: readonly string[]): string =>
  ids.slice(0, 10).join(", ") +
  (ids.length > 10 ? `, ... (${ids.length} total)` : "");

const assertUniqueIds = <T>(
  values: readonly T[],
  idOf: (value: T) => string,
  kind: string,
): void => {
  const duplicates = duplicateIds(values, idOf);
  if (duplicates.length > 0) {
    throw new Error(`Duplicate ${kind} IDs: ${formatIds(duplicates)}`);
  }
};

const assertExactIdJoin = (
  expected: ReadonlySet<string>,
  actual: ReadonlySet<string>,
  expectedKind: string,
  actualKind: string,
): void => {
  const missing = [...expected].filter((id) => !actual.has(id)).sort();
  const extra = [...actual].filter((id) => !expected.has(id)).sort();
  if (missing.length > 0 || extra.length > 0) {
    const details = [
      missing.length > 0
        ? `missing ${actualKind} for ${expectedKind}: ${formatIds(missing)}`
        : null,
      extra.length > 0
        ? `extra ${actualKind} without ${expectedKind}: ${formatIds(extra)}`
        : null,
    ].filter((value): value is string => value !== null);
    throw new Error(`Incomplete one-to-one join: ${details.join("; ")}`);
  }
};

const assertValidLabels = (labels: readonly SilverLabelV1[]): void => {
  for (const label of labels) {
    if (label.known) {
      if (label.selectedAreaIds.length === 0) {
        throw new Error(
          `Known label ${label.taskEpisodeId} has no selected area`,
        );
      }
      if (label.unknownType !== undefined) {
        throw new Error(
          `Known label ${label.taskEpisodeId} unexpectedly has an unknown subtype`,
        );
      }
    } else {
      if (label.selectedAreaIds.length > 0) {
        throw new Error(
          `Unknown label ${label.taskEpisodeId} has selected areas`,
        );
      }
      if (
        label.unknownType === undefined ||
        !LUNA_UNKNOWN_TYPES.includes(label.unknownType)
      ) {
        throw new Error(
          `Unknown label ${label.taskEpisodeId} has no valid unknown subtype`,
        );
      }
    }
  }
};

const assertValidPredictionConfidences = (
  predictions: readonly ClassifierPredictionV1[],
): void => {
  for (const prediction of predictions) {
    if (
      !Number.isFinite(prediction.confidence) ||
      prediction.confidence < 0 ||
      prediction.confidence > 1
    ) {
      throw new Error(
        `Prediction ${prediction.taskEpisodeId} has confidence outside [0, 1]`,
      );
    }
  }
};

/**
 * Validates and joins a complete label/prediction pair. In particular, this
 * rejects duplicate IDs, missing predictions, and predictions for unlabeled
 * cases rather than allowing Map's last-write-wins behavior to hide them.
 */
const joinLabelsAndPredictions = (
  labels: readonly SilverLabelV1[],
  predictions: readonly ClassifierPredictionV1[],
): JoinedAccuracyCase[] => {
  if (labels.length === 0) {
    throw new Error("Accuracy evaluation requires at least one label");
  }
  assertUniqueIds(labels, (label) => label.taskEpisodeId, "label");
  assertUniqueIds(
    predictions,
    (prediction) => prediction.taskEpisodeId,
    "prediction",
  );
  assertValidLabels(labels);
  assertValidPredictionConfidences(predictions);
  const labelIds = new Set(labels.map((label) => label.taskEpisodeId));
  const predictionIds = new Set(
    predictions.map((prediction) => prediction.taskEpisodeId),
  );
  assertExactIdJoin(labelIds, predictionIds, "labels", "predictions");
  const predictionById = new Map(
    predictions.map((prediction) => [
      prediction.taskEpisodeId,
      prediction,
    ]),
  );
  return labels.map((label) => ({
    label,
    prediction: predictionById.get(label.taskEpisodeId)!,
  }));
};

export const isExactSemanticDecision = (
  label: SilverLabelV1,
  prediction: ClassifierPredictionV1,
): boolean => {
  const routingDecisionMatches =
    label.known === prediction.known &&
    sameSet(label.selectedAreaIds, prediction.selectedAreaIds);
  return routingDecisionMatches &&
    (label.known || label.unknownType === prediction.unknownType);
};

export const knownProbabilityFromDecisionConfidence = (
  prediction: ClassifierPredictionV1,
): number => prediction.known
  ? prediction.confidence
  : 1 - prediction.confidence;

const taskStratum = (label: SilverLabelV1): LunaAccuracyTaskStratum => {
  if (label.known) {
    return label.selectedAreaIds.length === 1
      ? "known_single"
      : "known_multi";
  }
  return label.unknownType!;
};

const calibrationBins = (
  cases: readonly JoinedAccuracyCase[],
  binCount: number,
): {
  expectedCalibrationError: number;
  bins: CalibrationBin[];
} => {
  const accumulators = Array.from(
    { length: binCount },
    () => ({ count: 0, probabilitySum: 0, knownSum: 0 }),
  );
  for (const item of cases) {
    const probability = knownProbabilityFromDecisionConfidence(
      item.prediction,
    );
    const index = Math.min(
      binCount - 1,
      Math.floor(probability * binCount),
    );
    const bin = accumulators[index]!;
    bin.count += 1;
    bin.probabilitySum += probability;
    bin.knownSum += item.label.known ? 1 : 0;
  }
  let expectedCalibrationError = 0;
  const bins = accumulators.map((bin, index): CalibrationBin => {
    const meanKnownProbability = ratio(bin.probabilitySum, bin.count);
    const observedKnownRate = ratio(bin.knownSum, bin.count);
    const absoluteCalibrationError =
      meanKnownProbability === null || observedKnownRate === null
        ? null
        : Math.abs(meanKnownProbability - observedKnownRate);
    const weight = bin.count / cases.length;
    expectedCalibrationError +=
      weight * (absoluteCalibrationError ?? 0);
    return {
      index,
      lowerBound: index / binCount,
      upperBound: (index + 1) / binCount,
      includesUpperBound: index === binCount - 1,
      count: bin.count,
      weight,
      meanKnownProbability,
      observedKnownRate,
      absoluteCalibrationError,
    };
  });
  return { expectedCalibrationError, bins };
};

const normalizedThresholds = (
  cases: readonly JoinedAccuracyCase[],
  requested: readonly number[] | undefined,
): number[] => {
  const thresholds = requested === undefined
    ? cases.map((item) => item.prediction.confidence)
    : [...requested];
  for (const threshold of thresholds) {
    if (
      !Number.isFinite(threshold) ||
      threshold < 0 ||
      threshold > 1
    ) {
      throw new Error("Risk/coverage thresholds must be within [0, 1]");
    }
  }
  return [...new Set(thresholds)].sort((left, right) => right - left);
};

const calculateFromJoinedCases = (
  cases: readonly JoinedAccuracyCase[],
  options: LunaAccuracyMetricOptions,
): LunaAccuracyMetrics => {
  const binCount = options.calibrationBinCount ?? 10;
  if (!Number.isInteger(binCount) || binCount < 1 || binCount > 100) {
    throw new Error(
      "calibrationBinCount must be an integer between 1 and 100",
    );
  }

  let semanticCorrect = 0;
  let knownDecisionCorrect = 0;
  let knownCount = 0;
  let unknownDecisionCorrect = 0;
  let unknownCount = 0;
  let knownCodingSetCorrect = 0;
  let knownCodingCount = 0;
  let brierTotal = 0;
  const codingEpisodeIds = options.codingEpisodeIds;
  if (codingEpisodeIds) {
    const caseIds = new Set(cases.map((item) => item.label.taskEpisodeId));
    const unknownCodingIds = [...codingEpisodeIds].filter(
      (id) => !caseIds.has(id),
    );
    if (unknownCodingIds.length > 0) {
      throw new Error(
        `Coding annotation contains unknown episode IDs: ${formatIds(unknownCodingIds.sort())}`,
      );
    }
  }
  const strataCounts = Object.fromEntries(
    LUNA_ACCURACY_TASK_STRATA.map((stratum) => [
      stratum,
      { correct: 0, count: 0 },
    ]),
  ) as Record<
    LunaAccuracyTaskStratum,
    { correct: number; count: number }
  >;

  for (const item of cases) {
    const exact = isExactSemanticDecision(item.label, item.prediction);
    if (exact) semanticCorrect += 1;
    const stratum = taskStratum(item.label);
    strataCounts[stratum].count += 1;
    if (exact) strataCounts[stratum].correct += 1;

    if (item.label.known) {
      knownCount += 1;
      if (item.prediction.known) knownDecisionCorrect += 1;
      if (codingEpisodeIds?.has(item.label.taskEpisodeId)) {
        knownCodingCount += 1;
        if (
          item.prediction.known &&
          sameSet(
            item.label.selectedAreaIds,
            item.prediction.selectedAreaIds,
          )
        ) {
          knownCodingSetCorrect += 1;
        }
      }
    } else {
      unknownCount += 1;
      if (!item.prediction.known) unknownDecisionCorrect += 1;
    }

    const probability = knownProbabilityFromDecisionConfidence(
      item.prediction,
    );
    const target = item.label.known ? 1 : 0;
    brierTotal += (probability - target) ** 2;
  }

  const taskStrata = Object.fromEntries(
    LUNA_ACCURACY_TASK_STRATA.map((stratum) => {
      const value = strataCounts[stratum];
      return [stratum, accuracyCount(value.correct, value.count)];
    }),
  ) as Record<LunaAccuracyTaskStratum, AccuracyCount>;
  const representedTaskStrata = LUNA_ACCURACY_TASK_STRATA.filter(
    (stratum) => taskStrata[stratum].count > 0,
  );
  const missingTaskStrata = LUNA_ACCURACY_TASK_STRATA.filter(
    (stratum) => taskStrata[stratum].count === 0,
  );

  const areaIds = sortedUnique(
    cases.flatMap((item) => [
      ...item.label.selectedAreaIds,
      ...item.prediction.selectedAreaIds,
    ]),
  );
  const perArea: Record<string, F1Count> = {};
  for (const areaId of areaIds) {
    let truePositive = 0;
    let falsePositive = 0;
    let falseNegative = 0;
    for (const item of cases) {
      const actual = item.label.selectedAreaIds.includes(areaId);
      const predicted = item.prediction.selectedAreaIds.includes(areaId);
      if (actual && predicted) truePositive += 1;
      else if (!actual && predicted) falsePositive += 1;
      else if (actual) falseNegative += 1;
    }
    perArea[areaId] = f1Count(
      truePositive,
      falsePositive,
      falseNegative,
    );
  }
  const perAreaF1Values = Object.values(perArea)
    .map((value) => value.f1)
    .filter((value): value is number => value !== null);

  const unknownCases = cases.filter((item) => !item.label.known);
  const unknownSubtype = Object.fromEntries(
    LUNA_UNKNOWN_TYPES.map((unknownType) => {
      let truePositive = 0;
      let falsePositive = 0;
      let falseNegative = 0;
      for (const item of unknownCases) {
        const actual = item.label.unknownType === unknownType;
        const predicted =
          !item.prediction.known &&
          item.prediction.unknownType === unknownType;
        if (actual && predicted) truePositive += 1;
        else if (!actual && predicted) falsePositive += 1;
        else if (actual) falseNegative += 1;
      }
      return [
        unknownType,
        f1Count(truePositive, falsePositive, falseNegative),
      ];
    }),
  ) as Record<UnknownType, F1Count>;
  const unknownF1Values = LUNA_UNKNOWN_TYPES
    .map((unknownType) => unknownSubtype[unknownType].f1)
    .filter((value): value is number => value !== null);

  const knownRecall = accuracyCount(knownDecisionCorrect, knownCount);
  const unknownRecall = accuracyCount(
    unknownDecisionCorrect,
    unknownCount,
  );
  const balancedAccuracy =
    knownRecall.accuracy === null || unknownRecall.accuracy === null
      ? null
      : (knownRecall.accuracy + unknownRecall.accuracy) / 2;

  const calibration = calibrationBins(cases, binCount);
  const thresholds = normalizedThresholds(
    cases,
    options.riskCoverageThresholds,
  );
  const riskCoverage = thresholds.map(
    (minimumConfidence): RiskCoveragePoint => {
      const retained = cases.filter(
        (item) => item.prediction.confidence >= minimumConfidence,
      );
      const correctCases = retained.filter((item) =>
        isExactSemanticDecision(item.label, item.prediction)
      ).length;
      const selectiveAccuracy = ratio(correctCases, retained.length);
      return {
        minimumConfidence,
        coveredCases: retained.length,
        correctCases,
        coverage: retained.length / cases.length,
        selectiveAccuracy,
        risk: selectiveAccuracy === null ? null : 1 - selectiveAccuracy,
      };
    },
  );

  return {
    schemaVersion: 1,
    cases: cases.length,
    exactSemanticDecision: accuracyCount(
      semanticCorrect,
      cases.length,
    ),
    knownUnknown: {
      knownRecall,
      unknownRecall,
      balancedAccuracy,
    },
    knownCodingExactSet: accuracyCount(
      knownCodingSetCorrect,
      knownCodingCount,
    ),
    taskStrata,
    macroTaskStratumAccuracy: mean(
      representedTaskStrata.map(
        (stratum) => taskStrata[stratum].accuracy!,
      ),
    ),
    representedTaskStrata: [...representedTaskStrata],
    missingTaskStrata: [...missingTaskStrata],
    perArea,
    perAreaMacroF1: mean(perAreaF1Values),
    unknownSubtype,
    unknownSubtypeMacroF1: mean(unknownF1Values),
    knownProbability: {
      derivation: "decision_confidence",
      brierScore: brierTotal / cases.length,
      expectedCalibrationError: calibration.expectedCalibrationError,
      binCount,
      bins: calibration.bins,
    },
    riskCoverage,
  };
};

export const calculateLunaAccuracyMetrics = (
  labels: readonly SilverLabelV1[],
  predictions: readonly ClassifierPredictionV1[],
  options: LunaAccuracyMetricOptions = {},
): LunaAccuracyMetrics =>
  calculateFromJoinedCases(
    joinLabelsAndPredictions(labels, predictions),
    options,
  );

export interface SessionLineageCluster {
  id: string;
  episodeIds: string[];
  sessionHashes: string[];
  lineageHashes: string[];
}

/**
 * Builds conservative dependence clusters as connected components: sharing
 * either a sessionHash or a lineageHash places episodes in the same cluster,
 * including transitive links across those two identifiers.
 */
export const buildSessionLineageClusters = (
  episodes: readonly TaskEpisode[],
): SessionLineageCluster[] => {
  assertUniqueIds(episodes, (episode) => episode.id, "episode");
  const parent = episodes.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root]!;
    while (parent[index] !== index) {
      const next = parent[index]!;
      parent[index] = root;
      index = next;
    }
    return root;
  };
  const union = (left: number, right: number): void => {
    const a = find(left);
    const b = find(right);
    if (a !== b) parent[b] = a;
  };
  const firstBySession = new Map<string, number>();
  const firstByLineage = new Map<string, number>();
  for (const [index, episode] of episodes.entries()) {
    const sessionPeer = firstBySession.get(episode.sessionHash);
    if (sessionPeer === undefined) {
      firstBySession.set(episode.sessionHash, index);
    } else {
      union(index, sessionPeer);
    }
    const lineagePeer = firstByLineage.get(episode.lineageHash);
    if (lineagePeer === undefined) {
      firstByLineage.set(episode.lineageHash, index);
    } else {
      union(index, lineagePeer);
    }
  }
  const grouped = new Map<number, TaskEpisode[]>();
  for (const [index, episode] of episodes.entries()) {
    const root = find(index);
    grouped.set(root, [...(grouped.get(root) ?? []), episode]);
  }
  return [...grouped.values()]
    .map((members): SessionLineageCluster => {
      const episodeIds = members.map((episode) => episode.id).sort();
      return {
        id: episodeIds[0]!,
        episodeIds,
        sessionHashes: sortedUnique(
          members.map((episode) => episode.sessionHash),
        ),
        lineageHashes: sortedUnique(
          members.map((episode) => episode.lineageHash),
        ),
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
};

export type LunaBootstrapMetric =
  | "exactSemanticDecision"
  | "knownUnknownBalancedAccuracy"
  | "knownCodingExactSetAccuracy"
  | "macroTaskStratumAccuracy"
  | "perAreaMacroF1"
  | "unknownSubtypeMacroF1"
  | "knownProbabilityBrierScore"
  | "knownProbabilityExpectedCalibrationError";

export interface LunaClusterBootstrapOptions {
  iterations?: number;
  seed?: number;
  confidenceLevel?: number;
  metric?: LunaBootstrapMetric;
  calibrationBinCount?: number;
  /**
   * Required when bootstrapping the coding-first exact-set metric. The same
   * frozen annotations used for ranking must be reused for every resample.
   */
  codingEpisodeIds?: ReadonlySet<string>;
}

export interface LunaClusterBootstrapComparison {
  schemaVersion: 1;
  clusterDefinition: "session_or_lineage_connected_component";
  metric: LunaBootstrapMetric;
  higherIsBetter: boolean;
  cases: number;
  clusters: number;
  clusterSizes: number[];
  iterationsRequested: number;
  iterationsCompleted: number;
  discardedIterations: number;
  seed: number;
  observed: {
    left: number;
    right: number;
    difference: number;
  };
  bootstrap: {
    meanDifference: number;
    standardError: number;
    confidenceInterval: {
      level: number;
      lower: number;
      upper: number;
    };
    probabilityLeftBetter: number;
    twoSidedSignPValue: number;
  };
}

const bootstrapMetricValue = (
  metrics: LunaAccuracyMetrics,
  metric: LunaBootstrapMetric,
): number | null => {
  switch (metric) {
    case "exactSemanticDecision":
      return metrics.exactSemanticDecision.accuracy;
    case "knownUnknownBalancedAccuracy":
      return metrics.knownUnknown.balancedAccuracy;
    case "knownCodingExactSetAccuracy":
      return metrics.knownCodingExactSet.accuracy;
    case "macroTaskStratumAccuracy":
      return metrics.macroTaskStratumAccuracy;
    case "perAreaMacroF1":
      return metrics.perAreaMacroF1;
    case "unknownSubtypeMacroF1":
      return metrics.unknownSubtypeMacroF1;
    case "knownProbabilityBrierScore":
      return metrics.knownProbability.brierScore;
    case "knownProbabilityExpectedCalibrationError":
      return metrics.knownProbability.expectedCalibrationError;
  }
};

const lowerIsBetterMetric = (metric: LunaBootstrapMetric): boolean =>
  metric === "knownProbabilityBrierScore" ||
  metric === "knownProbabilityExpectedCalibrationError";

const quantile = (
  sortedValues: readonly number[],
  probability: number,
): number => {
  const index = Math.floor((sortedValues.length - 1) * probability);
  return sortedValues[index]!;
};

/**
 * Performs a paired non-parametric bootstrap over session/lineage dependence
 * clusters. Both candidates are evaluated on every sampled case. A bootstrap
 * draw is reported as discarded when its selected metric is undefined (for
 * example, balanced accuracy in a draw containing only known cases).
 */
export const compareLunaAccuracyByClusterBootstrap = (
  episodes: readonly TaskEpisode[],
  labels: readonly SilverLabelV1[],
  leftPredictions: readonly ClassifierPredictionV1[],
  rightPredictions: readonly ClassifierPredictionV1[],
  options: LunaClusterBootstrapOptions = {},
): LunaClusterBootstrapComparison => {
  const iterations = options.iterations ?? 5_000;
  const seed = options.seed ?? 17;
  const confidenceLevel = options.confidenceLevel ?? 0.95;
  const metric = options.metric ?? "macroTaskStratumAccuracy";
  if (!Number.isInteger(iterations) || iterations < 100) {
    throw new Error("Bootstrap iterations must be an integer of at least 100");
  }
  if (
    !Number.isInteger(seed) ||
    seed < 0 ||
    seed > 0xffff_ffff
  ) {
    throw new Error("Bootstrap seed must be a uint32 integer");
  }
  if (
    !Number.isFinite(confidenceLevel) ||
    confidenceLevel <= 0 ||
    confidenceLevel >= 1
  ) {
    throw new Error("confidenceLevel must be between 0 and 1");
  }

  const leftCases = joinLabelsAndPredictions(labels, leftPredictions);
  const rightCases = joinLabelsAndPredictions(labels, rightPredictions);
  assertUniqueIds(episodes, (episode) => episode.id, "episode");
  const labelIds = new Set(labels.map((label) => label.taskEpisodeId));
  const episodeIds = new Set(episodes.map((episode) => episode.id));
  assertExactIdJoin(labelIds, episodeIds, "labels", "episodes");

  const clusters = buildSessionLineageClusters(episodes);
  if (clusters.length === 0) {
    throw new Error("Cluster bootstrap requires at least one cluster");
  }
  const leftById = new Map(
    leftCases.map((item) => [item.label.taskEpisodeId, item]),
  );
  const rightById = new Map(
    rightCases.map((item) => [item.label.taskEpisodeId, item]),
  );
  const metricOptions: LunaAccuracyMetricOptions = {
    ...(options.calibrationBinCount === undefined
      ? {}
      : { calibrationBinCount: options.calibrationBinCount }),
    ...(options.codingEpisodeIds === undefined
      ? {}
      : { codingEpisodeIds: options.codingEpisodeIds }),
  };
  const metricOptionsForSample = (
    sample: readonly JoinedAccuracyCase[],
  ): LunaAccuracyMetricOptions => {
    if (options.codingEpisodeIds === undefined) return metricOptions;
    const sampledIds = new Set(
      sample.map((item) => item.label.taskEpisodeId),
    );
    return {
      ...metricOptions,
      codingEpisodeIds: new Set(
        [...options.codingEpisodeIds].filter((id) => sampledIds.has(id)),
      ),
    };
  };
  const observedLeft = bootstrapMetricValue(
    calculateFromJoinedCases(leftCases, metricOptions),
    metric,
  );
  const observedRight = bootstrapMetricValue(
    calculateFromJoinedCases(rightCases, metricOptions),
    metric,
  );
  if (observedLeft === null || observedRight === null) {
    throw new Error(`Bootstrap metric ${metric} is undefined on the full set`);
  }

  let state = seed >>> 0;
  const random = (): number => {
    state = (1_664_525 * state + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
  const differences: number[] = [];
  let discardedIterations = 0;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const sampledLeft: JoinedAccuracyCase[] = [];
    const sampledRight: JoinedAccuracyCase[] = [];
    for (let draw = 0; draw < clusters.length; draw += 1) {
      const cluster = clusters[Math.floor(random() * clusters.length)]!;
      for (const episodeId of cluster.episodeIds) {
        sampledLeft.push(leftById.get(episodeId)!);
        sampledRight.push(rightById.get(episodeId)!);
      }
    }
    const leftValue = bootstrapMetricValue(
      calculateFromJoinedCases(
        sampledLeft,
        metricOptionsForSample(sampledLeft),
      ),
      metric,
    );
    const rightValue = bootstrapMetricValue(
      calculateFromJoinedCases(
        sampledRight,
        metricOptionsForSample(sampledRight),
      ),
      metric,
    );
    if (leftValue === null || rightValue === null) {
      discardedIterations += 1;
      continue;
    }
    differences.push(leftValue - rightValue);
  }
  if (differences.length === 0) {
    throw new Error(
      `Bootstrap metric ${metric} was undefined in every resample`,
    );
  }

  const bootstrapMean = mean(differences)!;
  const variance = differences.length > 1
    ? differences.reduce(
      (sum, value) => sum + (value - bootstrapMean) ** 2,
      0,
    ) / (differences.length - 1)
    : 0;
  const sortedDifferences = [...differences].sort(
    (left, right) => left - right,
  );
  const tail = (1 - confidenceLevel) / 2;
  const higherIsBetter = !lowerIsBetterMetric(metric);
  let better = 0;
  let tied = 0;
  let nonPositive = 0;
  let nonNegative = 0;
  for (const difference of differences) {
    if (
      (higherIsBetter && difference > 0) ||
      (!higherIsBetter && difference < 0)
    ) {
      better += 1;
    } else if (difference === 0) {
      tied += 1;
    }
    if (difference <= 0) nonPositive += 1;
    if (difference >= 0) nonNegative += 1;
  }

  return {
    schemaVersion: 1,
    clusterDefinition: "session_or_lineage_connected_component",
    metric,
    higherIsBetter,
    cases: labels.length,
    clusters: clusters.length,
    clusterSizes: clusters
      .map((cluster) => cluster.episodeIds.length)
      .sort((left, right) => left - right),
    iterationsRequested: iterations,
    iterationsCompleted: differences.length,
    discardedIterations,
    seed,
    observed: {
      left: observedLeft,
      right: observedRight,
      difference: observedLeft - observedRight,
    },
    bootstrap: {
      meanDifference: bootstrapMean,
      standardError: Math.sqrt(variance),
      confidenceInterval: {
        level: confidenceLevel,
        lower: quantile(sortedDifferences, tail),
        upper: quantile(sortedDifferences, 1 - tail),
      },
      probabilityLeftBetter:
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
