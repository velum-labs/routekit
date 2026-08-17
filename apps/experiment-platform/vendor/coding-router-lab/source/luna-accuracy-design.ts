import {
  DEFAULT_LUNA_ACCURACY_FIXED_SEED_LIST,
  validateLunaAccuracyMatrixV2,
  type LunaAccuracyMatrixV2,
  type LunaAccuracyVariantV2,
} from "./luna-accuracy-context.ts";
import {
  validateLunaAccuracyAnalysisAttestation,
  type BuildLunaAccuracyAttestedAnalysisInput,
  type LunaAccuracyAnalysisAttestationV1,
} from "./luna-accuracy-attestation.ts";
import type {
  LunaAccuracyArchitecture,
  LunaAccuracyExperimentArm,
  LunaAccuracyRunManifest,
} from "./luna-accuracy-runner.ts";
import {
  lunaAccuracyArmsHash,
  lunaAccuracyAreaRegistryHash,
  lunaAccuracyMatrixHash,
  lunaAccuracyModelHash,
  lunaAccuracyProfileHash,
  lunaAccuracyRuntimeEpisodesHash,
  validateLunaAccuracyRunManifestBinding,
} from "./luna-accuracy-runner.ts";
import { contentHash } from "./hash.ts";
import type {
  AreaCardV1,
  RepositoryProfileV1,
  TaskEpisode,
} from "./types.ts";
import type {
  LunaAccuracySelectionReport,
} from "./luna-accuracy-report.ts";

export const LUNA_ACCURACY_PROTOCOL_VERSION =
  "luna-accuracy-protocol-v1" as const;

export const LUNA_ACCURACY_PHASE_ONE_VARIANT_COUNT = 28 as const;
export const LUNA_ACCURACY_PHASE_ONE_FINALIST_COUNT = 6 as const;
export const LUNA_ACCURACY_TRANSPORT_SAFE_MAX_OUTPUT_TOKENS = 4_096 as const;
export const LUNA_ACCURACY_INCUMBENT_MAX_OUTPUT_TOKENS = 128 as const;
export const LUNA_ACCURACY_PHASE_TWO_B_SCHEDULE_SEED = 19_871 as const;
export const LUNA_ACCURACY_PHASE_TWO_B_FIXED_SEED_LIST = Object.freeze([
  181_081,
  206_369,
  233_021,
  262_147,
  292_183,
  324_161,
  357_161,
]);
export const LUNA_ACCURACY_PHASE_THREE_CONTEXT_KEYS = Object.freeze([
  "primary",
  "alternative",
] as const);
export const LUNA_ACCURACY_PHASE_THREE_ARCHITECTURES = Object.freeze([
  "single_call",
  "self_consistency_3",
  "proposal_verify_revise",
] as const);
export const LUNA_ACCURACY_PHASE_THREE_SINGLE_REPETITIONS = 3 as const;
export const LUNA_ACCURACY_PHASE_THREE_SELF_CONSISTENCY_MEMBERS = 3 as const;
export const LUNA_ACCURACY_PHASE_THREE_PIPELINE_REPETITIONS = 1 as const;

const SEEDS = [...DEFAULT_LUNA_ACCURACY_FIXED_SEED_LIST];

const controlVariant = (): LunaAccuracyVariantV2 => ({
  schemaVersion: 2,
  id: "p1-control",
  taskFormat: "labeled_sections",
  taskBudget: "16k",
  repositoryProfileDetail: "components",
  areaFieldBundle: "full",
  registryFormat: "compact_json",
  cardOrdering: "canonical",
  reasoningEffort: "medium",
  promptProcedure: "decomposed",
  outputSchema: "ranked",
  maxOutputTokens: LUNA_ACCURACY_TRANSPORT_SAFE_MAX_OUTPUT_TOKENS,
  repetitions: 1,
  fixedSeedList: [...SEEDS],
});

const withChanges = (
  id: string,
  changes: Partial<LunaAccuracyVariantV2>,
): LunaAccuracyVariantV2 => ({
  ...controlVariant(),
  ...changes,
  schemaVersion: 2,
  id,
  repetitions: 1,
  fixedSeedList: [...SEEDS],
});

/**
 * Returns the pre-registered main-effect screen.
 *
 * This is deliberately not a Cartesian product. It includes main effects,
 * four pre-specified interactions, and two mappings of configurations that
 * matter before this protocol: the accepted runtime incumbent and an
 * accuracy-heavy identity-card counterpart. All representations remain
 * task-aware; a latest-request-only factor does not exist.
 */
export const buildLunaAccuracyPhaseOneMatrix =
  (): LunaAccuracyMatrixV2 => {
    const variants: LunaAccuracyVariantV2[] = [
      controlVariant(),

      // Task-context capacity.
      withChanges("p1-budget-2k", { taskBudget: "2k" }),
      withChanges("p1-budget-6k", { taskBudget: "6k" }),
      withChanges("p1-budget-32k", { taskBudget: "32k" }),

      // Task-context structure.
      withChanges("p1-format-chronological", {
        taskFormat: "chronological",
      }),
      withChanges("p1-format-compact-json", {
        taskFormat: "compact_json",
      }),

      // Repository-profile detail.
      withChanges("p1-profile-identity", {
        repositoryProfileDetail: "identity",
      }),
      withChanges("p1-profile-full", {
        repositoryProfileDetail: "full",
      }),

      // Area Registry evidence families.
      withChanges("p1-areas-identity", { areaFieldBundle: "identity" }),
      withChanges("p1-areas-contrastive", {
        areaFieldBundle: "contrastive",
      }),
      withChanges("p1-areas-anchors", { areaFieldBundle: "anchors" }),
      withChanges("p1-areas-prototypes", {
        areaFieldBundle: "prototypes",
      }),
      withChanges("p1-registry-prose", { registryFormat: "prose" }),

      // Prior accepted runtime incumbent, mapped into the accuracy protocol.
      // The former balanced context was an 8,192-character envelope, so 2k
      // token-equivalent is its exact character-cap counterpart.
      withChanges("p1-incumbent-balanced-identity-gated", {
        taskBudget: "2k",
        areaFieldBundle: "identity",
        reasoningEffort: "none",
        promptProcedure: "gated",
        outputSchema: "minimal",
        maxOutputTokens: LUNA_ACCURACY_INCUMBENT_MAX_OUTPUT_TOKENS,
      }),

      // Robustness to registry presentation.
      withChanges("p1-order-shuffle", { cardOrdering: "shuffle" }),
      withChanges("p1-order-reverse", { cardOrdering: "reverse" }),

      // Inference effort.
      withChanges("p1-reasoning-none", { reasoningEffort: "none" }),
      withChanges("p1-reasoning-low", { reasoningEffort: "low" }),
      withChanges("p1-reasoning-high", { reasoningEffort: "high" }),

      // Decision procedure.
      withChanges("p1-procedure-gated", { promptProcedure: "gated" }),
      withChanges("p1-procedure-contrastive", {
        promptProcedure: "contrastive",
      }),

      // Observable output scaffolding.
      withChanges("p1-output-minimal", {
        outputSchema: "minimal",
      }),
      withChanges("p1-output-evidence", {
        outputSchema: "evidence",
      }),

      // Accuracy-heavy identity-card interaction. This isolates whether high
      // reasoning and decomposition recover accuracy from a minimal registry.
      withChanges("p1-interaction-identity-high-decomposed", {
        areaFieldBundle: "identity",
        reasoningEffort: "high",
        promptProcedure: "decomposed",
      }),

      // Four pre-registered interactions, selected before results are seen.
      withChanges("p1-interaction-compact-json-6k", {
        taskFormat: "compact_json",
        taskBudget: "6k",
      }),
      withChanges("p1-interaction-chronological-32k", {
        taskFormat: "chronological",
        taskBudget: "32k",
      }),
      withChanges("p1-interaction-contrastive-prose", {
        areaFieldBundle: "contrastive",
        registryFormat: "prose",
        promptProcedure: "contrastive",
      }),
      withChanges("p1-interaction-full-high", {
        repositoryProfileDetail: "full",
        areaFieldBundle: "full",
        reasoningEffort: "high",
      }),
    ];
    const matrix: LunaAccuracyMatrixV2 = {
      schemaVersion: 2,
      description:
        "Phase 1: 28-arm task-aware Luna main-effect screen with a transport-safe 4096-token allowance for every non-incumbent arm, the exact accepted runtime incumbent mapping, and pre-registered accuracy interactions; no latest-request-only representation.",
      variants,
    };
    validateLunaAccuracyMatrixV2(matrix);
    if (matrix.variants.length !== LUNA_ACCURACY_PHASE_ONE_VARIANT_COUNT) {
      throw new Error("Internal Phase 1 matrix size changed unexpectedly");
    }
    return matrix;
  };

const repeatedCopy = (
  source: LunaAccuracyVariantV2,
  id: string,
): LunaAccuracyVariantV2 => ({
  ...source,
  id,
  repetitions: 3,
  fixedSeedList: [...SEEDS],
});

const safeFinalistId = (id: string): string =>
  id.replace(/^p1-/u, "").slice(0, 65);

const PHASE_TWO_INTERACTION_IDS = [
  "p1-interaction-identity-high-decomposed",
  "p1-interaction-compact-json-6k",
  "p1-interaction-chronological-32k",
  "p1-interaction-contrastive-prose",
  "p1-interaction-full-high",
] as const;

/**
 * Repeats six score-selected finalists and ensures the two best
 * pre-registered interaction arms are also confirmed. Callers pass the IDs in
 * already-ranked order; no test result is needed or accepted here.
 */
export const buildLunaAccuracyPhaseTwoMatrix = (
  phaseOne: LunaAccuracyMatrixV2,
  rankedPhaseOneIds: readonly string[],
): LunaAccuracyMatrixV2 => {
  validateLunaAccuracyMatrixV2(phaseOne);
  const byId = new Map(
    phaseOne.variants.map((variant) => [variant.id, variant]),
  );
  const uniqueRankedIds = [...new Set(rankedPhaseOneIds)];
  for (const id of uniqueRankedIds) {
    if (!byId.has(id)) {
      throw new Error(`Unknown Phase 1 finalist ID: ${id}`);
    }
  }
  if (
    uniqueRankedIds.length !== phaseOne.variants.length ||
    phaseOne.variants.some(
      (variant) => !uniqueRankedIds.includes(variant.id),
    )
  ) {
    throw new Error(
      "Phase 2 requires a complete ranking of every Phase 1 candidate",
    );
  }
  const selected = uniqueRankedIds.slice(
    0,
    LUNA_ACCURACY_PHASE_ONE_FINALIST_COUNT,
  );
  const interactionCandidates = PHASE_TWO_INTERACTION_IDS
    .filter((id) => byId.has(id))
    .sort(
      (left, right) =>
        uniqueRankedIds.indexOf(left) - uniqueRankedIds.indexOf(right),
    )
    .filter((id) => !selected.includes(id))
    .slice(0, 2);
  const sourceIds = [...selected, ...interactionCandidates];
  const variants = sourceIds.map((sourceId, index) =>
    repeatedCopy(
      byId.get(sourceId)!,
      `p2-${String(index + 1).padStart(2, "0")}-${safeFinalistId(sourceId)}`,
    )
  );
  const matrix: LunaAccuracyMatrixV2 = {
    schemaVersion: 2,
    description:
      "Phase 2: three fixed-seed repetitions of six validation finalists plus up to two pre-registered interaction confirmations.",
    variants,
  };
  validateLunaAccuracyMatrixV2(matrix);
  return matrix;
};

/**
 * Corrected Phase 2b confirmation.
 *
 * Phase 2 contained provider-visible aliases, so its nominal arm ranking
 * could not estimate configuration effects. This fixed design contains only
 * the three pre-registered, provider-distinct treatments:
 *
 * A — conservative 6k labeled-sections baseline;
 * B — A with chronological 16k task context;
 * C — A with high rather than medium reasoning.
 *
 * Every treatment uses the same seven paired seeds. The runner schedule must
 * use `LUNA_ACCURACY_PHASE_TWO_B_SCHEDULE_SEED`; the schedule seed deliberately
 * lives outside the provider-visible treatment definition.
 */
export const buildLunaAccuracyPhaseTwoBMatrix =
  (): LunaAccuracyMatrixV2 => {
    const base = {
      schemaVersion: 2 as const,
      taskFormat: "labeled_sections" as const,
      taskBudget: "6k" as const,
      repositoryProfileDetail: "components" as const,
      areaFieldBundle: "full" as const,
      registryFormat: "compact_json" as const,
      cardOrdering: "canonical" as const,
      reasoningEffort: "medium" as const,
      promptProcedure: "decomposed" as const,
      outputSchema: "ranked" as const,
      maxOutputTokens: LUNA_ACCURACY_TRANSPORT_SAFE_MAX_OUTPUT_TOKENS,
      repetitions: 7,
      fixedSeedList: [...LUNA_ACCURACY_PHASE_TWO_B_FIXED_SEED_LIST],
    };
    const variants: LunaAccuracyVariantV2[] = [
      {
        ...base,
        id: "p2b-a-labeled-6k-medium",
      },
      {
        ...base,
        id: "p2b-b-chronological-16k-medium",
        taskFormat: "chronological",
        taskBudget: "16k",
      },
      {
        ...base,
        id: "p2b-c-labeled-6k-high",
        reasoningEffort: "high",
      },
    ];
    const matrix: LunaAccuracyMatrixV2 = {
      schemaVersion: 2,
      description:
        "Corrected Phase 2b: three provider-distinct, task-aware single-call treatments over seven paired seeds; schedule seed 19871. A is the conservative labeled-sections 6k medium-reasoning baseline, B changes only to chronological 16k context, and C changes only to high reasoning.",
      variants,
    };
    validateLunaAccuracyMatrixV2(matrix);
    return matrix;
  };

export interface LunaAccuracyPhaseThreeDesign {
  matrix: LunaAccuracyMatrixV2;
  arms: LunaAccuracyExperimentArm[];
}

/**
 * Builds the architecture comparison around two frozen Phase 2b contexts:
 * the selected context and its strongest alternative. Each context is copied
 * into three architecture arms. This allows an architecture to advance only
 * when its gain transfers across both context representations rather than
 * overfitting one prompt/context treatment.
 *
 * Within each context, all provider-visible classification settings are held
 * fixed. The single-call baseline gets three independent paired trials,
 * self-consistency gets one three-member ensemble, and proposal/verify/revise
 * gets one three-call pipeline. Across 26 cases this is exactly 468 provider
 * calls: 2 contexts × (3 + 3 + 3) calls per case.
 */
export const buildLunaAccuracyPhaseThreeDesign = (
  primaryContext: LunaAccuracyVariantV2,
  alternativeContext: LunaAccuracyVariantV2,
): LunaAccuracyPhaseThreeDesign => {
  if (primaryContext.id === alternativeContext.id) {
    throw new Error("Phase 3 requires two different frozen contexts");
  }
  validateLunaAccuracyMatrixV2({
    schemaVersion: 2,
    variants: [primaryContext, alternativeContext],
  });
  const providerVisibleContextKey = (
    variant: LunaAccuracyVariantV2,
  ): string =>
    contentHash({
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
  if (
    providerVisibleContextKey(primaryContext) ===
      providerVisibleContextKey(alternativeContext)
  ) {
    throw new Error(
      "Phase 3 primary and alternative contexts must be provider-distinct",
    );
  }

  const variants: LunaAccuracyVariantV2[] = [];
  const arms: LunaAccuracyExperimentArm[] = [];
  for (const [contextKey, source] of [
    ["primary", primaryContext],
    ["alternative", alternativeContext],
  ] as const) {
    const seeds = LUNA_ACCURACY_PHASE_TWO_B_FIXED_SEED_LIST;
    const singleId = `p3-${contextKey}-single`;
    const selfConsistencyId = `p3-${contextKey}-sc3`;
    const pipelineId = `p3-${contextKey}-pvr`;
    variants.push(
      {
        ...source,
        id: singleId,
        repetitions: LUNA_ACCURACY_PHASE_THREE_SINGLE_REPETITIONS,
        fixedSeedList: seeds.slice(
          0,
          LUNA_ACCURACY_PHASE_THREE_SINGLE_REPETITIONS,
        ),
      },
      {
        ...source,
        id: selfConsistencyId,
        repetitions:
          LUNA_ACCURACY_PHASE_THREE_SELF_CONSISTENCY_MEMBERS,
        fixedSeedList: seeds.slice(
          0,
          LUNA_ACCURACY_PHASE_THREE_SELF_CONSISTENCY_MEMBERS,
        ),
      },
      {
        ...source,
        id: pipelineId,
        repetitions: LUNA_ACCURACY_PHASE_THREE_PIPELINE_REPETITIONS,
        fixedSeedList: seeds.slice(
          0,
          LUNA_ACCURACY_PHASE_THREE_PIPELINE_REPETITIONS,
        ),
      },
    );
    arms.push(
      {
        id: singleId,
        variantId: singleId,
        architecture: "single_call",
      },
      {
        id: selfConsistencyId,
        variantId: selfConsistencyId,
        architecture: "self_consistency_3",
      },
      {
        id: pipelineId,
        variantId: pipelineId,
        architecture: "proposal_verify_revise",
      },
    );
  }
  const matrix: LunaAccuracyMatrixV2 = {
    schemaVersion: 2,
    description:
      "Phase 3: preregistered two-context architecture comparison. The frozen Phase 2b selection and strongest alternative each receive three single-call trials, one three-member self-consistency ensemble, and one proposal-verify-revise pipeline.",
    variants,
  };
  validateLunaAccuracyMatrixV2(matrix);
  return { matrix, arms };
};

const assertTransitionReportBase = (input: {
  report: LunaAccuracySelectionReport;
  matrix: LunaAccuracyMatrixV2;
  requiredVariantIds: readonly string[];
  allowedArchitectures: readonly LunaAccuracyArchitecture[];
}): void => {
  const { report, matrix } = input;
  if (
    report.schemaVersion !== 2 ||
    report.model !== "openai/gpt-5.6-luna" ||
    report.datasetRole !== "validation" ||
    report.dataSource !== "real_user"
  ) {
    throw new Error(
      "Phase transition requires a real-user validation report for Luna",
    );
  }
  const hashPattern = /^[a-f0-9]{64}$/u;
  if (
    !Object.values(report.provenance).every(
      (hash) => typeof hash === "string" && hashPattern.test(hash),
    ) ||
    report.provenance.modelHash !== lunaAccuracyModelHash(report.model) ||
    report.provenance.matrixHash !== lunaAccuracyMatrixHash(matrix)
  ) {
    throw new Error(
      "Phase transition report is not bound to the supplied matrix/model",
    );
  }
  const expectedIds = [...input.requiredVariantIds].sort();
  const rankedIds = report.ranking.map((entry) => entry.variantId);
  if (
    report.ranking.length !== expectedIds.length ||
    new Set(rankedIds).size !== rankedIds.length ||
    [...rankedIds].sort().some((id, index) => id !== expectedIds[index]) ||
    report.ranking.some(
      (entry, index) =>
        entry.rank !== index + 1 ||
        !input.allowedArchitectures.includes(entry.architecture),
    )
  ) {
    throw new Error(
      "Phase transition requires a complete, unique candidate ranking",
    );
  }
  if (
    report.recommendation.winnerVariantId !== rankedIds[0] ||
    report.recommendation.winnerArmId !== report.ranking[0]?.armId
  ) {
    throw new Error(
      "Phase transition report recommendation is inconsistent with ranking",
    );
  }
};

export const validateLunaAccuracyPhaseOneTransition = (input: {
  phaseOne: LunaAccuracyMatrixV2;
  report: LunaAccuracySelectionReport;
  runManifest: LunaAccuracyRunManifest;
  attestation: LunaAccuracyAnalysisAttestationV1;
  analysisInputs: Omit<
    BuildLunaAccuracyAttestedAnalysisInput,
    "matrix" | "runManifest"
  >;
}): void => {
  validateLunaAccuracyMatrixV2(input.phaseOne);
  const verified = validateLunaAccuracyAnalysisAttestation({
    ...input.analysisInputs,
    matrix: input.phaseOne,
    runManifest: input.runManifest,
    report: input.report,
    attestation: input.attestation,
  });
  const expectedArms = input.phaseOne.variants.map((variant) => ({
    id: variant.id,
    variantId: variant.id,
    architecture: "single_call" as const,
  }));
  assertTransitionReportBase({
    report: verified.report,
    matrix: input.phaseOne,
    requiredVariantIds: input.phaseOne.variants.map((variant) => variant.id),
    allowedArchitectures: ["single_call"],
  });
  validateLunaAccuracyRunManifestBinding({
    manifest: input.runManifest,
    model: verified.report.model,
    matrix: input.phaseOne,
    arms: expectedArms,
  });
  if (
    verified.report.provenance.datasetHash !==
      input.runManifest.hashes.runtimeEpisodes ||
    verified.report.provenance.runInputHash !==
      input.runManifest.inputHash ||
    verified.report.provenance.runConfigurationHash !==
      input.runManifest.configurationHash ||
    verified.report.provenance.matrixHash !==
      input.runManifest.hashes.matrix ||
    verified.report.provenance.armsHash !==
      input.runManifest.hashes.arms ||
    verified.report.provenance.armsHash !==
      lunaAccuracyArmsHash(input.phaseOne, expectedArms)
  ) {
    throw new Error(
      "Phase 1 report is not bound to the supplied experiment arms",
    );
  }
};

export const validateLunaAccuracyPhaseTwoTransition = (input: {
  phaseTwo: LunaAccuracyMatrixV2;
  report: LunaAccuracySelectionReport;
  runManifest: LunaAccuracyRunManifest;
  attestation: LunaAccuracyAnalysisAttestationV1;
  analysisInputs: Omit<
    BuildLunaAccuracyAttestedAnalysisInput,
    "matrix" | "runManifest"
  >;
}): void => {
  validateLunaAccuracyMatrixV2(input.phaseTwo);
  const verified = validateLunaAccuracyAnalysisAttestation({
    ...input.analysisInputs,
    matrix: input.phaseTwo,
    runManifest: input.runManifest,
    report: input.report,
    attestation: input.attestation,
  });
  const expectedArms = input.phaseTwo.variants.map((variant) => ({
    id: variant.id,
    variantId: variant.id,
    architecture: "single_call" as const,
  }));
  assertTransitionReportBase({
    report: verified.report,
    matrix: input.phaseTwo,
    requiredVariantIds: input.phaseTwo.variants.map((variant) => variant.id),
    allowedArchitectures: ["single_call"],
  });
  validateLunaAccuracyRunManifestBinding({
    manifest: input.runManifest,
    model: verified.report.model,
    matrix: input.phaseTwo,
    arms: expectedArms,
  });
  if (
    input.runManifest.hashes.runtimeEpisodes !==
      verified.report.provenance.datasetHash ||
    input.runManifest.inputHash !==
      verified.report.provenance.runInputHash ||
    input.runManifest.configurationHash !==
      verified.report.provenance.runConfigurationHash ||
    input.runManifest.hashes.matrix !==
      verified.report.provenance.matrixHash ||
    input.runManifest.hashes.arms !==
      verified.report.provenance.armsHash ||
    verified.report.provenance.armsHash !==
      lunaAccuracyArmsHash(input.phaseTwo, expectedArms)
  ) {
    throw new Error(
      "Phase 2 report is not bound to the supplied experiment arms",
    );
  }
};

export interface LunaAccuracyFreezeRecord {
  schemaVersion: 2;
  protocolVersion: typeof LUNA_ACCURACY_PROTOCOL_VERSION;
  status: "frozen_for_locked_test";
  frozenAt: string;
  model: "openai/gpt-5.6-luna";
  modelHash: string;
  validationDatasetHash: string;
  lockedTestDatasetHash: string;
  repositoryProfileHash: string;
  areaRegistryHash: string;
  selectedMatrixHash: string;
  selectedArmsHash: string;
  selectionRunInputHash: string;
  selectionRunConfigurationHash: string;
  selectedArchitecture: LunaAccuracyArchitecture;
  selectedVariant: LunaAccuracyVariantV2;
  selectedArm: LunaAccuracyExperimentArm;
  selectionReportHash: string;
  syntheticChallengeSpecificationHash: string;
  lockedTestPolicy: {
    maximumEvaluations: 1;
    tuningAfterEvaluationForbidden: true;
    caseLevelInspectionBeforeEvaluationForbidden: true;
  };
}

/**
 * Requires an explicit, complete freeze record before a locked test may run.
 * This function is intentionally independent of any test episodes or labels.
 */
export const validateLunaAccuracyFreezeRecord = (
  value: LunaAccuracyFreezeRecord,
): void => {
  if (
    value.schemaVersion !== 2 ||
    value.protocolVersion !== LUNA_ACCURACY_PROTOCOL_VERSION ||
    value.status !== "frozen_for_locked_test" ||
    value.model !== "openai/gpt-5.6-luna" ||
    !Number.isFinite(Date.parse(value.frozenAt))
  ) {
    throw new Error("Invalid Luna accuracy freeze record");
  }
  for (const [name, hash] of [
    ["validationDatasetHash", value.validationDatasetHash],
    ["lockedTestDatasetHash", value.lockedTestDatasetHash],
    ["modelHash", value.modelHash],
    ["repositoryProfileHash", value.repositoryProfileHash],
    ["areaRegistryHash", value.areaRegistryHash],
    ["selectedMatrixHash", value.selectedMatrixHash],
    ["selectedArmsHash", value.selectedArmsHash],
    ["selectionRunInputHash", value.selectionRunInputHash],
    [
      "selectionRunConfigurationHash",
      value.selectionRunConfigurationHash,
    ],
    ["selectionReportHash", value.selectionReportHash],
    [
      "syntheticChallengeSpecificationHash",
      value.syntheticChallengeSpecificationHash,
    ],
  ] as const) {
    if (!/^[a-f0-9]{64}$/u.test(hash)) {
      throw new Error(`Invalid freeze ${name}`);
    }
  }
  if (
    ![
      "single_call",
      "self_consistency_3",
      "proposal_verify_revise",
    ].includes(value.selectedArchitecture) ||
    value.lockedTestPolicy.maximumEvaluations !== 1 ||
    value.lockedTestPolicy.tuningAfterEvaluationForbidden !== true ||
    value.lockedTestPolicy.caseLevelInspectionBeforeEvaluationForbidden !==
      true
  ) {
    throw new Error("Invalid locked-test freeze policy");
  }
  validateLunaAccuracyMatrixV2({
    schemaVersion: 2,
    variants: [value.selectedVariant],
  });
  if (
    value.modelHash !== lunaAccuracyModelHash(value.model) ||
    value.selectedArm.variantId !== value.selectedVariant.id ||
    value.selectedArm.architecture !== value.selectedArchitecture ||
    value.selectedMatrixHash !==
      lunaAccuracyMatrixHash({
        schemaVersion: 2,
        variants: [value.selectedVariant],
      }) ||
    value.selectedArmsHash !==
      lunaAccuracyArmsHash(
        { schemaVersion: 2, variants: [value.selectedVariant] },
        [value.selectedArm],
      )
  ) {
    throw new Error("Locked-test freeze selection binding is inconsistent");
  }
};

export const assertLunaAccuracyFreezeInputs = (input: {
  freeze: LunaAccuracyFreezeRecord;
  model: string;
  profile: RepositoryProfileV1;
  cards: readonly AreaCardV1[];
  episodes: readonly TaskEpisode[];
  matrix: LunaAccuracyMatrixV2;
  arms?: readonly LunaAccuracyExperimentArm[];
}): void => {
  validateLunaAccuracyFreezeRecord(input.freeze);
  const arms = input.arms ?? [input.freeze.selectedArm];
  if (
    input.model !== input.freeze.model ||
    lunaAccuracyModelHash(input.model) !== input.freeze.modelHash ||
    lunaAccuracyProfileHash(input.profile) !==
      input.freeze.repositoryProfileHash ||
    lunaAccuracyAreaRegistryHash(input.cards) !==
      input.freeze.areaRegistryHash ||
    lunaAccuracyRuntimeEpisodesHash(input.episodes) !==
      input.freeze.lockedTestDatasetHash ||
    lunaAccuracyMatrixHash(input.matrix) !==
      input.freeze.selectedMatrixHash ||
    lunaAccuracyArmsHash(input.matrix, arms) !==
      input.freeze.selectedArmsHash
  ) {
    throw new Error(
      "Locked-test runtime inputs do not match the frozen configuration",
    );
  }
};

export const createLunaAccuracyFreezeRecord = (input: {
  frozenAt?: string;
  model: "openai/gpt-5.6-luna";
  validationEpisodes: readonly TaskEpisode[];
  lockedTestEpisodes: readonly TaskEpisode[];
  profile: RepositoryProfileV1;
  cards: readonly AreaCardV1[];
  selectionMatrix: LunaAccuracyMatrixV2;
  selectionArms?: readonly LunaAccuracyExperimentArm[];
  selectedVariant: LunaAccuracyVariantV2;
  selectedArm: LunaAccuracyExperimentArm;
  selectionReport: LunaAccuracySelectionReport;
  selectionRunManifest: LunaAccuracyRunManifest;
  syntheticChallengeSpecification: unknown;
}): LunaAccuracyFreezeRecord => {
  const lockedMatrix = {
    schemaVersion: 2 as const,
    variants: [input.selectedVariant],
  };
  validateLunaAccuracyRunManifestBinding({
    manifest: input.selectionRunManifest,
    model: input.model,
    episodes: input.validationEpisodes,
    matrix: input.selectionMatrix,
    ...(input.selectionArms ? { arms: input.selectionArms } : {}),
  });
  const selectionArms = input.selectionArms ??
    input.selectionMatrix.variants.map((variant) => ({
      id: variant.id,
      variantId: variant.id,
      architecture: "single_call" as const,
    }));
  const selectedMatrixVariant = input.selectionMatrix.variants.find(
    (variant) => variant.id === input.selectedVariant.id,
  );
  const selectedMatrixArm = selectionArms.find(
    (arm) => arm.id === input.selectedArm.id,
  );
  const winningRanking = input.selectionReport.ranking[0];
  if (
    input.selectionReport.schemaVersion !== 2 ||
    input.selectionReport.model !== input.model ||
    input.selectionReport.datasetRole !== "validation" ||
    input.selectionReport.dataSource !== "real_user" ||
    input.selectionReport.provenance.modelHash !==
      lunaAccuracyModelHash(input.model) ||
    input.selectionReport.provenance.datasetHash !==
      input.selectionRunManifest.hashes.runtimeEpisodes ||
    input.selectionReport.provenance.matrixHash !==
      input.selectionRunManifest.hashes.matrix ||
    input.selectionReport.provenance.armsHash !==
      input.selectionRunManifest.hashes.arms ||
    input.selectionReport.provenance.runInputHash !==
      input.selectionRunManifest.inputHash ||
    input.selectionReport.provenance.runConfigurationHash !==
      input.selectionRunManifest.configurationHash ||
    input.selectionReport.recommendation.winnerArmId !==
      input.selectedArm.id ||
    input.selectionReport.recommendation.winnerVariantId !==
      input.selectedVariant.id ||
    winningRanking?.armId !== input.selectedArm.id ||
    winningRanking.variantId !== input.selectedVariant.id ||
    winningRanking.architecture !== input.selectedArm.architecture ||
    !selectedMatrixVariant ||
    contentHash(selectedMatrixVariant) !== contentHash(input.selectedVariant) ||
    !selectedMatrixArm ||
    contentHash(selectedMatrixArm) !== contentHash(input.selectedArm)
  ) {
    throw new Error(
      "Locked-test freeze selection does not match its validation report, matrix, arms, and run manifest",
    );
  }
  const record: LunaAccuracyFreezeRecord = {
    schemaVersion: 2,
    protocolVersion: LUNA_ACCURACY_PROTOCOL_VERSION,
    status: "frozen_for_locked_test",
    frozenAt: input.frozenAt ?? new Date().toISOString(),
    model: input.model,
    modelHash: lunaAccuracyModelHash(input.model),
    validationDatasetHash:
      lunaAccuracyRuntimeEpisodesHash(input.validationEpisodes),
    lockedTestDatasetHash:
      lunaAccuracyRuntimeEpisodesHash(input.lockedTestEpisodes),
    repositoryProfileHash: lunaAccuracyProfileHash(input.profile),
    areaRegistryHash: lunaAccuracyAreaRegistryHash(input.cards),
    selectedMatrixHash: lunaAccuracyMatrixHash(lockedMatrix),
    selectedArmsHash:
      lunaAccuracyArmsHash(lockedMatrix, [input.selectedArm]),
    selectionRunInputHash: input.selectionRunManifest.inputHash,
    selectionRunConfigurationHash:
      input.selectionRunManifest.configurationHash,
    selectedArchitecture: input.selectedArm.architecture,
    selectedVariant: input.selectedVariant,
    selectedArm: { ...input.selectedArm },
    selectionReportHash: contentHash(input.selectionReport),
    syntheticChallengeSpecificationHash:
      contentHash(input.syntheticChallengeSpecification),
    lockedTestPolicy: {
      maximumEvaluations: 1,
      tuningAfterEvaluationForbidden: true,
      caseLevelInspectionBeforeEvaluationForbidden: true,
    },
  };
  validateLunaAccuracyFreezeRecord(record);
  return record;
};
