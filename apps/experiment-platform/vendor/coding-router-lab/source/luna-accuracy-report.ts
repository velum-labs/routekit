import {
  calculateLunaAccuracyMetrics,
  compareLunaAccuracyByClusterBootstrap,
  LUNA_ACCURACY_TASK_STRATA,
  type LunaAccuracyMetrics,
  type LunaBootstrapMetric,
  type LunaClusterBootstrapComparison,
  type LunaAccuracyTaskStratum,
} from "./luna-accuracy-metrics.ts";
import type {
  LunaAccuracyArchitecture,
  LunaAccuracyPredictionSet,
} from "./luna-accuracy-runner.ts";
import {
  lunaAccuracyModelHash,
  normalizeLunaAccuracyArms,
  validateLunaAccuracyRunManifestBinding,
  type LunaAccuracyExperimentArm,
  type LunaAccuracyRunManifest,
} from "./luna-accuracy-runner.ts";
import type { LunaAccuracyMatrixV2 } from "./luna-accuracy-context.ts";
import { contentHash } from "./hash.ts";
import type {
  LunaAccuracyTreatmentDistinctnessAudit,
  LunaAccuracyTreatmentEquivalenceClass,
} from "./luna-accuracy-distinctness.ts";
import type {
  ClassifierPredictionV1,
  SilverLabelV1,
  TaskEpisode,
} from "./types.ts";

export const LUNA_ACCURACY_SELECTION_POLICY_VERSION =
  "coding-first-weighted-v3-explicit-coding-annotations" as const;

export const LUNA_ACCURACY_DATA_SOURCES = [
  "real_user",
  "repository_derived",
  "synthetic_counterfactual",
] as const;

export type LunaAccuracyDataSource =
  typeof LUNA_ACCURACY_DATA_SOURCES[number];

/**
 * Fixed before candidate results are inspected. Accuracy is the objective;
 * cost is used only as the final deterministic tie-breaker.
 */
export const LUNA_ACCURACY_SELECTION_WEIGHTS = Object.freeze({
  knownCodingExactSetAccuracy: 0.35,
  macroTaskStratumAccuracy: 0.25,
  exactSemanticDecisionAccuracy: 0.2,
  knownUnknownBalancedAccuracy: 0.1,
  perAreaMacroF1: 0.05,
  unknownSubtypeMacroF1: 0.05,
});

/**
 * These are minimum anti-degeneracy gates, not claims of high precision.
 * They were fixed before Luna accuracy candidates were run. In particular,
 * absence of one task stratum does not invent a zero score: the macro metric
 * averages only strata represented by real labels and reports every omission.
 */
export const LUNA_ACCURACY_MINIMUM_DATASET_SUPPORT = Object.freeze({
  knownCodingCases: 5,
  unknownCases: 5,
  representedTaskStrata: 3,
  knownAreaIds: 2,
});

export const validateLunaAccuracyDatasetRoleForReport = (
  episodes: readonly TaskEpisode[],
  role: LunaAccuracySelectionReport["datasetRole"],
): void => {
  if (
    ![
      "burned_development",
      "validation",
      "locked_test",
    ].includes(role)
  ) {
    throw new Error(`Invalid Luna accuracy report dataset role: ${role}`);
  }
  if (
    role === "validation" &&
    episodes.some((episode) => episode.split !== "validation")
  ) {
    throw new Error(
      "A validation accuracy report may contain only validation episodes",
    );
  }
  if (
    role === "locked_test" &&
    episodes.some((episode) => episode.split !== "test")
  ) {
    throw new Error(
      "A locked-test accuracy report may contain only test episodes",
    );
  }
  if (
    role === "burned_development" &&
    episodes.some((episode) => episode.split === "reference")
  ) {
    throw new Error(
      "A burned-development accuracy report cannot contain reference examples",
    );
  }
};

export interface LunaAccuracySelectionComponents {
  knownCodingExactSetAccuracy: number;
  macroTaskStratumAccuracy: number;
  exactSemanticDecisionAccuracy: number;
  knownUnknownBalancedAccuracy: number;
  perAreaMacroF1: number;
  unknownSubtypeMacroF1: number;
}

export interface NumericSummary {
  mean: number;
  minimum: number;
  maximum: number;
}

export interface LunaAccuracyCandidateReport {
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
    selectionComponents: LunaAccuracySelectionComponents | null;
    selectionScore: number | null;
  }>;
  selection: {
    eligible: boolean;
    ineligibilityReasons: string[];
    score: NumericSummary | null;
    componentMeans: LunaAccuracySelectionComponents | null;
  };
  repeatability: {
    repeatedConfigurations: number;
    casesCompared: number;
    unanimousDecisions: number;
    unanimousRate: number | null;
  };
  usage: {
    meanCallsRepresentedPerDecision: number;
    meanInputTokensPerDecision: number | null;
    meanOutputTokensPerDecision: number | null;
    meanReasoningTokensPerDecision: number | null;
    meanCostUsdPerDecision: number | null;
    observedCostUsd: number | null;
  };
}

export interface LunaAccuracyDatasetSupport {
  requirements: typeof LUNA_ACCURACY_MINIMUM_DATASET_SUPPORT;
  observed: {
    knownCodingCases: number;
    unknownCases: number;
    representedTaskStrata: LunaAccuracyTaskStratum[];
    missingTaskStrata: LunaAccuracyTaskStratum[];
    knownAreaIds: string[];
  };
  eligibleForSelection: boolean;
  ineligibilityReasons: string[];
  warnings: string[];
}

export interface LunaAccuracySelectionReport {
  schemaVersion: 2;
  generatedAt: string;
  model: string;
  datasetRole: "burned_development" | "validation" | "locked_test";
  dataSource: LunaAccuracyDataSource;
  provenance: {
    modelHash: string;
    datasetHash: string;
    matrixHash: string;
    armsHash: string;
    runInputHash: string;
    runConfigurationHash: string;
  };
  cases: number;
  predictionSets: number;
  selectionPolicy: {
    version: typeof LUNA_ACCURACY_SELECTION_POLICY_VERSION;
    objective: "coding_first_accuracy";
    weights: typeof LUNA_ACCURACY_SELECTION_WEIGHTS;
    taskStratumPolicy: "unweighted_mean_over_label_represented_strata";
    absentStratumPolicy: "report_missing_without_imputing_zero";
    datasetSupportRequirements:
      typeof LUNA_ACCURACY_MINIMUM_DATASET_SUPPORT;
    costRole: "final_exact_tie_break_only";
    latencyRole: "reported_nowhere_and_not_optimized";
    confidenceRole: "calibration_output_not_inference_parameter";
  };
  datasetSupport: LunaAccuracyDatasetSupport;
  candidates: LunaAccuracyCandidateReport[];
  ranking: Array<{
    rank: number;
    armId: string;
    variantId: string;
    architecture: LunaAccuracyArchitecture;
    meanSelectionScore: number;
  }>;
  recommendation: {
    winnerArmId: string | null;
    winnerVariantId: string | null;
    reason: string;
  };
  limitations: string[];
}

export interface LunaAccuracyTreatmentMember {
  armId: string;
  variantId: string;
}

export interface LunaAccuracyTreatmentCandidateReport {
  treatmentId: string;
  architecture: LunaAccuracyArchitecture;
  members: LunaAccuracyTreatmentMember[];
  predictionSetIds: string[];
  evaluatedPredictionSets: number;
  casesPerPredictionSet: number;
  metricsByPredictionSet:
    LunaAccuracyCandidateReport["metricsByPredictionSet"];
  selection: LunaAccuracyCandidateReport["selection"];
  repeatability: LunaAccuracyCandidateReport["repeatability"];
  usage: LunaAccuracyCandidateReport["usage"];
}

/**
 * A companion to the unchanged raw arm report. It treats fully
 * provider-identical arms as aliases of one treatment and pools their
 * prediction-set trials before applying the same coding-first policy.
 */
export interface LunaAccuracyTreatmentSelectionReport {
  schemaVersion: 1;
  generatedAt: string;
  model: string;
  datasetRole: LunaAccuracySelectionReport["datasetRole"];
  dataSource: LunaAccuracyDataSource;
  provenance: LunaAccuracySelectionReport["provenance"] & {
    distinctnessAuditHash: string;
  };
  cases: number;
  predictionSets: number;
  arms: number;
  treatments: number;
  selectionPolicy: LunaAccuracySelectionReport["selectionPolicy"] & {
    unitOfComparison: "provider_visible_treatment";
    aliasPoolingPolicy: "all_prediction_sets_as_replicated_trials";
    aliasCostPolicy:
      "pooled_treatment_cost_only_never_alias_selection_evidence";
    canonicalAliasPolicy: "lexical_administrative_only";
  };
  datasetSupport: LunaAccuracyDatasetSupport;
  candidates: LunaAccuracyTreatmentCandidateReport[];
  ranking: Array<{
    rank: number;
    treatmentId: string;
    memberArmIds: string[];
    memberVariantIds: string[];
    architecture: LunaAccuracyArchitecture;
    meanSelectionScore: number;
  }>;
  recommendation: {
    winnerTreatmentId: string | null;
    memberArmIds: string[];
    memberVariantIds: string[];
    canonicalArmId: string | null;
    canonicalVariantId: string | null;
    canonicalAliasBasis: "lexical_administrative_only" | null;
    reason: string;
  };
  limitations: string[];
}

const mean = (values: readonly number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

const summary = (values: readonly number[]): NumericSummary => ({
  mean: mean(values),
  minimum: Math.min(...values),
  maximum: Math.max(...values),
});

const labelTaskStratum = (
  label: SilverLabelV1,
): LunaAccuracyTaskStratum =>
  label.known
    ? label.selectedAreaIds.length === 1
      ? "known_single"
      : "known_multi"
    : label.unknownType!;

export const assessLunaAccuracyDatasetSupport = (
  labels: readonly SilverLabelV1[],
  codingEpisodeIds: ReadonlySet<string>,
): LunaAccuracyDatasetSupport => {
  const labelIds = new Set(labels.map((label) => label.taskEpisodeId));
  const unknownCodingIds = [...codingEpisodeIds].filter(
    (id) => !labelIds.has(id),
  );
  if (unknownCodingIds.length > 0) {
    throw new Error(
      `Coding annotation contains unknown label IDs: ${unknownCodingIds.sort().join(", ")}`,
    );
  }
  const knownCodingCases = labels.filter(
    (label) => label.known && codingEpisodeIds.has(label.taskEpisodeId),
  ).length;
  const unknownCases = labels.filter((label) => !label.known).length;
  const represented = new Set(labels.map(labelTaskStratum));
  const representedTaskStrata = LUNA_ACCURACY_TASK_STRATA.filter(
    (stratum) => represented.has(stratum),
  );
  const missingTaskStrata = LUNA_ACCURACY_TASK_STRATA.filter(
    (stratum) => !represented.has(stratum),
  );
  const knownAreaIds = [
    ...new Set(
      labels
        .filter(
          (label) =>
            label.known && codingEpisodeIds.has(label.taskEpisodeId),
        )
        .flatMap((label) => label.selectedAreaIds),
    ),
  ].sort();
  const ineligibilityReasons: string[] = [];
  if (
    knownCodingCases <
      LUNA_ACCURACY_MINIMUM_DATASET_SUPPORT.knownCodingCases
  ) {
    ineligibilityReasons.push(
      `Only ${knownCodingCases} known-coding labels; at least ${LUNA_ACCURACY_MINIMUM_DATASET_SUPPORT.knownCodingCases} are required`,
    );
  }
  if (
    unknownCases < LUNA_ACCURACY_MINIMUM_DATASET_SUPPORT.unknownCases
  ) {
    ineligibilityReasons.push(
      `Only ${unknownCases} unknown labels; at least ${LUNA_ACCURACY_MINIMUM_DATASET_SUPPORT.unknownCases} are required`,
    );
  }
  if (
    representedTaskStrata.length <
      LUNA_ACCURACY_MINIMUM_DATASET_SUPPORT.representedTaskStrata
  ) {
    ineligibilityReasons.push(
      `Only ${representedTaskStrata.length} task strata are represented; at least ${LUNA_ACCURACY_MINIMUM_DATASET_SUPPORT.representedTaskStrata} are required`,
    );
  }
  if (
    knownAreaIds.length <
      LUNA_ACCURACY_MINIMUM_DATASET_SUPPORT.knownAreaIds
  ) {
    ineligibilityReasons.push(
      `Only ${knownAreaIds.length} known area IDs are represented; at least ${LUNA_ACCURACY_MINIMUM_DATASET_SUPPORT.knownAreaIds} are required`,
    );
  }
  const warnings: string[] = [];
  if (missingTaskStrata.length > 0) {
    warnings.push(
      `Unrepresented task strata: ${missingTaskStrata.join(", ")}. Their accuracy is unknown and no zero or synthetic score is imputed.`,
    );
  }
  if (knownCodingCases < 20) {
    warnings.push(
      `Known-coding accuracy is based on only ${knownCodingCases} real cases and therefore has high sampling uncertainty.`,
    );
  }
  return {
    requirements: LUNA_ACCURACY_MINIMUM_DATASET_SUPPORT,
    observed: {
      knownCodingCases,
      unknownCases,
      representedTaskStrata: [...representedTaskStrata],
      missingTaskStrata: [...missingTaskStrata],
      knownAreaIds,
    },
    eligibleForSelection: ineligibilityReasons.length === 0,
    ineligibilityReasons,
    warnings,
  };
};

export const lunaAccuracySelectionComponents = (
  metrics: LunaAccuracyMetrics,
): LunaAccuracySelectionComponents | null => {
  const components = {
    knownCodingExactSetAccuracy:
      metrics.knownCodingExactSet.accuracy,
    macroTaskStratumAccuracy: metrics.macroTaskStratumAccuracy,
    exactSemanticDecisionAccuracy:
      metrics.exactSemanticDecision.accuracy,
    knownUnknownBalancedAccuracy:
      metrics.knownUnknown.balancedAccuracy,
    perAreaMacroF1: metrics.perAreaMacroF1,
    unknownSubtypeMacroF1: metrics.unknownSubtypeMacroF1,
  };
  return Object.values(components).every(
      (value): value is number => value !== null,
    )
    ? components as LunaAccuracySelectionComponents
    : null;
};

export const lunaAccuracySelectionScore = (
  components: LunaAccuracySelectionComponents,
): number =>
  Object.entries(LUNA_ACCURACY_SELECTION_WEIGHTS).reduce(
    (total, [key, weight]) =>
      total +
      components[key as keyof LunaAccuracySelectionComponents] * weight,
    0,
  );

const exactJoin = (
  episodes: readonly TaskEpisode[],
  labels: readonly SilverLabelV1[],
): void => {
  const episodeIds = episodes.map((episode) => episode.id);
  const labelIds = labels.map((label) => label.taskEpisodeId);
  if (
    new Set(episodeIds).size !== episodeIds.length ||
    new Set(labelIds).size !== labelIds.length
  ) {
    throw new Error("Accuracy report inputs require unique episode and label IDs");
  }
  const expected = [...episodeIds].sort();
  const actual = [...labelIds].sort();
  if (
    expected.length !== actual.length ||
    expected.some((id, index) => id !== actual[index])
  ) {
    throw new Error("Accuracy report episodes and labels need an exact join");
  }
};

const decisionKey = (prediction: ClassifierPredictionV1): string =>
  JSON.stringify({
    known: prediction.known,
    selectedAreaIds: [...prediction.selectedAreaIds].sort(),
    unknownType: prediction.unknownType ?? null,
  });

const repeatability = (
  sets: readonly LunaAccuracyPredictionSet[],
): LunaAccuracyCandidateReport["repeatability"] => {
  if (sets.length < 2) {
    return {
      repeatedConfigurations: sets.length,
      casesCompared: 0,
      unanimousDecisions: 0,
      unanimousRate: null,
    };
  }
  const bySet = sets.map(
    (set) =>
      new Map(
        set.predictions.map((prediction) => [
          prediction.taskEpisodeId,
          prediction,
        ]),
      ),
  );
  const caseIds = [...bySet[0]!.keys()].sort();
  let unanimousDecisions = 0;
  for (const caseId of caseIds) {
    const decisions = new Set(
      bySet.map((values) => {
        const prediction = values.get(caseId);
        if (!prediction) {
          throw new Error(
            `Repeated prediction set is missing case ${caseId}`,
          );
        }
        return decisionKey(prediction);
      }),
    );
    if (decisions.size === 1) unanimousDecisions += 1;
  }
  return {
    repeatedConfigurations: sets.length,
    casesCompared: caseIds.length,
    unanimousDecisions,
    unanimousRate: caseIds.length
      ? unanimousDecisions / caseIds.length
      : null,
  };
};

const completeNumericTotal = (
  predictions: readonly ClassifierPredictionV1[],
  field:
    | "inputTokens"
    | "outputTokens"
    | "reasoningOutputTokens"
    | "costUsd",
): number | null => {
  const values = predictions.map((prediction) => prediction[field]);
  return values.every(
      (value): value is number =>
        typeof value === "number" && Number.isFinite(value),
    )
    ? values.reduce((sum, value) => sum + value, 0)
    : null;
};

const callsRepresentedByArchitecture = (
  architecture: LunaAccuracyArchitecture,
): number => architecture === "single_call" ? 1 : 3;

const usage = (
  sets: readonly LunaAccuracyPredictionSet[],
): LunaAccuracyCandidateReport["usage"] => {
  const decisions = sets.reduce(
    (count, set) => count + set.predictions.length,
    0,
  );
  const predictions = sets.flatMap((set) => set.predictions);
  const architecture = sets[0]!.architecture;
  const normalized = (
    field:
      | "inputTokens"
      | "outputTokens"
      | "reasoningOutputTokens"
      | "costUsd",
  ): number | null => {
    const total = completeNumericTotal(predictions, field);
    return total === null || decisions === 0 ? null : total / decisions;
  };
  return {
    meanCallsRepresentedPerDecision:
      callsRepresentedByArchitecture(architecture),
    meanInputTokensPerDecision: normalized("inputTokens"),
    meanOutputTokensPerDecision: normalized("outputTokens"),
    meanReasoningTokensPerDecision: normalized("reasoningOutputTokens"),
    meanCostUsdPerDecision: normalized("costUsd"),
    observedCostUsd: completeNumericTotal(predictions, "costUsd"),
  };
};

const averageComponents = (
  values: readonly LunaAccuracySelectionComponents[],
): LunaAccuracySelectionComponents => ({
  knownCodingExactSetAccuracy: mean(
    values.map((value) => value.knownCodingExactSetAccuracy),
  ),
  macroTaskStratumAccuracy: mean(
    values.map((value) => value.macroTaskStratumAccuracy),
  ),
  exactSemanticDecisionAccuracy: mean(
    values.map((value) => value.exactSemanticDecisionAccuracy),
  ),
  knownUnknownBalancedAccuracy: mean(
    values.map((value) => value.knownUnknownBalancedAccuracy),
  ),
  perAreaMacroF1: mean(values.map((value) => value.perAreaMacroF1)),
  unknownSubtypeMacroF1: mean(
    values.map((value) => value.unknownSubtypeMacroF1),
  ),
});

const candidateReport = (
  labels: readonly SilverLabelV1[],
  sets: readonly LunaAccuracyPredictionSet[],
  datasetSupport: LunaAccuracyDatasetSupport,
  codingEpisodeIds: ReadonlySet<string>,
): LunaAccuracyCandidateReport => {
  if (sets.length === 0) {
    throw new Error("Accuracy candidate requires at least one prediction set");
  }
  const [first] = sets;
  if (
    sets.some(
      (set) =>
        set.armId !== first!.armId ||
        set.variantId !== first!.variantId ||
        set.architecture !== first!.architecture,
    )
  ) {
    throw new Error("Cannot combine prediction sets from different candidates");
  }
  const metricsByPredictionSet = sets.map((set) => {
    const metrics = calculateLunaAccuracyMetrics(
      labels,
      set.predictions,
      { codingEpisodeIds },
    );
    const components = lunaAccuracySelectionComponents(metrics);
    return {
      predictionSetId: set.id,
      repetitionIndex: set.repetitionIndex,
      seeds: [...set.seeds],
      metrics,
      selectionComponents: components,
      selectionScore:
        components === null ? null : lunaAccuracySelectionScore(components),
    };
  });
  const missing = [
    ...datasetSupport.ineligibilityReasons.map(
      (reason) => `Dataset support gate: ${reason}`,
    ),
    ...metricsByPredictionSet
    .filter((set) => set.selectionComponents === null)
    .map(
      (set) =>
        `${set.predictionSetId} has an undefined required metric component`,
    ),
  ];
  const components = metricsByPredictionSet
    .map((set) => set.selectionComponents)
    .filter(
      (value): value is LunaAccuracySelectionComponents => value !== null,
    );
  const scores = metricsByPredictionSet
    .map((set) => set.selectionScore)
    .filter((value): value is number => value !== null);
  const cases = metricsByPredictionSet[0]!.metrics.cases;
  if (
    metricsByPredictionSet.some((set) => set.metrics.cases !== cases)
  ) {
    throw new Error("Candidate repetitions used different case counts");
  }
  return {
    armId: first!.armId,
    variantId: first!.variantId,
    architecture: first!.architecture,
    predictionSetIds: sets.map((set) => set.id),
    evaluatedPredictionSets: sets.length,
    casesPerPredictionSet: cases,
    metricsByPredictionSet,
    selection: {
      eligible: missing.length === 0,
      ineligibilityReasons: missing,
      score: scores.length === sets.length ? summary(scores) : null,
      componentMeans:
        components.length === sets.length
          ? averageComponents(components)
          : null,
    },
    repeatability: repeatability(sets),
    usage: usage(sets),
  };
};

const compareCandidates = (
  left: LunaAccuracyCandidateReport,
  right: LunaAccuracyCandidateReport,
): number => {
  const a = left.selection;
  const b = right.selection;
  if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
  if (!a.eligible || !a.score || !b.score) {
    return left.armId.localeCompare(right.armId);
  }
  const aComponents = a.componentMeans!;
  const bComponents = b.componentMeans!;
  const comparisons: Array<[number, number, "higher" | "lower"]> = [
    [a.score.mean, b.score.mean, "higher"],
    [
      aComponents.knownCodingExactSetAccuracy,
      bComponents.knownCodingExactSetAccuracy,
      "higher",
    ],
    [
      aComponents.macroTaskStratumAccuracy,
      bComponents.macroTaskStratumAccuracy,
      "higher",
    ],
    [
      aComponents.exactSemanticDecisionAccuracy,
      bComponents.exactSemanticDecisionAccuracy,
      "higher",
    ],
    [
      left.repeatability.unanimousRate ?? -1,
      right.repeatability.unanimousRate ?? -1,
      "higher",
    ],
    [
      left.usage.meanCostUsdPerDecision ?? Number.POSITIVE_INFINITY,
      right.usage.meanCostUsdPerDecision ?? Number.POSITIVE_INFINITY,
      "lower",
    ],
  ];
  for (const [leftValue, rightValue, direction] of comparisons) {
    if (leftValue === rightValue) continue;
    return direction === "higher"
      ? rightValue - leftValue
      : leftValue - rightValue;
  }
  return left.armId.localeCompare(right.armId);
};

const treatmentCandidateReport = (
  labels: readonly SilverLabelV1[],
  sets: readonly LunaAccuracyPredictionSet[],
  datasetSupport: LunaAccuracyDatasetSupport,
  codingEpisodeIds: ReadonlySet<string>,
  treatmentId: string,
  members: readonly LunaAccuracyTreatmentMember[],
): LunaAccuracyTreatmentCandidateReport => {
  if (sets.length === 0) {
    throw new Error("Accuracy treatment requires at least one prediction set");
  }
  const architecture = sets[0]!.architecture;
  if (sets.some((set) => set.architecture !== architecture)) {
    throw new Error(
      `Cannot pool cross-architecture treatment ${treatmentId}`,
    );
  }
  const memberByArm = new Map(
    members.map((member) => [member.armId, member]),
  );
  for (const set of sets) {
    const member = memberByArm.get(set.armId);
    if (!member || member.variantId !== set.variantId) {
      throw new Error(
        `Prediction set ${set.id} is not bound to treatment ${treatmentId}`,
      );
    }
  }
  const metricsByPredictionSet = sets.map((set) => {
    const metrics = calculateLunaAccuracyMetrics(
      labels,
      set.predictions,
      { codingEpisodeIds },
    );
    const components = lunaAccuracySelectionComponents(metrics);
    return {
      predictionSetId: set.id,
      repetitionIndex: set.repetitionIndex,
      seeds: [...set.seeds],
      metrics,
      selectionComponents: components,
      selectionScore:
        components === null ? null : lunaAccuracySelectionScore(components),
    };
  });
  const missing = [
    ...datasetSupport.ineligibilityReasons.map(
      (reason) => `Dataset support gate: ${reason}`,
    ),
    ...metricsByPredictionSet
      .filter((set) => set.selectionComponents === null)
      .map(
        (set) =>
          `${set.predictionSetId} has an undefined required metric component`,
      ),
  ];
  const components = metricsByPredictionSet
    .map((set) => set.selectionComponents)
    .filter(
      (value): value is LunaAccuracySelectionComponents => value !== null,
    );
  const scores = metricsByPredictionSet
    .map((set) => set.selectionScore)
    .filter((value): value is number => value !== null);
  const cases = metricsByPredictionSet[0]!.metrics.cases;
  if (metricsByPredictionSet.some((set) => set.metrics.cases !== cases)) {
    throw new Error("Treatment trials used different case counts");
  }
  return {
    treatmentId,
    architecture,
    members: [...members].sort((left, right) =>
      left.armId.localeCompare(right.armId)
    ),
    predictionSetIds: sets.map((set) => set.id),
    evaluatedPredictionSets: sets.length,
    casesPerPredictionSet: cases,
    metricsByPredictionSet,
    selection: {
      eligible: missing.length === 0,
      ineligibilityReasons: missing,
      score: scores.length === sets.length ? summary(scores) : null,
      componentMeans:
        components.length === sets.length
          ? averageComponents(components)
          : null,
    },
    repeatability: repeatability(sets),
    usage: usage(sets),
  };
};

const compareTreatments = (
  left: LunaAccuracyTreatmentCandidateReport,
  right: LunaAccuracyTreatmentCandidateReport,
): number => {
  const a = left.selection;
  const b = right.selection;
  if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
  if (!a.eligible || !a.score || !b.score) {
    return left.treatmentId.localeCompare(right.treatmentId);
  }
  const aComponents = a.componentMeans!;
  const bComponents = b.componentMeans!;
  const comparisons: Array<[number, number, "higher" | "lower"]> = [
    [a.score.mean, b.score.mean, "higher"],
    [
      aComponents.knownCodingExactSetAccuracy,
      bComponents.knownCodingExactSetAccuracy,
      "higher",
    ],
    [
      aComponents.macroTaskStratumAccuracy,
      bComponents.macroTaskStratumAccuracy,
      "higher",
    ],
    [
      aComponents.exactSemanticDecisionAccuracy,
      bComponents.exactSemanticDecisionAccuracy,
      "higher",
    ],
    [
      left.repeatability.unanimousRate ?? -1,
      right.repeatability.unanimousRate ?? -1,
      "higher",
    ],
    [
      left.usage.meanCostUsdPerDecision ?? Number.POSITIVE_INFINITY,
      right.usage.meanCostUsdPerDecision ?? Number.POSITIVE_INFINITY,
      "lower",
    ],
  ];
  for (const [leftValue, rightValue, direction] of comparisons) {
    if (leftValue === rightValue) continue;
    return direction === "higher"
      ? rightValue - leftValue
      : leftValue - rightValue;
  }
  return left.treatmentId.localeCompare(right.treatmentId);
};

/**
 * Produces a private-data-safe metric document: prediction decisions are used
 * to calculate aggregates but are not copied into the report.
 */
export const buildLunaAccuracySelectionReport = (input: {
  model: string;
  datasetRole: LunaAccuracySelectionReport["datasetRole"];
  dataSource: LunaAccuracyDataSource;
  episodes: readonly TaskEpisode[];
  labels: readonly SilverLabelV1[];
  predictionSets: readonly LunaAccuracyPredictionSet[];
  runManifest: LunaAccuracyRunManifest;
  matrix: LunaAccuracyMatrixV2;
  arms?: readonly LunaAccuracyExperimentArm[];
  /** Explicit, frozen coding/noncoding annotation used by the 35% metric. */
  codingEpisodeIds: ReadonlySet<string>;
  generatedAt?: string;
}): LunaAccuracySelectionReport => {
  if (!input.model.trim()) throw new Error("Accuracy report requires a model");
  if (!LUNA_ACCURACY_DATA_SOURCES.includes(input.dataSource)) {
    throw new Error(
      `Invalid Luna accuracy data source: ${String(input.dataSource)}`,
    );
  }
  validateLunaAccuracyRunManifestBinding({
    manifest: input.runManifest,
    model: input.model,
    episodes: input.episodes,
    matrix: input.matrix,
    ...(input.arms ? { arms: input.arms } : {}),
  });
  validateLunaAccuracyDatasetRoleForReport(
    input.episodes,
    input.datasetRole,
  );
  exactJoin(input.episodes, input.labels);
  if (input.predictionSets.length === 0) {
    throw new Error("Accuracy report requires at least one prediction set");
  }
  const setIds = input.predictionSets.map((set) => set.id);
  if (new Set(setIds).size !== setIds.length) {
    throw new Error("Accuracy report prediction-set IDs must be unique");
  }
  const byArm = new Map<string, LunaAccuracyPredictionSet[]>();
  for (const set of input.predictionSets) {
    const values = byArm.get(set.armId) ?? [];
    values.push(set);
    byArm.set(set.armId, values);
  }
  const datasetSupport = assessLunaAccuracyDatasetSupport(
    input.labels,
    input.codingEpisodeIds,
  );
  const candidates = [...byArm.values()]
    .map((sets) =>
      candidateReport(
        input.labels,
        [...sets].sort(
          (left, right) =>
            (left.repetitionIndex ?? -1) -
              (right.repetitionIndex ?? -1) ||
            left.id.localeCompare(right.id),
        ),
        datasetSupport,
        input.codingEpisodeIds,
      )
    )
    .sort(compareCandidates);
  const eligible = candidates.filter(
    (candidate) => candidate.selection.eligible,
  );
  const ranking = eligible.map((candidate, index) => ({
    rank: index + 1,
    armId: candidate.armId,
    variantId: candidate.variantId,
    architecture: candidate.architecture,
    meanSelectionScore: candidate.selection.score!.mean,
  }));
  const selectionAllowed =
    input.datasetRole === "validation" &&
    input.dataSource === "real_user";
  const winner = selectionAllowed ? eligible[0] : undefined;
  const limitations = [
    "Selection scores are descriptive validation estimates, not proof that small differences generalize.",
    "Silver-label quality bounds the attainable validity of every reported metric.",
    "Synthetic or repository-derived challenge scores must be reported in separate documents and never blended into this real-data ranking.",
  ];
  if (input.datasetRole === "burned_development") {
    limitations.push(
      "This development set has already been inspected and may be used only for debugging, never for final selection claims.",
    );
  }
  if (input.dataSource !== "real_user") {
    limitations.push(
      "Repository-derived and synthetic-counterfactual results are development or stress-test evidence only and cannot select the product configuration.",
    );
  }
  if (input.datasetRole === "locked_test") {
    limitations.push(
      "The locked test is a one-time estimate; this report must not trigger further tuning on its cases.",
    );
  }
  limitations.push(...datasetSupport.warnings);
  return {
    schemaVersion: 2,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    model: input.model,
    datasetRole: input.datasetRole,
    dataSource: input.dataSource,
    provenance: {
      modelHash: lunaAccuracyModelHash(input.model),
      datasetHash: input.runManifest.hashes.runtimeEpisodes,
      matrixHash: input.runManifest.hashes.matrix,
      armsHash: input.runManifest.hashes.arms,
      runInputHash: input.runManifest.inputHash,
      runConfigurationHash: input.runManifest.configurationHash,
    },
    cases: input.episodes.length,
    predictionSets: input.predictionSets.length,
    selectionPolicy: {
      version: LUNA_ACCURACY_SELECTION_POLICY_VERSION,
      objective: "coding_first_accuracy",
      weights: LUNA_ACCURACY_SELECTION_WEIGHTS,
      taskStratumPolicy:
        "unweighted_mean_over_label_represented_strata",
      absentStratumPolicy: "report_missing_without_imputing_zero",
      datasetSupportRequirements:
        LUNA_ACCURACY_MINIMUM_DATASET_SUPPORT,
      costRole: "final_exact_tie_break_only",
      latencyRole: "reported_nowhere_and_not_optimized",
      confidenceRole: "calibration_output_not_inference_parameter",
    },
    datasetSupport,
    candidates,
    ranking,
    recommendation: {
      winnerArmId: winner?.armId ?? null,
      winnerVariantId: winner?.variantId ?? null,
      reason: !selectionAllowed
        ? "This report is descriptive only: product selection requires an unburned validation report over real-user data."
        : winner
        ? "Highest pre-registered coding-first validation score; deterministic ties use component accuracy, repeatability, then lower cost."
        : "No candidate satisfied the pre-registered metric and real-user dataset support requirements.",
    },
    limitations,
  };
};

interface LunaAccuracyTreatmentGroup {
  treatmentId: string;
  architecture: LunaAccuracyArchitecture;
  members: LunaAccuracyTreatmentMember[];
}

const validateTreatmentDistinctnessBinding = (input: {
  audit: LunaAccuracyTreatmentDistinctnessAudit;
  model: string;
  episodes: readonly TaskEpisode[];
  matrix: LunaAccuracyMatrixV2;
  arms: readonly LunaAccuracyExperimentArm[];
  runManifest: LunaAccuracyRunManifest;
}): void => {
  const { audit } = input;
  if (audit.schemaVersion !== 1) {
    throw new Error("Unsupported Luna treatment-distinctness audit schema");
  }
  if (
    audit.model !== input.model ||
    audit.provenance.modelHash !== lunaAccuracyModelHash(input.model) ||
    audit.provenance.datasetHash !==
      input.runManifest.hashes.runtimeEpisodes ||
    audit.provenance.matrixHash !== input.runManifest.hashes.matrix ||
    audit.provenance.armsHash !== input.runManifest.hashes.arms ||
    audit.cases !== input.episodes.length ||
    audit.arms !== input.arms.length
  ) {
    throw new Error(
      "Treatment-distinctness audit is not bound to this model, dataset, matrix, and arm set",
    );
  }
  if (
    audit.provenance.matrixHash !==
      contentHash(input.matrix) ||
    audit.provenance.armsHash !==
      contentHash(input.arms)
  ) {
    throw new Error(
      "Treatment-distinctness audit matrix or arms hash is invalid",
    );
  }
};

const treatmentGroups = (input: {
  audit: LunaAccuracyTreatmentDistinctnessAudit;
  arms: readonly LunaAccuracyExperimentArm[];
}): LunaAccuracyTreatmentGroup[] => {
  const armById = new Map(input.arms.map((arm) => [arm.id, arm]));
  const validatePairArm = (
    armId: string,
    architecture: LunaAccuracyArchitecture,
    pairKind: string,
  ): void => {
    const arm = armById.get(armId);
    if (!arm) {
      throw new Error(
        `${pairKind} references unknown arm ${armId}`,
      );
    }
    if (arm.architecture !== architecture) {
      throw new Error(
        `${pairKind} crosses architectures at arm ${armId}`,
      );
    }
  };
  for (const pair of [
    ...input.audit.equivalentPairs,
    ...input.audit.partiallyExposedPairs,
  ]) {
    validatePairArm(
      pair.leftArmId,
      pair.architecture,
      "Treatment distinctness pair",
    );
    validatePairArm(
      pair.rightArmId,
      pair.architecture,
      "Treatment distinctness pair",
    );
    if (pair.leftArmId === pair.rightArmId) {
      throw new Error("Treatment distinctness pair cannot repeat one arm");
    }
  }
  const assigned = new Map<string, string>();
  const treatmentIds = new Set<string>();
  const groups: LunaAccuracyTreatmentGroup[] = [];
  const addEquivalenceClass = (
    equivalenceClass: LunaAccuracyTreatmentEquivalenceClass,
  ): void => {
    if (
      typeof equivalenceClass.treatmentId !== "string" ||
      !equivalenceClass.treatmentId.trim()
    ) {
      throw new Error("Treatment equivalence class requires a treatment ID");
    }
    if (treatmentIds.has(equivalenceClass.treatmentId)) {
      throw new Error(
        `Duplicate treatment ID ${equivalenceClass.treatmentId}`,
      );
    }
    treatmentIds.add(equivalenceClass.treatmentId);
    const memberArmIds = [...equivalenceClass.memberArmIds];
    if (
      memberArmIds.length < 2 ||
      new Set(memberArmIds).size !== memberArmIds.length
    ) {
      throw new Error(
        `Treatment ${equivalenceClass.treatmentId} requires at least two unique arms`,
      );
    }
    const members = memberArmIds.map((armId) => {
      const arm = armById.get(armId);
      if (!arm) {
        throw new Error(
          `Treatment ${equivalenceClass.treatmentId} references unknown arm ${armId}`,
        );
      }
      if (assigned.has(armId)) {
        throw new Error(
          `Arm ${armId} appears in overlapping treatment equivalence classes`,
        );
      }
      if (arm.architecture !== equivalenceClass.architecture) {
        throw new Error(
          `Treatment ${equivalenceClass.treatmentId} crosses architectures`,
        );
      }
      assigned.set(armId, equivalenceClass.treatmentId);
      return { armId: arm.id, variantId: arm.variantId };
    });
    if (
      !Number.isInteger(equivalenceClass.alignedRequestsPerArm) ||
      equivalenceClass.alignedRequestsPerArm < 1
    ) {
      throw new Error(
        `Treatment ${equivalenceClass.treatmentId} has invalid aligned request count`,
      );
    }
    groups.push({
      treatmentId: equivalenceClass.treatmentId,
      architecture: equivalenceClass.architecture,
      members,
    });
  };
  for (const equivalenceClass of input.audit.equivalenceClasses) {
    addEquivalenceClass(equivalenceClass);
  }
  for (const arm of input.arms) {
    if (assigned.has(arm.id)) continue;
    const treatmentId = contentHash({
      schemaVersion: 1,
      kind: "singleton_provider_visible_treatment",
      architecture: arm.architecture,
      armId: arm.id,
      variantId: arm.variantId,
      distinctnessAuditHash: contentHash(input.audit),
    });
    if (treatmentIds.has(treatmentId)) {
      throw new Error(`Duplicate singleton treatment ID ${treatmentId}`);
    }
    treatmentIds.add(treatmentId);
    assigned.set(arm.id, treatmentId);
    groups.push({
      treatmentId,
      architecture: arm.architecture,
      members: [{ armId: arm.id, variantId: arm.variantId }],
    });
  }
  if (
    assigned.size !== input.arms.length ||
    input.arms.some((arm) => !assigned.has(arm.id))
  ) {
    throw new Error("Every experiment arm must appear in exactly one treatment");
  }
  const treatmentForArm = new Map(
    groups.flatMap((group) =>
      group.members.map(
        (member) => [member.armId, group.treatmentId] as const,
      )
    ),
  );
  for (const pair of input.audit.equivalentPairs) {
    if (!pair.fullyEquivalent) {
      throw new Error(
        "Equivalent treatment pair must be marked fully equivalent",
      );
    }
    if (
      treatmentForArm.get(pair.leftArmId) !==
        treatmentForArm.get(pair.rightArmId)
    ) {
      throw new Error(
        `Provider-equivalent arms ${pair.leftArmId} and ${pair.rightArmId} are missing a shared treatment equivalence class`,
      );
    }
  }
  for (const group of groups.filter((value) => value.members.length > 1)) {
    for (let left = 0; left < group.members.length; left += 1) {
      for (
        let right = left + 1;
        right < group.members.length;
        right += 1
      ) {
        const leftArmId = group.members[left]!.armId;
        const rightArmId = group.members[right]!.armId;
        const audited = input.audit.equivalentPairs.some(
          (pair) =>
            (
              pair.leftArmId === leftArmId &&
              pair.rightArmId === rightArmId
            ) ||
            (
              pair.leftArmId === rightArmId &&
              pair.rightArmId === leftArmId
            ),
        );
        if (!audited) {
          throw new Error(
            `Treatment ${group.treatmentId} groups arms without a fully equivalent pair audit`,
          );
        }
      }
    }
  }
  return groups.sort((left, right) =>
    left.members[0]!.armId.localeCompare(right.members[0]!.armId)
  );
};

/**
 * Builds a treatment-aware companion report without altering the raw arm
 * report schema or its ranking. Fully provider-identical arms are aliases:
 * every prediction-set result is pooled as a repeated trial of the same
 * provider-visible treatment.
 */
export const buildLunaAccuracyTreatmentSelectionReport = (input: {
  model: string;
  datasetRole: LunaAccuracySelectionReport["datasetRole"];
  dataSource: LunaAccuracyDataSource;
  episodes: readonly TaskEpisode[];
  labels: readonly SilverLabelV1[];
  predictionSets: readonly LunaAccuracyPredictionSet[];
  runManifest: LunaAccuracyRunManifest;
  matrix: LunaAccuracyMatrixV2;
  arms?: readonly LunaAccuracyExperimentArm[];
  distinctnessAudit: LunaAccuracyTreatmentDistinctnessAudit;
  codingEpisodeIds: ReadonlySet<string>;
  generatedAt?: string;
}): LunaAccuracyTreatmentSelectionReport => {
  const rawReport = buildLunaAccuracySelectionReport({
    model: input.model,
    datasetRole: input.datasetRole,
    dataSource: input.dataSource,
    episodes: input.episodes,
    labels: input.labels,
    predictionSets: input.predictionSets,
    runManifest: input.runManifest,
    matrix: input.matrix,
    ...(input.arms ? { arms: input.arms } : {}),
    codingEpisodeIds: input.codingEpisodeIds,
    ...(input.generatedAt ? { generatedAt: input.generatedAt } : {}),
  });
  const arms = normalizeLunaAccuracyArms(input.matrix, input.arms);
  validateTreatmentDistinctnessBinding({
    audit: input.distinctnessAudit,
    model: input.model,
    episodes: input.episodes,
    matrix: input.matrix,
    arms,
    runManifest: input.runManifest,
  });
  const groups = treatmentGroups({
    audit: input.distinctnessAudit,
    arms,
  });
  const groupByArm = new Map(
    groups.flatMap((group) =>
      group.members.map((member) => [member.armId, group] as const)
    ),
  );
  const setsByTreatment = new Map<
    string,
    LunaAccuracyPredictionSet[]
  >();
  for (const set of input.predictionSets) {
    const group = groupByArm.get(set.armId);
    if (!group) {
      throw new Error(
        `Prediction set ${set.id} references arm absent from treatment audit`,
      );
    }
    const values = setsByTreatment.get(group.treatmentId) ?? [];
    values.push(set);
    setsByTreatment.set(group.treatmentId, values);
  }
  const candidates = groups
    .map((group) => {
      const sets = setsByTreatment.get(group.treatmentId);
      if (!sets?.length) {
        throw new Error(
          `Treatment ${group.treatmentId} has no prediction sets`,
        );
      }
      return treatmentCandidateReport(
        input.labels,
        [...sets].sort(
          (left, right) =>
            left.armId.localeCompare(right.armId) ||
            (left.repetitionIndex ?? -1) -
              (right.repetitionIndex ?? -1) ||
            left.id.localeCompare(right.id),
        ),
        rawReport.datasetSupport,
        input.codingEpisodeIds,
        group.treatmentId,
        group.members,
      );
    })
    .sort(compareTreatments);
  const eligible = candidates.filter(
    (candidate) => candidate.selection.eligible,
  );
  const ranking = eligible.map((candidate, index) => ({
    rank: index + 1,
    treatmentId: candidate.treatmentId,
    memberArmIds: candidate.members.map((member) => member.armId),
    memberVariantIds: candidate.members.map((member) => member.variantId),
    architecture: candidate.architecture,
    meanSelectionScore: candidate.selection.score!.mean,
  }));
  const selectionAllowed =
    input.datasetRole === "validation" &&
    input.dataSource === "real_user";
  const winner = selectionAllowed ? eligible[0] : undefined;
  const canonical = winner?.members[0];
  return {
    schemaVersion: 1,
    generatedAt: rawReport.generatedAt,
    model: rawReport.model,
    datasetRole: rawReport.datasetRole,
    dataSource: rawReport.dataSource,
    provenance: {
      ...rawReport.provenance,
      distinctnessAuditHash: contentHash(input.distinctnessAudit),
    },
    cases: rawReport.cases,
    predictionSets: rawReport.predictionSets,
    arms: arms.length,
    treatments: candidates.length,
    selectionPolicy: {
      ...rawReport.selectionPolicy,
      unitOfComparison: "provider_visible_treatment",
      aliasPoolingPolicy: "all_prediction_sets_as_replicated_trials",
      aliasCostPolicy:
        "pooled_treatment_cost_only_never_alias_selection_evidence",
      canonicalAliasPolicy: "lexical_administrative_only",
    },
    datasetSupport: rawReport.datasetSupport,
    candidates,
    ranking,
    recommendation: {
      winnerTreatmentId: winner?.treatmentId ?? null,
      memberArmIds:
        winner?.members.map((member) => member.armId) ?? [],
      memberVariantIds:
        winner?.members.map((member) => member.variantId) ?? [],
      canonicalArmId: canonical?.armId ?? null,
      canonicalVariantId: canonical?.variantId ?? null,
      canonicalAliasBasis:
        canonical ? "lexical_administrative_only" : null,
      reason: !selectionAllowed
        ? "This report is descriptive only: product selection requires an unburned validation report over real-user data."
        : winner
        ? "Highest coding-first score among distinct provider-visible treatments. Provider-identical aliases were pooled as repeated trials; no alias was selected using accuracy or cost."
        : "No treatment satisfied the pre-registered metric and real-user dataset support requirements.",
    },
    limitations: [
      ...rawReport.limitations,
      "Provider-identical aliases estimate stochastic treatment variation; differences between their arm-level scores or costs are not treatment effects.",
      "The canonical alias is lexical and administrative only. It is not evidence that one alias performs better than another.",
    ],
  };
};

export interface LunaAccuracyTopTwoComparisonReport {
  schemaVersion: 1;
  winnerArmId: string;
  runnerUpArmId: string;
  comparisons: Partial<
    Record<LunaBootstrapMetric, LunaClusterBootstrapComparison>
  >;
  note: string;
}

/**
 * Adds dependence-aware paired intervals after ranking. It intentionally
 * compares a single fixed prediction set per finalist; Phase 2 seed
 * repetitions should first be reported separately rather than cherry-picked.
 */
export const compareLunaAccuracyTopTwo = (input: {
  report: LunaAccuracySelectionReport;
  episodes: readonly TaskEpisode[];
  labels: readonly SilverLabelV1[];
  predictionSets: readonly LunaAccuracyPredictionSet[];
  codingEpisodeIds: ReadonlySet<string>;
  metrics?: readonly LunaBootstrapMetric[];
  iterations?: number;
  seed?: number;
}): LunaAccuracyTopTwoComparisonReport => {
  const [winner, runnerUp] = input.report.ranking;
  if (!winner || !runnerUp) {
    throw new Error("Top-two comparison requires two eligible candidates");
  }
  const setFor = (armId: string): LunaAccuracyPredictionSet => {
    const matches = input.predictionSets.filter(
      (set) => set.armId === armId,
    );
    if (matches.length !== 1) {
      throw new Error(
        `Top-two bootstrap requires exactly one prediction set for ${armId}`,
      );
    }
    return matches[0]!;
  };
  const winnerSet = setFor(winner.armId);
  const runnerUpSet = setFor(runnerUp.armId);
  const metrics = input.metrics ?? [
    "exactSemanticDecision",
    "knownCodingExactSetAccuracy",
    "macroTaskStratumAccuracy",
  ];
  const comparisons: Partial<
    Record<LunaBootstrapMetric, LunaClusterBootstrapComparison>
  > = {};
  for (const metric of metrics) {
    comparisons[metric] = compareLunaAccuracyByClusterBootstrap(
      input.episodes,
      input.labels,
      winnerSet.predictions,
      runnerUpSet.predictions,
      {
        metric,
        iterations: input.iterations ?? 5_000,
        seed: input.seed ?? 17,
        codingEpisodeIds: input.codingEpisodeIds,
      },
    );
  }
  return {
    schemaVersion: 1,
    winnerArmId: winner.armId,
    runnerUpArmId: runnerUp.armId,
    comparisons,
    note:
      "Intervals use paired resampling of session-or-lineage connected components. The weighted selection score itself is not treated as a validated statistical estimand.",
  };
};
