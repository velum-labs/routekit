import { contentHash } from "./hash.ts";
import {
  LUNA_ACCURACY_TASK_BUDGET_CHARACTER_CAPS,
  type LunaAccuracyTaskBudget,
} from "./luna-accuracy-context.ts";
import type {
  AreaCardV1,
  SilverLabelV1,
  TaskEpisode,
  TaskEpisodeV1,
} from "./types.ts";
import { validateEpisodes, validateSilverLabels } from "./validation.ts";

export const LUNA_GROUNDED_CODING_DEVELOPMENT_VERSION =
  "grounded-coding-development-v2-long-context-cap-coverage" as const;

export const LUNA_GROUNDED_CODING_LONG_CONTEXT_MINIMUM_CHARACTERS =
  90_000 as const;

export const LUNA_GROUNDED_CODING_VARIANT_KINDS = [
  "referential",
  "long_relevant_context",
  "irrelevant_distractor",
  "diagnostic_followup",
  "controlled_truncation",
] as const;

export type LunaGroundedCodingVariantKind =
  (typeof LUNA_GROUNDED_CODING_VARIANT_KINDS)[number];

export interface LunaGroundedCodingAssignment {
  taskEpisodeId: string;
  selectedAreaIds: string[];
}

export interface LunaGroundedCodingBaseLabel extends SilverLabelV1 {
  labelSource: "repository_derived_changed_path_heuristic_not_silver";
  evidenceSource: "post_task_changed_paths";
  sourceTaskEpisodeId: string;
  actualChangedPaths: string[];
}

export interface LunaGroundedCodingInheritedLabel extends SilverLabelV1 {
  labelSource: "inherited_repository_derived_not_silver";
  sourceTaskEpisodeId: string;
  sourceEvidenceHash: string;
  variantKind: LunaGroundedCodingVariantKind;
  labelPreservingByConstruction: true;
}

export interface LunaGroundedCodingSilverBaseLabel extends SilverLabelV1 {
  labelSource: "independent_sol_silver_repository_aware";
  sourceTaskEpisodeId: string;
  sourceLabelHash: string;
}

export interface LunaGroundedCodingInheritedSilverLabel
  extends SilverLabelV1 {
  labelSource: "inherited_sol_silver_not_independent";
  sourceTaskEpisodeId: string;
  sourceLabelHash: string;
  variantKind: LunaGroundedCodingVariantKind;
  labelPreservingByConstruction: true;
}

export type LunaGroundedCodingLabelPolicy =
  | "inherited_repository_derived_label_preserving_not_silver"
  | "inherited_sol_silver_label_preserving_not_independent";

export interface LunaGroundedCodingProvenance {
  schemaVersion: 1;
  specificationVersion:
    typeof LUNA_GROUNDED_CODING_DEVELOPMENT_VERSION;
  derivativeEpisodeId: string;
  sourceEpisodeId: string;
  sourceSessionHash: string;
  sourceLineageHash: string;
  derivativeSessionHash: string;
  derivativeLineageHash: string;
  variantKind: LunaGroundedCodingVariantKind;
  construction: string;
  sourceActualChangedPathsUsedInRuntimeConstruction: false;
  areaAssignmentUsedInRuntimeConstruction: false;
  labelPolicy: LunaGroundedCodingLabelPolicy;
}

export interface LunaGroundedCodingLongContextCoverage {
  targetMinimumRawCharacters: number;
  generatedCases: number;
  minimumRawTaskContextCharacters: number;
  maximumRawTaskContextCharacters: number;
  casesExceedingBudgetCaps: Record<LunaAccuracyTaskBudget, number>;
  everyCaseExceedsBudgetCaps: Record<LunaAccuracyTaskBudget, boolean>;
}

export interface LunaGroundedCodingDevelopmentSuite {
  schemaVersion: 1;
  specificationVersion:
    typeof LUNA_GROUNDED_CODING_DEVELOPMENT_VERSION;
  baseEpisodes: TaskEpisode[];
  baseLabels: LunaGroundedCodingBaseLabel[];
  derivedEpisodes: TaskEpisodeV1[];
  derivedLabels: LunaGroundedCodingInheritedLabel[];
  provenance: LunaGroundedCodingProvenance[];
  report: {
    schemaVersion: 1;
    role: "coding_heavy_development_stress_not_headline_validation";
    sourceValidationEpisodes: number;
    scorableBaseEpisodes: number;
    excludedUnassignedEpisodes: number;
    excludedUnassignedEpisodeIds: string[];
    derivedEpisodes: number;
    variantsPerSource: number;
    variantCounts: Record<LunaGroundedCodingVariantKind, number>;
    singleAreaSources: number;
    multiAreaSources: number;
    areaCounts: Record<string, number>;
    longContextCoverage: LunaGroundedCodingLongContextCoverage;
    runtimeLeakagePolicy: {
      actualChangedPathsIncluded: false;
      selectedAreaIdsIncluded: false;
      labelsIncluded: false;
    };
    reportingPolicy: {
      combineWithRealHeadline: false;
      inheritedLabelsAreIndependentSilverLabels: false;
      selectProductConfigurationFromThisSuiteAlone: false;
    };
    warnings: string[];
  };
}

export interface LunaGroundedCodingSilverDevelopmentSuite {
  schemaVersion: 1;
  specificationVersion:
    typeof LUNA_GROUNDED_CODING_DEVELOPMENT_VERSION;
  baseEpisodes: TaskEpisode[];
  baseLabels: LunaGroundedCodingSilverBaseLabel[];
  derivedEpisodes: TaskEpisodeV1[];
  derivedLabels: LunaGroundedCodingInheritedSilverLabel[];
  provenance: LunaGroundedCodingProvenance[];
  report: {
    schemaVersion: 1;
    role: "coding_heavy_sol_silver_development_not_headline_validation";
    sourceValidationEpisodes: number;
    exactBaseEpisodes: number;
    derivedEpisodes: number;
    variantsPerSource: number;
    variantCounts: Record<LunaGroundedCodingVariantKind, number>;
    knownSources: number;
    unknownSources: number;
    unknownSubtypeCounts: Record<string, number>;
    singleAreaSources: number;
    multiAreaSources: number;
    areaCounts: Record<string, number>;
    longContextCoverage: LunaGroundedCodingLongContextCoverage;
    sourceLabelPolicy:
      "independent_repository_aware_sol_silver_exact_join";
    derivativeLabelPolicy:
      "inherited_label_preserving_not_independent_evidence";
    runtimeLeakagePolicy: {
      actualChangedPathsIncluded: false;
      selectedAreaIdsIncluded: false;
      labelsIncluded: false;
      sourceLabelsUsedToConstructRuntimeContext: false;
    };
    reportingPolicy: {
      combineWithRealHeadline: false;
      derivativeLabelsAreIndependentSilverLabels: false;
      clusterDerivativesWithSource: true;
    };
    warnings: string[];
  };
}

const lexicalCompare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const clipHeadTail = (text: string, maximumCharacters: number): string => {
  const value = text.trim();
  if (value.length <= maximumCharacters) return value;
  const marker = "\n…[controlled context truncation]…\n";
  const available = maximumCharacters - marker.length;
  const head = Math.ceil(available * 0.65);
  return `${value.slice(0, head)}${marker}${value.slice(
    -(available - head),
  )}`;
};

const taskAwareContextCharacters = (episode: TaskEpisode): number =>
  [
    episode.taskAnchor,
    ...(episode.earlierUserContext ?? []),
    episode.precedingAssistant,
    episode.relevantDiagnostic,
    episode.currentRequest,
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n").length;

const longContextCoverage = (
  derivedEpisodes: readonly TaskEpisode[],
  provenance: readonly LunaGroundedCodingProvenance[],
): LunaGroundedCodingLongContextCoverage => {
  const longContextIds = new Set(
    provenance
      .filter((item) => item.variantKind === "long_relevant_context")
      .map((item) => item.derivativeEpisodeId),
  );
  const longContextCharacters = derivedEpisodes
    .filter((episode) => longContextIds.has(episode.id))
    .map(taskAwareContextCharacters);
  if (longContextCharacters.length === 0) {
    throw new Error("Grounded coding suite has no long-context derivatives");
  }
  const budgetEntries = Object.entries(
    LUNA_ACCURACY_TASK_BUDGET_CHARACTER_CAPS,
  ) as Array<[LunaAccuracyTaskBudget, number]>;
  const casesExceedingBudgetCaps = Object.fromEntries(
    budgetEntries.map(([budget, cap]) => [
      budget,
      longContextCharacters.filter((characters) => characters > cap).length,
    ]),
  ) as Record<LunaAccuracyTaskBudget, number>;
  const everyCaseExceedsBudgetCaps = Object.fromEntries(
    budgetEntries.map(([budget]) => [
      budget,
      casesExceedingBudgetCaps[budget] === longContextCharacters.length,
    ]),
  ) as Record<LunaAccuracyTaskBudget, boolean>;
  if (
    longContextCharacters.some(
      (characters) =>
        characters < LUNA_GROUNDED_CODING_LONG_CONTEXT_MINIMUM_CHARACTERS,
    )
  ) {
    throw new Error(
      "Grounded coding long-context derivative does not meet its raw character minimum",
    );
  }
  return {
    targetMinimumRawCharacters:
      LUNA_GROUNDED_CODING_LONG_CONTEXT_MINIMUM_CHARACTERS,
    generatedCases: longContextCharacters.length,
    minimumRawTaskContextCharacters: Math.min(...longContextCharacters),
    maximumRawTaskContextCharacters: Math.max(...longContextCharacters),
    casesExceedingBudgetCaps,
    everyCaseExceedsBudgetCaps,
  };
};

const neutralEngineeringContext = (minimumCharacters: number): string[] => {
  const neutralConstraints = [
    "Preserve behavior outside the requested objective and avoid unrelated cleanup.",
    "Inspect the current implementation before editing and use the repository's existing conventions.",
    "Prefer a small, reviewable change with focused regression coverage for the requested behavior.",
    "Do not infer component ownership from these general workflow notes; resolve ownership from the actual objective.",
    "Treat existing public contracts as stable unless the objective explicitly requires a contract change.",
    "Run the narrowest useful verification first, then broader checks only when they add evidence.",
    "Keep error handling explicit and retain any unrelated compatibility behavior already present.",
    "Avoid speculative abstractions, renames, formatting churn, generated-file edits, and dependency changes.",
    "If evidence conflicts, inspect the implementation and tests rather than guessing from terminology.",
    "Summarize the implemented behavior, verification performed, and any remaining uncertainty.",
    "Repository-wide contributor guidance may apply, but these notes intentionally contain no component, path, symbol, or area clue.",
    "The active task remains the separately retained source objective; this paragraph is only a neutral engineering constraint.",
  ];
  const blocks: string[] = [];
  let characters = 0;
  let block = 1;
  while (characters < minimumCharacters) {
    const rotation = block % neutralConstraints.length;
    const ordered = [
      ...neutralConstraints.slice(rotation),
      ...neutralConstraints.slice(0, rotation),
    ];
    const value = [
      `[NEUTRAL WORK LOG ${String(block).padStart(4, "0")}]`,
      ...ordered.map(
        (constraint, index) =>
          `${index + 1}. ${constraint}`,
      ),
      `Checkpoint ${block}: no repository-specific conclusion has been reached in this neutral log.`,
    ].join("\n");
    blocks.push(value);
    characters += value.length + 1;
    block += 1;
  }
  return blocks;
};

const derivedId = (
  source: TaskEpisode,
  variantKind: LunaGroundedCodingVariantKind,
): string =>
  `coding-dev-${variantKind.replaceAll("_", "-")}-${contentHash({
    sourceEpisodeId: source.id,
    sourceSessionHash: source.sessionHash,
    sourceLineageHash: source.lineageHash,
    variantKind,
    specificationVersion: LUNA_GROUNDED_CODING_DEVELOPMENT_VERSION,
  }).slice(0, 18)}`;

type RuntimeContext = Pick<
  TaskEpisodeV1,
  | "currentRequest"
  | "taskAnchor"
  | "precedingAssistant"
  | "earlierUserContext"
  | "relevantDiagnostic"
>;

/**
 * This function deliberately accepts no label, assignment, or changed-path
 * argument. Runtime context can therefore be constructed only from facts that
 * were already visible in the source task plus fixed neutral scaffolding.
 */
const variantContext = (
  source: TaskEpisode,
  variantKind: LunaGroundedCodingVariantKind,
): { context: RuntimeContext; construction: string } => {
  const objective = source.currentRequest.trim();
  switch (variantKind) {
    case "referential":
      return {
        context: {
          currentRequest:
            "Okay, proceed with that repository change and include the appropriate verification.",
          taskAnchor: objective,
          precedingAssistant:
            `I retained the original objective exactly: ${objective}`,
          earlierUserContext: [
            `Original repository task: ${objective}`,
          ],
        },
        construction:
          "The latest request is referential; the complete source objective is retained in the task anchor and prior turn.",
      };
    case "long_relevant_context": {
      const neutralContext = neutralEngineeringContext(
        LUNA_GROUNDED_CODING_LONG_CONTEXT_MINIMUM_CHARACTERS,
      );
      const firstThird = Math.floor(neutralContext.length / 3);
      const secondThird = Math.floor((neutralContext.length * 2) / 3);
      return {
        context: {
          currentRequest:
            "Continue with the retained repository objective. Use the neutral process log only as constraints, then implement and verify the requested change.",
          taskAnchor: objective,
          precedingAssistant:
            [
              ...neutralContext.slice(firstThird, secondThird),
              "[OBJECTIVE CHECKPOINT — authoritative]",
              objective,
              ...neutralContext.slice(secondThird),
            ].join("\n\n"),
          earlierUserContext: [
            ...neutralContext.slice(0, firstThird),
            `[AUTHORITATIVE SOURCE OBJECTIVE]\n${objective}`,
          ],
        },
        construction:
          "More than 90,000 raw characters of varied neutral engineering constraints surround controlled copies of the complete source objective. The objective appears in the task anchor and at spaced checkpoints so the 2k, 6k, and 16k caps retain meaningfully different context without adding component, path, symbol, area, label, or post-task clues.",
      };
    }
    case "irrelevant_distractor":
      return {
        context: {
          currentRequest:
            "Please complete the original repository task despite the unrelated ambient notes.",
          taskAnchor: objective,
          precedingAssistant:
            `The active implementation objective is still: ${objective}`,
          earlierUserContext: [
            `Original task: ${objective}`,
            "[UNRELATED AMBIENT NOTE] The editor theme and terminal font changed; neither affects repository behavior.",
            "[UNRELATED AMBIENT NOTE] A calendar reminder was dismissed; it is unrelated to code, configuration, tests, or deployment.",
          ],
          relevantDiagnostic:
            "[UNRELATED AMBIENT NOTE] The terminal resized successfully. This is not a program diagnostic.",
        },
        construction:
          "Fixed unrelated ambient notes are added while the complete source objective remains explicit.",
      };
    case "diagnostic_followup":
      return {
        context: {
          currentRequest:
            "Use the diagnostic below to finish the original task and verify the fix.",
          taskAnchor: objective,
          precedingAssistant:
            `I attempted the retained objective: ${objective}. Verification still needs attention.`,
          earlierUserContext: [
            `Original repository task: ${objective}`,
          ],
          relevantDiagnostic:
            "A focused verification step for the requested change did not pass. Reproduce the failure from the retained objective, inspect the responsible implementation, and add or update regression coverage. No component or Area label is supplied by this synthetic diagnostic.",
        },
        construction:
          "A neutral diagnostic follow-up requires task-aware recovery without asserting a component, path, symbol, or answer.",
      };
    case "controlled_truncation": {
      const redundantNarrative = [
        `The active objective is ${objective}.`,
        "Before changing code, inspect the current implementation and its focused tests.",
        "Keep the patch limited to the requested behavior and preserve unrelated contracts.",
        "Use targeted verification first and broader repository checks only as needed.",
        "Record any uncertainty that remains after verification.",
      ].join(" ".repeat(20));
      return {
        context: {
          currentRequest:
            "Continue from the complete retained task anchor; some redundant prior narrative was truncated.",
          taskAnchor: objective,
          precedingAssistant: clipHeadTail(redundantNarrative, 260),
          earlierUserContext: [
            `Original repository task, retained without truncation: ${objective}`,
            clipHeadTail(redundantNarrative.repeat(2), 320),
          ],
        },
        construction:
          "Only redundant neutral narrative is head-tail truncated; the complete source objective remains in the task anchor.",
      };
    }
  }
};

const runtimeDerivative = (
  source: TaskEpisode,
  variantKind: LunaGroundedCodingVariantKind,
): { episode: TaskEpisodeV1; construction: string } => {
  const built = variantContext(source, variantKind);
  return {
    episode: {
      schemaVersion: 1,
      id: derivedId(source, variantKind),
      repositoryId: source.repositoryId,
      repositorySnapshot: source.repositorySnapshot,
      sessionHash: source.sessionHash,
      lineageHash: source.lineageHash,
      timestamp: source.timestamp,
      split: "validation",
      ...built.context,
      source: "derived",
    },
    construction: built.construction,
  };
};

const runtimeBaseEpisode = (source: TaskEpisode): TaskEpisode => {
  const { actualChangedPaths: _removed, ...runtime } = source;
  return runtime as TaskEpisode;
};

const baseLabel = (
  source: TaskEpisode,
  selectedAreaIds: string[],
): LunaGroundedCodingBaseLabel => {
  const actualChangedPaths = [...(source.actualChangedPaths ?? [])];
  return {
    schemaVersion: 1,
    taskEpisodeId: source.id,
    selectedAreaIds: [...selectedAreaIds],
    known: true,
    difficulty:
      selectedAreaIds.length === 2 ? "boundary_multi_area" : "clear",
    confidence: "medium",
    reason:
      "Repository-derived changed-path assignment for a GitHub task. This is heuristic stress-set evidence, not an independent silver label.",
    relevantPaths: [...actualChangedPaths],
    oracle: {
      model: "repository-derived-changed-path-heuristic:not-silver",
      reasoningEffort: "none",
      passCount: 0,
      adjudicated: false,
      humanReviewed: false,
      toolCalls: 0,
      repositoryInspected: false,
    },
    labelSource:
      "repository_derived_changed_path_heuristic_not_silver",
    evidenceSource: "post_task_changed_paths",
    sourceTaskEpisodeId: source.id,
    actualChangedPaths,
  };
};

const inheritedLabel = (
  source: LunaGroundedCodingBaseLabel,
  derivativeEpisodeId: string,
  variantKind: LunaGroundedCodingVariantKind,
): LunaGroundedCodingInheritedLabel => ({
  schemaVersion: 1,
  taskEpisodeId: derivativeEpisodeId,
  selectedAreaIds: [...source.selectedAreaIds],
  known: true,
  difficulty:
    source.selectedAreaIds.length === 2 ? "boundary_multi_area" : "contextual",
  confidence: "medium",
  reason:
    `Label-preserving ${variantKind} transformation inherited a repository-derived changed-path assignment. It is not an independent silver label.`,
  relevantPaths: [],
  oracle: {
    model: "inherited-repository-derived:not-silver",
    reasoningEffort: "none",
    passCount: 0,
    adjudicated: false,
    humanReviewed: false,
    toolCalls: 0,
    repositoryInspected: false,
  },
  labelSource: "inherited_repository_derived_not_silver",
  sourceTaskEpisodeId: source.sourceTaskEpisodeId,
  sourceEvidenceHash: contentHash({
    sourceTaskEpisodeId: source.sourceTaskEpisodeId,
    selectedAreaIds: [...source.selectedAreaIds].sort(),
    actualChangedPaths: [...source.actualChangedPaths].sort(),
  }),
  variantKind,
  labelPreservingByConstruction: true,
});

const silverBaseLabel = (
  source: TaskEpisode,
  label: SilverLabelV1,
): LunaGroundedCodingSilverBaseLabel => ({
  ...label,
  selectedAreaIds: [...label.selectedAreaIds],
  relevantPaths: [...label.relevantPaths],
  oracle: { ...label.oracle },
  labelSource: "independent_sol_silver_repository_aware",
  sourceTaskEpisodeId: source.id,
  sourceLabelHash: contentHash(label),
});

const inheritedSilverLabel = (
  source: LunaGroundedCodingSilverBaseLabel,
  derivativeEpisodeId: string,
  variantKind: LunaGroundedCodingVariantKind,
): LunaGroundedCodingInheritedSilverLabel => ({
  schemaVersion: 1,
  taskEpisodeId: derivativeEpisodeId,
  selectedAreaIds: [...source.selectedAreaIds],
  known: source.known,
  ...(source.unknownType ? { unknownType: source.unknownType } : {}),
  difficulty:
    source.selectedAreaIds.length === 2
      ? "boundary_multi_area"
      : variantKind === "referential" ||
          variantKind === "diagnostic_followup"
      ? "contextual"
      : source.difficulty,
  confidence: source.confidence,
  reason:
    `Label-preserving ${variantKind} transformation inherited the independent Sol decision from ${source.sourceTaskEpisodeId}. This derivative is not independent silver evidence.`,
  relevantPaths: [],
  oracle: {
    model: `inherited:${source.oracle.model}`,
    reasoningEffort: source.oracle.reasoningEffort,
    passCount: 0,
    adjudicated: false,
    humanReviewed: false,
    toolCalls: 0,
    repositoryInspected: false,
  },
  labelSource: "inherited_sol_silver_not_independent",
  sourceTaskEpisodeId: source.sourceTaskEpisodeId,
  sourceLabelHash: source.sourceLabelHash,
  variantKind,
  labelPreservingByConstruction: true,
});

const assertRuntimeHasNoLabelEvidence = (
  baseEpisodes: readonly TaskEpisode[],
  derivedEpisodes: readonly TaskEpisode[],
): void => {
  const runtimeText = JSON.stringify({ baseEpisodes, derivedEpisodes });
  if (
    runtimeText.includes("actualChangedPaths") ||
    runtimeText.includes("selectedAreaIds") ||
    runtimeText.includes("labelSource")
  ) {
    throw new Error("Grounded coding runtime outputs contain label evidence");
  }
};

const variantCountsFromProvenance = (
  provenance: readonly LunaGroundedCodingProvenance[],
): Record<LunaGroundedCodingVariantKind, number> =>
  Object.fromEntries(
    LUNA_GROUNDED_CODING_VARIANT_KINDS.map((kind) => [
      kind,
      provenance.filter((item) => item.variantKind === kind).length,
    ]),
  ) as Record<LunaGroundedCodingVariantKind, number>;

export const buildLunaGroundedCodingDevelopmentSuite = (input: {
  episodes: readonly TaskEpisode[];
  assignments: readonly LunaGroundedCodingAssignment[];
  cards: readonly AreaCardV1[];
}): LunaGroundedCodingDevelopmentSuite => {
  const source = [...input.episodes]
    .filter((episode) => episode.split === "validation")
    .sort(
      (left, right) =>
        left.timestamp.localeCompare(right.timestamp) ||
        lexicalCompare(left.id, right.id),
    );
  if (!source.length) {
    throw new Error(
      "Grounded coding development requires GitHub validation episodes",
    );
  }
  const sourceIds = new Set<string>();
  for (const episode of source) {
    if (sourceIds.has(episode.id)) {
      throw new Error(`Duplicate coding source episode: ${episode.id}`);
    }
    if (episode.source !== "github") {
      throw new Error(
        `Grounded coding source is not GitHub-derived: ${episode.id}`,
      );
    }
    sourceIds.add(episode.id);
  }
  const assignments = new Map<string, string[]>();
  for (const assignment of input.assignments) {
    if (assignments.has(assignment.taskEpisodeId)) {
      throw new Error(
        `Duplicate coding assignment: ${assignment.taskEpisodeId}`,
      );
    }
    if (!sourceIds.has(assignment.taskEpisodeId)) continue;
    if (
      assignment.selectedAreaIds.length > 2 ||
      new Set(assignment.selectedAreaIds).size !==
        assignment.selectedAreaIds.length
    ) {
      throw new Error(
        `Invalid coding assignment: ${assignment.taskEpisodeId}`,
      );
    }
    assignments.set(
      assignment.taskEpisodeId,
      [...assignment.selectedAreaIds],
    );
  }
  const allowedAreaIds = new Set(input.cards.map((card) => card.areaId));
  const excludedUnassignedEpisodeIds: string[] = [];
  const scorableSources: Array<{
    source: TaskEpisode;
    label: LunaGroundedCodingBaseLabel;
  }> = [];
  for (const episode of source) {
    const selectedAreaIds = assignments.get(episode.id);
    if (!selectedAreaIds?.length) {
      excludedUnassignedEpisodeIds.push(episode.id);
      continue;
    }
    for (const areaId of selectedAreaIds) {
      if (!allowedAreaIds.has(areaId)) {
        throw new Error(
          `Coding assignment ${episode.id} uses unknown area ${areaId}`,
        );
      }
    }
    if (!(episode.actualChangedPaths?.length)) {
      throw new Error(
        `Scorable coding source lacks changed-path evidence: ${episode.id}`,
      );
    }
    scorableSources.push({
      source: episode,
      label: baseLabel(episode, selectedAreaIds),
    });
  }
  if (!scorableSources.length) {
    throw new Error("Grounded coding development has no scorable sources");
  }

  const baseEpisodes = scorableSources.map(({ source }) =>
    runtimeBaseEpisode(source)
  );
  const baseLabels = scorableSources.map(({ label }) => label);
  const derivedEpisodes: TaskEpisodeV1[] = [];
  const derivedLabels: LunaGroundedCodingInheritedLabel[] = [];
  const provenance: LunaGroundedCodingProvenance[] = [];
  for (const { source: sourceEpisode, label } of scorableSources) {
    for (const variantKind of LUNA_GROUNDED_CODING_VARIANT_KINDS) {
      const derivative = runtimeDerivative(sourceEpisode, variantKind);
      derivedEpisodes.push(derivative.episode);
      derivedLabels.push(
        inheritedLabel(label, derivative.episode.id, variantKind),
      );
      provenance.push({
        schemaVersion: 1,
        specificationVersion:
          LUNA_GROUNDED_CODING_DEVELOPMENT_VERSION,
        derivativeEpisodeId: derivative.episode.id,
        sourceEpisodeId: sourceEpisode.id,
        sourceSessionHash: sourceEpisode.sessionHash,
        sourceLineageHash: sourceEpisode.lineageHash,
        derivativeSessionHash: derivative.episode.sessionHash,
        derivativeLineageHash: derivative.episode.lineageHash,
        variantKind,
        construction: derivative.construction,
        sourceActualChangedPathsUsedInRuntimeConstruction: false,
        areaAssignmentUsedInRuntimeConstruction: false,
        labelPolicy:
          "inherited_repository_derived_label_preserving_not_silver",
      });
    }
  }
  validateEpisodes([...baseEpisodes, ...derivedEpisodes], [...input.cards]);
  assertRuntimeHasNoLabelEvidence(baseEpisodes, derivedEpisodes);

  const variantCounts = variantCountsFromProvenance(provenance);
  const areaCounts: Record<string, number> = {};
  for (const label of baseLabels) {
    for (const areaId of label.selectedAreaIds) {
      areaCounts[areaId] = (areaCounts[areaId] ?? 0) + 1;
    }
  }
  return {
    schemaVersion: 1,
    specificationVersion:
      LUNA_GROUNDED_CODING_DEVELOPMENT_VERSION,
    baseEpisodes,
    baseLabels,
    derivedEpisodes,
    derivedLabels,
    provenance,
    report: {
      schemaVersion: 1,
      role: "coding_heavy_development_stress_not_headline_validation",
      sourceValidationEpisodes: source.length,
      scorableBaseEpisodes: baseEpisodes.length,
      excludedUnassignedEpisodes: excludedUnassignedEpisodeIds.length,
      excludedUnassignedEpisodeIds:
        excludedUnassignedEpisodeIds.sort(lexicalCompare),
      derivedEpisodes: derivedEpisodes.length,
      variantsPerSource: LUNA_GROUNDED_CODING_VARIANT_KINDS.length,
      variantCounts,
      singleAreaSources: baseLabels.filter(
        (label) => label.selectedAreaIds.length === 1,
      ).length,
      multiAreaSources: baseLabels.filter(
        (label) => label.selectedAreaIds.length === 2,
      ).length,
      areaCounts,
      longContextCoverage: longContextCoverage(
        derivedEpisodes,
        provenance,
      ),
      runtimeLeakagePolicy: {
        actualChangedPathsIncluded: false,
        selectedAreaIdsIncluded: false,
        labelsIncluded: false,
      },
      reportingPolicy: {
        combineWithRealHeadline: false,
        inheritedLabelsAreIndependentSilverLabels: false,
        selectProductConfigurationFromThisSuiteAlone: false,
      },
      warnings: [
        "GitHub PR titles are coding-heavy but are not production-like Codex conversations.",
        "Base assignments use post-task changed-path heuristics and are not independent Sol silver labels.",
        "Derived labels are inherited by construction; all source variants must remain in one lineage cluster and may not be counted as independent cases.",
      ],
    },
  };
};

/**
 * Builds the context-budget development suite from an exact independent Sol
 * label join. Unlike the legacy changed-path stress path, this function never
 * requires or reads post-task paths or heuristic assignments. Runtime context
 * construction accepts only the source episode; labels are copied afterward.
 */
export const buildLunaGroundedCodingSilverDevelopmentSuite = (input: {
  episodes: readonly TaskEpisode[];
  labels: readonly SilverLabelV1[];
  cards: readonly AreaCardV1[];
}): LunaGroundedCodingSilverDevelopmentSuite => {
  const source = [...input.episodes]
    .filter((episode) => episode.split === "validation")
    .sort(
      (left, right) =>
        left.timestamp.localeCompare(right.timestamp) ||
        lexicalCompare(left.id, right.id),
    );
  if (!source.length) {
    throw new Error(
      "Grounded Sol coding development requires validation episodes",
    );
  }
  const sourceById = new Map<string, TaskEpisode>();
  for (const episode of source) {
    if (sourceById.has(episode.id)) {
      throw new Error(`Duplicate Sol coding source episode: ${episode.id}`);
    }
    if (episode.source !== "github") {
      throw new Error(
        `Grounded Sol coding source is not GitHub-derived: ${episode.id}`,
      );
    }
    sourceById.set(episode.id, episode);
  }
  validateSilverLabels([...input.labels], [...input.cards]);
  const labelById = new Map<string, SilverLabelV1>();
  for (const label of input.labels) {
    if (labelById.has(label.taskEpisodeId)) {
      throw new Error(
        `Duplicate grounded Sol label: ${label.taskEpisodeId}`,
      );
    }
    if (!sourceById.has(label.taskEpisodeId)) {
      throw new Error(
        `Grounded Sol label has no source episode: ${label.taskEpisodeId}`,
      );
    }
    if (!label.oracle.adjudicated || !label.oracle.repositoryInspected) {
      throw new Error(
        `Grounded Sol source label is not independent repository-aware adjudicated silver: ${label.taskEpisodeId}`,
      );
    }
    labelById.set(label.taskEpisodeId, label);
  }
  const missingLabelIds = source
    .map((episode) => episode.id)
    .filter((id) => !labelById.has(id));
  if (missingLabelIds.length > 0) {
    throw new Error(
      `Grounded Sol exact join is missing labels: ${missingLabelIds.join(", ")}`,
    );
  }

  const baseEpisodes = source.map(runtimeBaseEpisode);
  const baseLabels = source.map((episode) =>
    silverBaseLabel(episode, labelById.get(episode.id)!)
  );
  const derivedEpisodes: TaskEpisodeV1[] = [];
  const derivedLabels: LunaGroundedCodingInheritedSilverLabel[] = [];
  const provenance: LunaGroundedCodingProvenance[] = [];
  for (
    const [sourceIndex, sourceEpisode] of source.entries()
  ) {
    const label = baseLabels[sourceIndex]!;
    for (const variantKind of LUNA_GROUNDED_CODING_VARIANT_KINDS) {
      const derivative = runtimeDerivative(sourceEpisode, variantKind);
      derivedEpisodes.push(derivative.episode);
      derivedLabels.push(
        inheritedSilverLabel(label, derivative.episode.id, variantKind),
      );
      provenance.push({
        schemaVersion: 1,
        specificationVersion:
          LUNA_GROUNDED_CODING_DEVELOPMENT_VERSION,
        derivativeEpisodeId: derivative.episode.id,
        sourceEpisodeId: sourceEpisode.id,
        sourceSessionHash: sourceEpisode.sessionHash,
        sourceLineageHash: sourceEpisode.lineageHash,
        derivativeSessionHash: derivative.episode.sessionHash,
        derivativeLineageHash: derivative.episode.lineageHash,
        variantKind,
        construction: derivative.construction,
        sourceActualChangedPathsUsedInRuntimeConstruction: false,
        areaAssignmentUsedInRuntimeConstruction: false,
        labelPolicy:
          "inherited_sol_silver_label_preserving_not_independent",
      });
    }
  }
  validateEpisodes([...baseEpisodes, ...derivedEpisodes], [...input.cards]);
  assertRuntimeHasNoLabelEvidence(baseEpisodes, derivedEpisodes);

  const areaCounts: Record<string, number> = {};
  const unknownSubtypeCounts: Record<string, number> = {};
  for (const label of baseLabels) {
    for (const areaId of label.selectedAreaIds) {
      areaCounts[areaId] = (areaCounts[areaId] ?? 0) + 1;
    }
    if (!label.known) {
      const subtype = label.unknownType!;
      unknownSubtypeCounts[subtype] =
        (unknownSubtypeCounts[subtype] ?? 0) + 1;
    }
  }
  return {
    schemaVersion: 1,
    specificationVersion:
      LUNA_GROUNDED_CODING_DEVELOPMENT_VERSION,
    baseEpisodes,
    baseLabels,
    derivedEpisodes,
    derivedLabels,
    provenance,
    report: {
      schemaVersion: 1,
      role: "coding_heavy_sol_silver_development_not_headline_validation",
      sourceValidationEpisodes: source.length,
      exactBaseEpisodes: baseEpisodes.length,
      derivedEpisodes: derivedEpisodes.length,
      variantsPerSource: LUNA_GROUNDED_CODING_VARIANT_KINDS.length,
      variantCounts: variantCountsFromProvenance(provenance),
      knownSources: baseLabels.filter((label) => label.known).length,
      unknownSources: baseLabels.filter((label) => !label.known).length,
      unknownSubtypeCounts,
      singleAreaSources: baseLabels.filter(
        (label) => label.selectedAreaIds.length === 1,
      ).length,
      multiAreaSources: baseLabels.filter(
        (label) => label.selectedAreaIds.length === 2,
      ).length,
      areaCounts,
      longContextCoverage: longContextCoverage(
        derivedEpisodes,
        provenance,
      ),
      sourceLabelPolicy:
        "independent_repository_aware_sol_silver_exact_join",
      derivativeLabelPolicy:
        "inherited_label_preserving_not_independent_evidence",
      runtimeLeakagePolicy: {
        actualChangedPathsIncluded: false,
        selectedAreaIdsIncluded: false,
        labelsIncluded: false,
        sourceLabelsUsedToConstructRuntimeContext: false,
      },
      reportingPolicy: {
        combineWithRealHeadline: false,
        derivativeLabelsAreIndependentSilverLabels: false,
        clusterDerivativesWithSource: true,
      },
      warnings: [
        "GitHub PR tasks are coding-heavy but shorter than production Codex conversations.",
        "Base labels are independent repository-aware Sol silver evidence; derivative labels inherit those decisions and are not additional independent evidence.",
        "Known and unknown base decisions are preserved exactly. Every source and derivative must remain in one lineage cluster.",
      ],
    },
  };
};
