import { contentHash } from "./hash.ts";
import {
  buildLunaAccuracyAttestedAnalysis,
  type LunaAccuracyAnalysisAttestationV2,
} from "./luna-accuracy-attestation.ts";
import {
  codingEpisodeIdsFromAnnotations,
  type LunaAccuracyCodingAnnotation,
} from "./luna-accuracy-coding-annotations.ts";
import {
  LUNA_GROUNDED_CODING_DEVELOPMENT_VERSION,
  LUNA_GROUNDED_CODING_VARIANT_KINDS,
  type LunaGroundedCodingInheritedSilverLabel,
  type LunaGroundedCodingProvenance,
  type LunaGroundedCodingSilverBaseLabel,
  type LunaGroundedCodingVariantKind,
} from "./luna-accuracy-coding-development.ts";
import {
  type LunaAccuracyMatrixV2,
  type LunaAccuracyVariantV2,
} from "./luna-accuracy-context.ts";
import {
  LUNA_ACCURACY_PHASE_THREE_PROTOCOL,
  type LunaAccuracyPhaseThreeSelection,
} from "./luna-accuracy-phase3.ts";
import {
  buildSessionLineageClusters,
  calculateLunaAccuracyMetrics,
  isExactSemanticDecision,
  type LunaAccuracyMetrics,
} from "./luna-accuracy-metrics.ts";
import {
  LUNA_ACCURACY_MODEL,
  LUNA_ACCURACY_TRANSPORT_POLICY,
} from "./luna-accuracy-openrouter.ts";
import {
  lunaAccuracyAreaRegistryHash,
  lunaAccuracyArmsHash,
  lunaAccuracyMatrixHash,
  lunaAccuracyModelHash,
  lunaAccuracyProfileHash,
  lunaAccuracyRuntimeEpisodesHash,
  type LunaAccuracyArchitecture,
  type LunaAccuracyCallRecord,
  type LunaAccuracyExperimentArm,
  type LunaAccuracyPredictionSet,
  type LunaAccuracyRunManifest,
} from "./luna-accuracy-runner.ts";
import type {
  AreaCardV1,
  ClassifierPredictionV1,
  RepositoryProfileV1,
  SilverLabelV1,
  TaskEpisode,
  UnknownType,
} from "./types.ts";

export const LUNA_ACCURACY_CODING_STRESS_PROTOCOL =
  "luna-accuracy-coding-stress-v1" as const;
export const LUNA_ACCURACY_CODING_STRESS_EXPECTED_BASE_CASES = 18 as const;
export const LUNA_ACCURACY_CODING_STRESS_EXPECTED_DERIVED_CASES = 90 as const;
export const LUNA_ACCURACY_CODING_STRESS_BASE_MINIMUM_CORRECT = 14 as const;
export const LUNA_ACCURACY_CODING_STRESS_BOOTSTRAP_ITERATIONS = 10_000 as const;
export const LUNA_ACCURACY_CODING_STRESS_BOOTSTRAP_SEED = 19_871 as const;

export interface LunaAccuracyCodingStressDesign {
  schemaVersion: 1;
  protocol: typeof LUNA_ACCURACY_CODING_STRESS_PROTOCOL;
  role: "frozen_phase3_product_configuration_for_repository_derived_stress";
  model: typeof LUNA_ACCURACY_MODEL;
  matrix: LunaAccuracyMatrixV2;
  arms: [LunaAccuracyExperimentArm];
  sourcePhaseThree: {
    selectionHash: string;
    matrixHash: string;
    armsHash: string;
    selectedPrimaryArmId: string;
    selectedPrimaryVariantId: string;
    selectedArchitecture: LunaAccuracyArchitecture;
    primaryContextConfigurationHash: string;
  };
  inferenceCallsPerCase: 1 | 3;
  reportingPolicy: {
    maySelectProductConfiguration: false;
    combineBaseAndDerivedAccuracy: false;
    combineWithRealUserValidation: false;
    derivativesAreIndependentEvidence: false;
  };
}

export interface BuildLunaAccuracyCodingStressDesignInput {
  phaseThreeMatrix: LunaAccuracyMatrixV2;
  phaseThreeArms: readonly LunaAccuracyExperimentArm[];
  phaseThreeSelection: LunaAccuracyPhaseThreeSelection;
}

const lexicalCompare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const mean = (values: readonly number[]): number => {
  if (values.length === 0) throw new Error("Cannot average an empty list");
  return values.reduce((sum, value) => sum + value, 0) / values.length;
};

const semanticDecisionKey = (
  prediction: ClassifierPredictionV1,
): string => JSON.stringify({
  known: prediction.known,
  selectedAreaIds: [...prediction.selectedAreaIds].sort(lexicalCompare),
  unknownType: prediction.unknownType ?? null,
});

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

const requiredRepetitions = (
  architecture: LunaAccuracyArchitecture,
): 1 | 3 => architecture === "self_consistency_3" ? 3 : 1;

const callsPerCase = (
  architecture: LunaAccuracyArchitecture,
): 1 | 3 => architecture === "single_call" ? 1 : 3;

/**
 * Materializes the exact primary-context product configuration selected by
 * Phase 3. A single-call product is deliberately normalized to one call; the
 * three Phase 3 repetitions estimated variability and were never an ensemble.
 */
export const buildLunaAccuracyCodingStressDesign = (
  input: BuildLunaAccuracyCodingStressDesignInput,
): LunaAccuracyCodingStressDesign => {
  const selection = input.phaseThreeSelection;
  if (
    selection.schemaVersion !== 1 ||
    selection.protocol !== LUNA_ACCURACY_PHASE_THREE_PROTOCOL ||
    selection.model !== LUNA_ACCURACY_MODEL ||
    selection.datasetRole !== "validation" ||
    selection.dataSource !== "real_user"
  ) {
    throw new Error(
      "Coding stress design requires a real-user Phase 3 Luna selection",
    );
  }
  const normalizedArms = [...input.phaseThreeArms];
  if (
    selection.provenance.matrixHash !==
      lunaAccuracyMatrixHash(input.phaseThreeMatrix) ||
    selection.provenance.armsHash !==
      lunaAccuracyArmsHash(input.phaseThreeMatrix, normalizedArms)
  ) {
    throw new Error(
      "Coding stress design inputs are not bound to the Phase 3 selection",
    );
  }
  const selectedVariant = input.phaseThreeMatrix.variants.find(
    (variant) =>
      variant.id === selection.selection.selectedPrimaryVariantId,
  );
  const selectedArm = normalizedArms.find(
    (arm) => arm.id === selection.selection.selectedPrimaryArmId,
  );
  if (
    !selectedVariant ||
    !selectedArm ||
    selectedArm.variantId !== selectedVariant.id ||
    selectedArm.architecture !==
      selection.selection.selectedArchitecture ||
    !selectedArm.id.startsWith("p3-primary-")
  ) {
    throw new Error(
      "Coding stress design cannot resolve the selected primary Phase 3 arm",
    );
  }
  const contextHash = contentHash(contextConfiguration(selectedVariant));
  if (
    contextHash !==
      selection.design.contextConfigurationHashes.primary
  ) {
    throw new Error(
      "Coding stress selected variant is not the frozen Phase 3 primary context",
    );
  }
  const repetitions = requiredRepetitions(selectedArm.architecture);
  if (selectedVariant.fixedSeedList.length < repetitions) {
    throw new Error(
      "Coding stress selected variant lacks the required frozen seeds",
    );
  }
  const variant: LunaAccuracyVariantV2 = {
    ...selectedVariant,
    repetitions,
    fixedSeedList: selectedVariant.fixedSeedList.slice(0, repetitions),
  };
  const matrix: LunaAccuracyMatrixV2 = {
    schemaVersion: 2,
    description:
      "Coding stress: the frozen Phase 3 primary-context product configuration. Repository-derived base and derivative datasets are run separately and cannot select or retune the product configuration.",
    variants: [variant],
  };
  return {
    schemaVersion: 1,
    protocol: LUNA_ACCURACY_CODING_STRESS_PROTOCOL,
    role:
      "frozen_phase3_product_configuration_for_repository_derived_stress",
    model: LUNA_ACCURACY_MODEL,
    matrix,
    arms: [{ ...selectedArm }],
    sourcePhaseThree: {
      selectionHash: contentHash(selection),
      matrixHash: selection.provenance.matrixHash,
      armsHash: selection.provenance.armsHash,
      selectedPrimaryArmId: selectedArm.id,
      selectedPrimaryVariantId: selectedVariant.id,
      selectedArchitecture: selectedArm.architecture,
      primaryContextConfigurationHash: contextHash,
    },
    inferenceCallsPerCase: callsPerCase(selectedArm.architecture),
    reportingPolicy: {
      maySelectProductConfiguration: false,
      combineBaseAndDerivedAccuracy: false,
      combineWithRealUserValidation: false,
      derivativesAreIndependentEvidence: false,
    },
  };
};

const validateCodingStressDesign = (
  design: LunaAccuracyCodingStressDesign,
): void => {
  if (
    design.schemaVersion !== 1 ||
    design.protocol !== LUNA_ACCURACY_CODING_STRESS_PROTOCOL ||
    design.role !==
      "frozen_phase3_product_configuration_for_repository_derived_stress" ||
    design.model !== LUNA_ACCURACY_MODEL ||
    design.matrix.schemaVersion !== 2 ||
    design.matrix.variants.length !== 1 ||
    design.arms.length !== 1
  ) {
    throw new Error("Invalid coding stress design");
  }
  const variant = design.matrix.variants[0]!;
  const arm = design.arms[0]!;
  const repetitions = requiredRepetitions(arm.architecture);
  if (
    arm.id !== design.sourcePhaseThree.selectedPrimaryArmId ||
    arm.variantId !== variant.id ||
    variant.id !== design.sourcePhaseThree.selectedPrimaryVariantId ||
    arm.architecture !== design.sourcePhaseThree.selectedArchitecture ||
    variant.repetitions !== repetitions ||
    variant.fixedSeedList.length !== repetitions ||
    contentHash(contextConfiguration(variant)) !==
      design.sourcePhaseThree.primaryContextConfigurationHash ||
    design.inferenceCallsPerCase !== callsPerCase(arm.architecture) ||
    design.reportingPolicy.maySelectProductConfiguration !== false ||
    design.reportingPolicy.combineBaseAndDerivedAccuracy !== false ||
    design.reportingPolicy.combineWithRealUserValidation !== false ||
    design.reportingPolicy.derivativesAreIndependentEvidence !== false
  ) {
    throw new Error("Coding stress design is internally inconsistent");
  }
};

export interface LunaAccuracyCodingStressRunInput<
  Label extends SilverLabelV1,
> {
  episodes: TaskEpisode[];
  labels: Label[];
  codingAnnotations: LunaAccuracyCodingAnnotation[];
  calls: LunaAccuracyCallRecord[];
  runManifest: LunaAccuracyRunManifest;
}

export interface LunaAccuracyCodingStressAreaFailure {
  areaId: string;
  expectedCases: number;
  missedSelections: number;
  falseSelections: number;
  totalErrors: number;
}

export interface LunaAccuracyCodingStressUnknownFailures {
  unknownCases: number;
  falseKnown: number;
  wrongUnknownSubtype: number;
  knownPredictedUnknown: number;
}

export interface LunaAccuracyCodingStressResultSummary {
  cases: number;
  exactSemanticDecision: {
    correct: number;
    count: number;
    accuracy: number;
  };
  knownCodingExactSet: LunaAccuracyMetrics["knownCodingExactSet"];
  knownUnknownBalancedAccuracy: number | null;
  macroTaskStratumAccuracy: number | null;
  perAreaMacroF1: number | null;
  unknownSubtypeMacroF1: number | null;
  areaFailures: LunaAccuracyCodingStressAreaFailure[];
  systematicAreaSignals: LunaAccuracyCodingStressAreaFailure[];
  unknownFailures: LunaAccuracyCodingStressUnknownFailures;
  observedCostUsd: number | null;
  meanCostUsdPerDecision: number | null;
}

export interface LunaAccuracyCodingStressPairedBootstrap {
  comparison:
    | "all_derivatives_minus_base"
    | LunaGroundedCodingVariantKind;
  unit: "source_lineage";
  iterationsRequested: 10_000;
  iterationsCompleted: 10_000;
  bootstrapSeed: 19_871;
  independentLineages: 18;
  observed: {
    baseAccuracy: number;
    derivativeAccuracy: number;
    difference: number;
  };
  bootstrap: {
    meanDifference: number;
    standardError: number;
    confidenceInterval95: { lower: number; upper: number };
    probabilityDerivativeBetter: number;
    probabilityDerivativeNoWorse: number;
    twoSidedSignPValue: number;
  };
}

export interface LunaAccuracyCodingStressTransformationSummary {
  variantKind: LunaGroundedCodingVariantKind;
  result: LunaAccuracyCodingStressResultSummary;
  decisionInvarianceToBase: {
    invariant: number;
    count: number;
    rate: number;
  };
  correctnessTransitions: {
    retainedCorrect: number;
    regressedFromCorrect: number;
    recoveredFromIncorrect: number;
    retainedIncorrect: number;
  };
  pairedBootstrap: LunaAccuracyCodingStressPairedBootstrap;
}

export interface LunaAccuracyCodingStressAnalysis {
  schemaVersion: 1;
  protocol: typeof LUNA_ACCURACY_CODING_STRESS_PROTOCOL;
  generatedAt: string;
  model: typeof LUNA_ACCURACY_MODEL;
  role: "repository_derived_coding_stress_not_product_selection";
  configuration: {
    architecture: LunaAccuracyArchitecture;
    variantId: string;
    armId: string;
    inferenceCallsPerCase: 1 | 3;
    matrixHash: string;
    armsHash: string;
    sourcePhaseThreeSelectionHash: string;
  };
  provenance: {
    modelHash: string;
    profileHash: string;
    areaRegistryHash: string;
    designHash: string;
    codingSuiteSpecificationVersion:
      typeof LUNA_GROUNDED_CODING_DEVELOPMENT_VERSION;
    derivativeProvenanceHash: string;
    base: {
      runtimeEpisodesHash: string;
      labelsHash: string;
      codingAnnotationsHash: string;
      runManifestHash: string;
      completedCallsHash: string;
      analysisAttestationHash: string;
    };
    derived: {
      runtimeEpisodesHash: string;
      labelsHash: string;
      codingAnnotationsHash: string;
      runManifestHash: string;
      completedCallsHash: string;
      analysisAttestationHash: string;
    };
    transportPolicyHash: string;
  };
  base: {
    independentCases: 18;
    result: LunaAccuracyCodingStressResultSummary;
    veto: {
      metric: "exact_semantic_decision";
      requiredCorrect: 14;
      observedCorrect: number;
      passed: boolean;
      consequence:
        | "configuration_may_advance_to_descriptive_derivative_review"
        | "configuration_fails_coding_base_veto";
    };
  };
  derivatives: {
    rows: 90;
    independentSourceLineages: 18;
    variantsPerSource: 5;
    aggregateDescriptiveOnly: LunaAccuracyCodingStressResultSummary;
    transformations: LunaAccuracyCodingStressTransformationSummary[];
    clusteredAllDerivativesVersusBase:
      LunaAccuracyCodingStressPairedBootstrap;
  };
  outcome: "base_veto_passed" | "base_veto_failed";
  limitations: string[];
}

export interface BuildLunaAccuracyCodingStressAnalysisInput {
  model: string;
  profile: RepositoryProfileV1;
  cards: AreaCardV1[];
  design: LunaAccuracyCodingStressDesign;
  base: LunaAccuracyCodingStressRunInput<LunaGroundedCodingSilverBaseLabel>;
  derived: LunaAccuracyCodingStressRunInput<
    LunaGroundedCodingInheritedSilverLabel
  >;
  provenance: LunaGroundedCodingProvenance[];
  generatedAt?: string;
}

const canonicalById = <T>(
  values: readonly T[],
  idOf: (value: T) => string,
): T[] => [...values].sort((left, right) =>
  lexicalCompare(idOf(left), idOf(right))
);

const exactPredictionSet = (
  sets: readonly LunaAccuracyPredictionSet[],
  label: string,
): LunaAccuracyPredictionSet => {
  if (sets.length !== 1) {
    throw new Error(
      `Coding stress ${label} run must produce exactly one final prediction set`,
    );
  }
  return sets[0]!;
};

const exactDecisionMatches = (
  label: SilverLabelV1,
  prediction: ClassifierPredictionV1,
): boolean => isExactSemanticDecision(label, prediction);

const areaFailures = (
  cards: readonly AreaCardV1[],
  labels: readonly SilverLabelV1[],
  predictions: readonly ClassifierPredictionV1[],
): LunaAccuracyCodingStressAreaFailure[] => {
  const predictionById = new Map(
    predictions.map((prediction) => [prediction.taskEpisodeId, prediction]),
  );
  return cards.map((card) => {
    let expectedCases = 0;
    let missedSelections = 0;
    let falseSelections = 0;
    for (const label of labels) {
      const prediction = predictionById.get(label.taskEpisodeId)!;
      const expected = label.selectedAreaIds.includes(card.areaId);
      const actual = prediction.selectedAreaIds.includes(card.areaId);
      if (expected) expectedCases += 1;
      if (expected && !actual) missedSelections += 1;
      if (!expected && actual) falseSelections += 1;
    }
    return {
      areaId: card.areaId,
      expectedCases,
      missedSelections,
      falseSelections,
      totalErrors: missedSelections + falseSelections,
    };
  }).filter((value) => value.expectedCases > 0 || value.totalErrors > 0)
    .sort((left, right) =>
      right.totalErrors - left.totalErrors ||
      lexicalCompare(left.areaId, right.areaId)
    );
};

const unknownFailures = (
  labels: readonly SilverLabelV1[],
  predictions: readonly ClassifierPredictionV1[],
): LunaAccuracyCodingStressUnknownFailures => {
  const predictionById = new Map(
    predictions.map((prediction) => [prediction.taskEpisodeId, prediction]),
  );
  let falseKnown = 0;
  let wrongUnknownSubtype = 0;
  let knownPredictedUnknown = 0;
  for (const label of labels) {
    const prediction = predictionById.get(label.taskEpisodeId)!;
    if (!label.known && prediction.known) falseKnown += 1;
    if (
      !label.known &&
      !prediction.known &&
      label.unknownType !== prediction.unknownType
    ) {
      wrongUnknownSubtype += 1;
    }
    if (label.known && !prediction.known) knownPredictedUnknown += 1;
  }
  return {
    unknownCases: labels.filter((label) => !label.known).length,
    falseKnown,
    wrongUnknownSubtype,
    knownPredictedUnknown,
  };
};

const usage = (
  predictions: readonly ClassifierPredictionV1[],
): { observedCostUsd: number | null; meanCostUsdPerDecision: number | null } => {
  const values = predictions.map((prediction) => prediction.costUsd);
  if (!values.every(
    (value): value is number =>
      typeof value === "number" && Number.isFinite(value) && value >= 0
  )) {
    return { observedCostUsd: null, meanCostUsdPerDecision: null };
  }
  const observedCostUsd = values.reduce((sum, value) => sum + value, 0);
  return {
    observedCostUsd,
    meanCostUsdPerDecision: observedCostUsd / predictions.length,
  };
};

const resultSummary = (input: {
  cards: readonly AreaCardV1[];
  labels: readonly SilverLabelV1[];
  predictions: readonly ClassifierPredictionV1[];
  codingEpisodeIds: ReadonlySet<string>;
}): LunaAccuracyCodingStressResultSummary => {
  const metrics = calculateLunaAccuracyMetrics(
    input.labels,
    input.predictions,
    { codingEpisodeIds: input.codingEpisodeIds },
  );
  if (metrics.exactSemanticDecision.accuracy === null) {
    throw new Error("Coding stress exact semantic accuracy is undefined");
  }
  const failures = areaFailures(input.cards, input.labels, input.predictions);
  return {
    cases: input.labels.length,
    exactSemanticDecision: {
      correct: metrics.exactSemanticDecision.correct,
      count: metrics.exactSemanticDecision.count,
      accuracy: metrics.exactSemanticDecision.accuracy,
    },
    knownCodingExactSet: metrics.knownCodingExactSet,
    knownUnknownBalancedAccuracy: metrics.knownUnknown.balancedAccuracy,
    macroTaskStratumAccuracy: metrics.macroTaskStratumAccuracy,
    perAreaMacroF1: metrics.perAreaMacroF1,
    unknownSubtypeMacroF1: metrics.unknownSubtypeMacroF1,
    areaFailures: failures,
    systematicAreaSignals: failures.filter((failure) =>
      failure.totalErrors >= 2
    ),
    unknownFailures: unknownFailures(input.labels, input.predictions),
    ...usage(input.predictions),
  };
};

interface LineageOutcome {
  sourceEpisodeId: string;
  baseCorrect: boolean;
  derivativeCorrectByKind: Record<LunaGroundedCodingVariantKind, boolean>;
}

const blankByKind = <T>(factory: () => T): Record<
  LunaGroundedCodingVariantKind,
  T
> => Object.fromEntries(
  LUNA_GROUNDED_CODING_VARIANT_KINDS.map((kind) => [kind, factory()]),
) as Record<LunaGroundedCodingVariantKind, T>;

const quantile = (
  sortedValues: readonly number[],
  probability: number,
): number => sortedValues[Math.floor((sortedValues.length - 1) * probability)]!;

const pairedBootstrap = (input: {
  outcomes: readonly LineageOutcome[];
  comparison: "all_derivatives_minus_base" | LunaGroundedCodingVariantKind;
}): LunaAccuracyCodingStressPairedBootstrap => {
  if (
    input.outcomes.length !==
      LUNA_ACCURACY_CODING_STRESS_EXPECTED_BASE_CASES
  ) {
    throw new Error("Coding stress bootstrap requires 18 source lineages");
  }
  const derivativeValue = (outcome: LineageOutcome): number =>
    input.comparison === "all_derivatives_minus_base"
      ? mean(
        LUNA_GROUNDED_CODING_VARIANT_KINDS.map((kind) =>
          outcome.derivativeCorrectByKind[kind] ? 1 : 0
        ),
      )
      : outcome.derivativeCorrectByKind[input.comparison]
      ? 1
      : 0;
  const observedBase = mean(
    input.outcomes.map((outcome) => outcome.baseCorrect ? 1 : 0),
  );
  const observedDerivative = mean(input.outcomes.map(derivativeValue));
  let state = LUNA_ACCURACY_CODING_STRESS_BOOTSTRAP_SEED >>> 0;
  const random = (): number => {
    state = (1_664_525 * state + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
  const differences: number[] = [];
  for (
    let iteration = 0;
    iteration < LUNA_ACCURACY_CODING_STRESS_BOOTSTRAP_ITERATIONS;
    iteration += 1
  ) {
    let baseTotal = 0;
    let derivativeTotal = 0;
    for (let draw = 0; draw < input.outcomes.length; draw += 1) {
      const outcome = input.outcomes[
        Math.floor(random() * input.outcomes.length)
      ]!;
      baseTotal += outcome.baseCorrect ? 1 : 0;
      derivativeTotal += derivativeValue(outcome);
    }
    differences.push(
      derivativeTotal / input.outcomes.length -
        baseTotal / input.outcomes.length,
    );
  }
  const bootstrapMean = mean(differences);
  const variance = differences.reduce(
    (sum, value) => sum + (value - bootstrapMean) ** 2,
    0,
  ) / (differences.length - 1);
  const sorted = [...differences].sort((left, right) => left - right);
  const better = differences.filter((value) => value > 0).length;
  const tied = differences.filter((value) => value === 0).length;
  const nonPositive = differences.filter((value) => value <= 0).length;
  const nonNegative = differences.filter((value) => value >= 0).length;
  return {
    comparison: input.comparison,
    unit: "source_lineage",
    iterationsRequested: LUNA_ACCURACY_CODING_STRESS_BOOTSTRAP_ITERATIONS,
    iterationsCompleted: LUNA_ACCURACY_CODING_STRESS_BOOTSTRAP_ITERATIONS,
    bootstrapSeed: LUNA_ACCURACY_CODING_STRESS_BOOTSTRAP_SEED,
    independentLineages: LUNA_ACCURACY_CODING_STRESS_EXPECTED_BASE_CASES,
    observed: {
      baseAccuracy: observedBase,
      derivativeAccuracy: observedDerivative,
      difference: observedDerivative - observedBase,
    },
    bootstrap: {
      meanDifference: bootstrapMean,
      standardError: Math.sqrt(variance),
      confidenceInterval95: {
        lower: quantile(sorted, 0.025),
        upper: quantile(sorted, 0.975),
      },
      probabilityDerivativeBetter:
        (better + 0.5 * tied) / differences.length,
      probabilityDerivativeNoWorse:
        differences.filter((value) => value >= 0).length /
        differences.length,
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

const semanticLabelKey = (label: SilverLabelV1): string => JSON.stringify({
  known: label.known,
  selectedAreaIds: [...label.selectedAreaIds].sort(lexicalCompare),
  unknownType: label.unknownType ?? null,
});

const validateSuiteBindings = (input: {
  baseEpisodes: readonly TaskEpisode[];
  baseLabels: readonly LunaGroundedCodingSilverBaseLabel[];
  derivedEpisodes: readonly TaskEpisode[];
  derivedLabels: readonly LunaGroundedCodingInheritedSilverLabel[];
  provenance: readonly LunaGroundedCodingProvenance[];
}): Map<string, {
  sourceEpisodeId: string;
  variantKind: LunaGroundedCodingVariantKind;
}> => {
  if (
    input.baseEpisodes.length !==
      LUNA_ACCURACY_CODING_STRESS_EXPECTED_BASE_CASES ||
    input.baseLabels.length !==
      LUNA_ACCURACY_CODING_STRESS_EXPECTED_BASE_CASES ||
    input.derivedEpisodes.length !==
      LUNA_ACCURACY_CODING_STRESS_EXPECTED_DERIVED_CASES ||
    input.derivedLabels.length !==
      LUNA_ACCURACY_CODING_STRESS_EXPECTED_DERIVED_CASES ||
    input.provenance.length !==
      LUNA_ACCURACY_CODING_STRESS_EXPECTED_DERIVED_CASES
  ) {
    throw new Error(
      "Coding stress requires the frozen 18-base/90-derivative Sol suite",
    );
  }
  if (
    [...input.baseEpisodes, ...input.derivedEpisodes].some(
      (episode) => episode.actualChangedPaths !== undefined,
    )
  ) {
    throw new Error(
      "Coding stress runtime episodes contain post-task changed-path evidence",
    );
  }
  const baseClusters = buildSessionLineageClusters(input.baseEpisodes);
  if (
    baseClusters.length !==
      LUNA_ACCURACY_CODING_STRESS_EXPECTED_BASE_CASES ||
    baseClusters.some((cluster) => cluster.episodeIds.length !== 1)
  ) {
    throw new Error(
      "Coding stress base set does not contain 18 independent session/lineage clusters",
    );
  }
  const baseEpisodeById = new Map(
    input.baseEpisodes.map((episode) => [episode.id, episode]),
  );
  const baseLabelById = new Map(
    input.baseLabels.map((label) => [label.taskEpisodeId, label]),
  );
  if (
    baseEpisodeById.size !== input.baseEpisodes.length ||
    baseLabelById.size !== input.baseLabels.length ||
    [...baseEpisodeById.keys()].some((id) => !baseLabelById.has(id))
  ) {
    throw new Error("Coding stress base episodes and labels need an exact join");
  }
  for (const [id, label] of baseLabelById) {
    if (
      label.labelSource !== "independent_sol_silver_repository_aware" ||
      label.sourceTaskEpisodeId !== id ||
      !/^[a-f0-9]{64}$/u.test(label.sourceLabelHash) ||
      !label.oracle.adjudicated ||
      !label.oracle.repositoryInspected
    ) {
      throw new Error(
        `Coding stress base label is not independent repository-aware Sol silver: ${id}`,
      );
    }
  }
  const derivedEpisodeById = new Map(
    input.derivedEpisodes.map((episode) => [episode.id, episode]),
  );
  const derivedLabelById = new Map(
    input.derivedLabels.map((label) => [label.taskEpisodeId, label]),
  );
  if (
    derivedEpisodeById.size !== input.derivedEpisodes.length ||
    derivedLabelById.size !== input.derivedLabels.length ||
    [...derivedEpisodeById.keys()].some((id) => !derivedLabelById.has(id))
  ) {
    throw new Error(
      "Coding stress derivative episodes and labels need an exact join",
    );
  }
  const mapping = new Map<string, {
    sourceEpisodeId: string;
    variantKind: LunaGroundedCodingVariantKind;
  }>();
  const sourceKindKeys = new Set<string>();
  for (const item of input.provenance) {
    const derivative = derivedEpisodeById.get(item.derivativeEpisodeId);
    const source = baseEpisodeById.get(item.sourceEpisodeId);
    const label = derivedLabelById.get(item.derivativeEpisodeId);
    const baseLabel = baseLabelById.get(item.sourceEpisodeId);
    if (
      !derivative ||
      !source ||
      !label ||
      !baseLabel ||
      item.schemaVersion !== 1 ||
      item.specificationVersion !==
        LUNA_GROUNDED_CODING_DEVELOPMENT_VERSION ||
      !LUNA_GROUNDED_CODING_VARIANT_KINDS.includes(item.variantKind) ||
      item.sourceSessionHash !== source.sessionHash ||
      item.sourceLineageHash !== source.lineageHash ||
      item.derivativeSessionHash !== derivative.sessionHash ||
      item.derivativeLineageHash !== derivative.lineageHash ||
      derivative.sessionHash !== source.sessionHash ||
      derivative.lineageHash !== source.lineageHash ||
      item.sourceActualChangedPathsUsedInRuntimeConstruction !== false ||
      item.areaAssignmentUsedInRuntimeConstruction !== false ||
      item.labelPolicy !==
        "inherited_sol_silver_label_preserving_not_independent" ||
      label.labelSource !== "inherited_sol_silver_not_independent" ||
      label.sourceTaskEpisodeId !== source.id ||
      label.sourceLabelHash !== baseLabel.sourceLabelHash ||
      label.variantKind !== item.variantKind ||
      label.labelPreservingByConstruction !== true ||
      semanticLabelKey(label) !== semanticLabelKey(baseLabel)
    ) {
      throw new Error(
        `Coding stress derivative provenance or inherited label is invalid: ${item.derivativeEpisodeId}`,
      );
    }
    if (mapping.has(item.derivativeEpisodeId)) {
      throw new Error(
        `Duplicate coding stress derivative provenance: ${item.derivativeEpisodeId}`,
      );
    }
    const sourceKindKey = `${item.sourceEpisodeId}\u0000${item.variantKind}`;
    if (sourceKindKeys.has(sourceKindKey)) {
      throw new Error(
        `Duplicate coding stress transformation for source: ${item.sourceEpisodeId}/${item.variantKind}`,
      );
    }
    sourceKindKeys.add(sourceKindKey);
    mapping.set(item.derivativeEpisodeId, {
      sourceEpisodeId: item.sourceEpisodeId,
      variantKind: item.variantKind,
    });
  }
  for (const sourceId of baseEpisodeById.keys()) {
    for (const kind of LUNA_GROUNDED_CODING_VARIANT_KINDS) {
      if (!sourceKindKeys.has(`${sourceId}\u0000${kind}`)) {
        throw new Error(
          `Coding stress source lacks transformation ${sourceId}/${kind}`,
        );
      }
    }
  }
  return mapping;
};

const buildLineageOutcomes = (input: {
  baseLabels: readonly LunaGroundedCodingSilverBaseLabel[];
  basePredictions: readonly ClassifierPredictionV1[];
  derivedLabels: readonly LunaGroundedCodingInheritedSilverLabel[];
  derivedPredictions: readonly ClassifierPredictionV1[];
  mapping: ReadonlyMap<string, {
    sourceEpisodeId: string;
    variantKind: LunaGroundedCodingVariantKind;
  }>;
}): LineageOutcome[] => {
  const basePredictionById = new Map(
    input.basePredictions.map((prediction) => [
      prediction.taskEpisodeId,
      prediction,
    ]),
  );
  const derivedPredictionById = new Map(
    input.derivedPredictions.map((prediction) => [
      prediction.taskEpisodeId,
      prediction,
    ]),
  );
  const derivedLabelById = new Map(
    input.derivedLabels.map((label) => [label.taskEpisodeId, label]),
  );
  const derivativeBySourceAndKind = new Map<string, string>();
  for (const [derivativeId, value] of input.mapping) {
    derivativeBySourceAndKind.set(
      `${value.sourceEpisodeId}\u0000${value.variantKind}`,
      derivativeId,
    );
  }
  return [...input.baseLabels]
    .sort((left, right) =>
      lexicalCompare(left.taskEpisodeId, right.taskEpisodeId)
    )
    .map((baseLabel) => {
      const basePrediction = basePredictionById.get(baseLabel.taskEpisodeId)!;
      const derivativeCorrectByKind = blankByKind(() => false);
      for (const kind of LUNA_GROUNDED_CODING_VARIANT_KINDS) {
        const derivativeId = derivativeBySourceAndKind.get(
          `${baseLabel.taskEpisodeId}\u0000${kind}`,
        )!;
        derivativeCorrectByKind[kind] = exactDecisionMatches(
          derivedLabelById.get(derivativeId)!,
          derivedPredictionById.get(derivativeId)!,
        );
      }
      return {
        sourceEpisodeId: baseLabel.taskEpisodeId,
        baseCorrect: exactDecisionMatches(baseLabel, basePrediction),
        derivativeCorrectByKind,
      };
    });
};

const transformationSummary = (input: {
  kind: LunaGroundedCodingVariantKind;
  cards: readonly AreaCardV1[];
  labels: readonly LunaGroundedCodingInheritedSilverLabel[];
  predictions: readonly ClassifierPredictionV1[];
  codingEpisodeIds: ReadonlySet<string>;
  mapping: ReadonlyMap<string, {
    sourceEpisodeId: string;
    variantKind: LunaGroundedCodingVariantKind;
  }>;
  basePredictionById: ReadonlyMap<string, ClassifierPredictionV1>;
  baseCorrectById: ReadonlyMap<string, boolean>;
  outcomes: readonly LineageOutcome[];
}): LunaAccuracyCodingStressTransformationSummary => {
  const labels = input.labels.filter((label) =>
    input.mapping.get(label.taskEpisodeId)?.variantKind === input.kind
  );
  const labelIds = new Set(labels.map((label) => label.taskEpisodeId));
  const predictions = input.predictions.filter((prediction) =>
    labelIds.has(prediction.taskEpisodeId)
  );
  let invariant = 0;
  let retainedCorrect = 0;
  let regressedFromCorrect = 0;
  let recoveredFromIncorrect = 0;
  let retainedIncorrect = 0;
  const predictionById = new Map(
    predictions.map((prediction) => [prediction.taskEpisodeId, prediction]),
  );
  for (const label of labels) {
    const mapping = input.mapping.get(label.taskEpisodeId)!;
    const basePrediction = input.basePredictionById.get(mapping.sourceEpisodeId)!;
    const derivativePrediction = predictionById.get(label.taskEpisodeId)!;
    if (
      semanticDecisionKey(basePrediction) ===
        semanticDecisionKey(derivativePrediction)
    ) {
      invariant += 1;
    }
    const baseCorrect = input.baseCorrectById.get(mapping.sourceEpisodeId)!;
    const derivativeCorrect = exactDecisionMatches(label, derivativePrediction);
    if (baseCorrect && derivativeCorrect) retainedCorrect += 1;
    else if (baseCorrect) regressedFromCorrect += 1;
    else if (derivativeCorrect) recoveredFromIncorrect += 1;
    else retainedIncorrect += 1;
  }
  return {
    variantKind: input.kind,
    result: resultSummary({
      cards: input.cards,
      labels,
      predictions,
      codingEpisodeIds: new Set(
        [...input.codingEpisodeIds].filter((id) => labelIds.has(id)),
      ),
    }),
    decisionInvarianceToBase: {
      invariant,
      count: labels.length,
      rate: invariant / labels.length,
    },
    correctnessTransitions: {
      retainedCorrect,
      regressedFromCorrect,
      recoveredFromIncorrect,
      retainedIncorrect,
    },
    pairedBootstrap: pairedBootstrap({
      outcomes: input.outcomes,
      comparison: input.kind,
    }),
  };
};

export const buildLunaAccuracyCodingStressAnalysis = (
  input: BuildLunaAccuracyCodingStressAnalysisInput,
): LunaAccuracyCodingStressAnalysis => {
  if (input.model !== LUNA_ACCURACY_MODEL) {
    throw new Error(`Coding stress requires ${LUNA_ACCURACY_MODEL}`);
  }
  validateCodingStressDesign(input.design);
  const mapping = validateSuiteBindings({
    baseEpisodes: input.base.episodes,
    baseLabels: input.base.labels,
    derivedEpisodes: input.derived.episodes,
    derivedLabels: input.derived.labels,
    provenance: input.provenance,
  });
  const baseAnnotationById = new Map(
    input.base.codingAnnotations.map((annotation) => [
      annotation.taskEpisodeId,
      annotation,
    ]),
  );
  const derivedAnnotationById = new Map(
    input.derived.codingAnnotations.map((annotation) => [
      annotation.taskEpisodeId,
      annotation,
    ]),
  );
  for (const episode of input.base.episodes) {
    const annotation = baseAnnotationById.get(episode.id);
    if (
      annotation?.method !== "github_change_request_source" ||
      annotation.sourceEpisodeId !== episode.id ||
      annotation.inheritedFromEpisodeId !== undefined
    ) {
      throw new Error(
        `Coding stress base annotation is not bound to its GitHub source: ${episode.id}`,
      );
    }
  }
  for (const [derivativeId, source] of mapping) {
    const annotation = derivedAnnotationById.get(derivativeId);
    if (
      annotation?.method !== "inherited_label_preserving_derivative" ||
      annotation.sourceEpisodeId !== source.sourceEpisodeId ||
      annotation.inheritedFromEpisodeId !== source.sourceEpisodeId
    ) {
      throw new Error(
        `Coding stress derivative annotation is not bound to provenance: ${derivativeId}`,
      );
    }
  }
  const baseCodingIds = codingEpisodeIdsFromAnnotations(
    input.base.episodes,
    input.base.codingAnnotations,
  );
  const derivedCodingIds = codingEpisodeIdsFromAnnotations(
    input.derived.episodes,
    input.derived.codingAnnotations,
  );
  if (
    baseCodingIds.size !== input.base.episodes.length ||
    derivedCodingIds.size !== input.derived.episodes.length
  ) {
    throw new Error(
      "Coding stress requires every GitHub source and inherited derivative to be annotated coding",
    );
  }
  const generatedAt = input.generatedAt ??
    input.base.runManifest.createdAt;
  if (!Number.isFinite(Date.parse(generatedAt))) {
    throw new Error("Coding stress generatedAt must be an ISO date");
  }
  const baseAttested = buildLunaAccuracyAttestedAnalysis({
    model: input.model,
    datasetRole: "validation",
    dataSource: "repository_derived",
    profile: input.profile,
    cards: input.cards,
    episodes: input.base.episodes,
    labels: input.base.labels,
    codingAnnotations: input.base.codingAnnotations,
    matrix: input.design.matrix,
    arms: input.design.arms,
    calls: input.base.calls,
    runManifest: input.base.runManifest,
    generatedAt,
  });
  const derivedAttested = buildLunaAccuracyAttestedAnalysis({
    model: input.model,
    datasetRole: "validation",
    dataSource: "repository_derived",
    profile: input.profile,
    cards: input.cards,
    episodes: input.derived.episodes,
    labels: input.derived.labels,
    codingAnnotations: input.derived.codingAnnotations,
    matrix: input.design.matrix,
    arms: input.design.arms,
    calls: input.derived.calls,
    runManifest: input.derived.runManifest,
    generatedAt,
  });
  const baseSet = exactPredictionSet(baseAttested.predictionSets, "base");
  const derivedSet = exactPredictionSet(
    derivedAttested.predictionSets,
    "derived",
  );
  const baseResult = resultSummary({
    cards: input.cards,
    labels: input.base.labels,
    predictions: baseSet.predictions,
    codingEpisodeIds: baseCodingIds,
  });
  const derivedResult = resultSummary({
    cards: input.cards,
    labels: input.derived.labels,
    predictions: derivedSet.predictions,
    codingEpisodeIds: derivedCodingIds,
  });
  const outcomes = buildLineageOutcomes({
    baseLabels: input.base.labels,
    basePredictions: baseSet.predictions,
    derivedLabels: input.derived.labels,
    derivedPredictions: derivedSet.predictions,
    mapping,
  });
  const basePredictionById = new Map(
    baseSet.predictions.map((prediction) => [
      prediction.taskEpisodeId,
      prediction,
    ]),
  );
  const baseCorrectById = new Map(
    input.base.labels.map((label) => [
      label.taskEpisodeId,
      exactDecisionMatches(
        label,
        basePredictionById.get(label.taskEpisodeId)!,
      ),
    ]),
  );
  const transformations = LUNA_GROUNDED_CODING_VARIANT_KINDS.map((kind) =>
    transformationSummary({
      kind,
      cards: input.cards,
      labels: input.derived.labels,
      predictions: derivedSet.predictions,
      codingEpisodeIds: derivedCodingIds,
      mapping,
      basePredictionById,
      baseCorrectById,
      outcomes,
    })
  );
  const baseVetoPassed =
    baseResult.exactSemanticDecision.correct >=
      LUNA_ACCURACY_CODING_STRESS_BASE_MINIMUM_CORRECT;
  const canonicalCalls = (
    calls: readonly LunaAccuracyCallRecord[],
  ): LunaAccuracyCallRecord[] => canonicalById(calls, (call) => call.key);
  const canonicalLabels = <T extends SilverLabelV1>(
    labels: readonly T[],
  ): T[] => canonicalById(labels, (label) => label.taskEpisodeId);
  const canonicalAnnotations = (
    values: readonly LunaAccuracyCodingAnnotation[],
  ): LunaAccuracyCodingAnnotation[] => canonicalById(
    values,
    (annotation) => annotation.taskEpisodeId,
  );
  const attestationHash = (
    value: LunaAccuracyAnalysisAttestationV2,
  ): string => contentHash(value);
  return {
    schemaVersion: 1,
    protocol: LUNA_ACCURACY_CODING_STRESS_PROTOCOL,
    generatedAt,
    model: LUNA_ACCURACY_MODEL,
    role: "repository_derived_coding_stress_not_product_selection",
    configuration: {
      architecture: input.design.arms[0]!.architecture,
      variantId: input.design.matrix.variants[0]!.id,
      armId: input.design.arms[0]!.id,
      inferenceCallsPerCase: input.design.inferenceCallsPerCase,
      matrixHash: lunaAccuracyMatrixHash(input.design.matrix),
      armsHash: lunaAccuracyArmsHash(
        input.design.matrix,
        input.design.arms,
      ),
      sourcePhaseThreeSelectionHash:
        input.design.sourcePhaseThree.selectionHash,
    },
    provenance: {
      modelHash: lunaAccuracyModelHash(input.model),
      profileHash: lunaAccuracyProfileHash(input.profile),
      areaRegistryHash: lunaAccuracyAreaRegistryHash(input.cards),
      designHash: contentHash(input.design),
      codingSuiteSpecificationVersion:
        LUNA_GROUNDED_CODING_DEVELOPMENT_VERSION,
      derivativeProvenanceHash: contentHash(
        canonicalById(
          input.provenance,
          (value) => value.derivativeEpisodeId,
        ),
      ),
      base: {
        runtimeEpisodesHash:
          lunaAccuracyRuntimeEpisodesHash(input.base.episodes),
        labelsHash: contentHash(canonicalLabels(input.base.labels)),
        codingAnnotationsHash: contentHash(
          canonicalAnnotations(input.base.codingAnnotations),
        ),
        runManifestHash: contentHash(input.base.runManifest),
        completedCallsHash: contentHash(canonicalCalls(input.base.calls)),
        analysisAttestationHash: attestationHash(
          baseAttested.attestation,
        ),
      },
      derived: {
        runtimeEpisodesHash:
          lunaAccuracyRuntimeEpisodesHash(input.derived.episodes),
        labelsHash: contentHash(canonicalLabels(input.derived.labels)),
        codingAnnotationsHash: contentHash(
          canonicalAnnotations(input.derived.codingAnnotations),
        ),
        runManifestHash: contentHash(input.derived.runManifest),
        completedCallsHash: contentHash(canonicalCalls(input.derived.calls)),
        analysisAttestationHash: attestationHash(
          derivedAttested.attestation,
        ),
      },
      transportPolicyHash: contentHash(LUNA_ACCURACY_TRANSPORT_POLICY),
    },
    base: {
      independentCases: LUNA_ACCURACY_CODING_STRESS_EXPECTED_BASE_CASES,
      result: baseResult,
      veto: {
        metric: "exact_semantic_decision",
        requiredCorrect:
          LUNA_ACCURACY_CODING_STRESS_BASE_MINIMUM_CORRECT,
        observedCorrect: baseResult.exactSemanticDecision.correct,
        passed: baseVetoPassed,
        consequence: baseVetoPassed
          ? "configuration_may_advance_to_descriptive_derivative_review"
          : "configuration_fails_coding_base_veto",
      },
    },
    derivatives: {
      rows: LUNA_ACCURACY_CODING_STRESS_EXPECTED_DERIVED_CASES,
      independentSourceLineages:
        LUNA_ACCURACY_CODING_STRESS_EXPECTED_BASE_CASES,
      variantsPerSource: LUNA_GROUNDED_CODING_VARIANT_KINDS.length,
      aggregateDescriptiveOnly: derivedResult,
      transformations,
      clusteredAllDerivativesVersusBase: pairedBootstrap({
        outcomes,
        comparison: "all_derivatives_minus_base",
      }),
    },
    outcome: baseVetoPassed ? "base_veto_passed" : "base_veto_failed",
    limitations: [
      "Base and derivative accuracy are reported separately and are never pooled with each other or with real-user validation.",
      "The 90 derivative rows contain only 18 independent source lineages; uncertainty resamples source lineages, not rows.",
      "Derivative labels inherit independent Sol base decisions and therefore are not 90 additional independent labels.",
      "GitHub change-request tasks are coding-heavy but shorter and less conversational than production Codex tasks.",
      "Generated long-context cases measure robustness to added neutral context, not natural long-context recall.",
      "This stress analysis may veto a weak configuration but may not select, retune, or upgrade the frozen Phase 3 product configuration.",
    ],
  };
};

export const validateLunaAccuracyCodingStressAnalysis = (
  input: BuildLunaAccuracyCodingStressAnalysisInput & {
    analysis: LunaAccuracyCodingStressAnalysis;
  },
): LunaAccuracyCodingStressAnalysis => {
  const rebuilt = buildLunaAccuracyCodingStressAnalysis({
    ...input,
    generatedAt: input.analysis.generatedAt,
  });
  if (contentHash(rebuilt) !== contentHash(input.analysis)) {
    throw new Error(
      "Coding stress analysis does not match its bound raw inputs",
    );
  }
  return rebuilt;
};
