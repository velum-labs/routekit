import { contentHash } from "./hash.ts";
import type { TaskEpisode } from "./types.ts";

export const LUNA_ACCURACY_CODING_ANNOTATION_POLICY_VERSION =
  "coding-intent-v1" as const;

export const LUNA_ACCURACY_CODING_DECISIONS = [
  "coding",
  "noncoding",
  "excluded_ambiguous",
] as const;

export type LunaAccuracyCodingDecision =
  (typeof LUNA_ACCURACY_CODING_DECISIONS)[number];

export type LunaAccuracyCodingAnnotationMethod =
  | "manual_task_intent_review"
  | "github_change_request_source"
  | "inherited_label_preserving_derivative";

export interface LunaAccuracyCodingAnnotation {
  schemaVersion: 1;
  policyVersion: typeof LUNA_ACCURACY_CODING_ANNOTATION_POLICY_VERSION;
  taskEpisodeId: string;
  decision: LunaAccuracyCodingDecision;
  /**
   * Compatibility field consumed by the metric runner. Ambiguous cases are
   * false and must still be reported separately from noncoding cases.
   */
  coding: boolean;
  method: LunaAccuracyCodingAnnotationMethod;
  reviewer: string;
  rationale: string;
  sourceEpisodeId: string;
  inheritedFromEpisodeId?: string;
}

export interface LunaAccuracyCodingAnnotationDraft {
  taskEpisodeId: string;
  decision: LunaAccuracyCodingDecision;
  rationale: string;
}

export interface LunaAccuracyCodingAnnotationAudit {
  schemaVersion: 1;
  policyVersion: typeof LUNA_ACCURACY_CODING_ANNOTATION_POLICY_VERSION;
  role: "frozen_coding_intent_annotations";
  episodes: number;
  annotations: number;
  decisions: Record<LunaAccuracyCodingDecision, number>;
  methods: Record<LunaAccuracyCodingAnnotationMethod, number>;
  missingEpisodeIds: string[];
  unknownEpisodeIds: string[];
  duplicateEpisodeIds: string[];
  codingEpisodeIds: string[];
  excludedAmbiguousEpisodeIds: string[];
  episodeSetHash: string;
  annotationSetHash: string;
  ready: boolean;
  criteria: {
    coding: string;
    noncoding: string;
    excludedAmbiguous: string;
  };
  warning: string;
}

export interface LunaAccuracyCodingAnnotationSet {
  annotations: LunaAccuracyCodingAnnotation[];
  audit: LunaAccuracyCodingAnnotationAudit;
}

const lexicalCompare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const decisionCounts = (): Record<LunaAccuracyCodingDecision, number> => ({
  coding: 0,
  noncoding: 0,
  excluded_ambiguous: 0,
});

const methodCounts = (): Record<LunaAccuracyCodingAnnotationMethod, number> => ({
  manual_task_intent_review: 0,
  github_change_request_source: 0,
  inherited_label_preserving_derivative: 0,
});

const assertNonblank = (value: string, field: string): void => {
  if (!value.trim()) throw new Error(`${field} must not be blank`);
};

const validateAnnotationShape = (
  annotation: LunaAccuracyCodingAnnotation,
): void => {
  if (annotation.schemaVersion !== 1) {
    throw new Error(
      `Unsupported coding annotation schema: ${annotation.taskEpisodeId}`,
    );
  }
  if (
    annotation.policyVersion !==
      LUNA_ACCURACY_CODING_ANNOTATION_POLICY_VERSION
  ) {
    throw new Error(
      `Unsupported coding annotation policy: ${annotation.taskEpisodeId}`,
    );
  }
  if (!LUNA_ACCURACY_CODING_DECISIONS.includes(annotation.decision)) {
    throw new Error(
      `Invalid coding annotation decision: ${annotation.taskEpisodeId}`,
    );
  }
  if (annotation.coding !== (annotation.decision === "coding")) {
    throw new Error(
      `Coding boolean conflicts with decision: ${annotation.taskEpisodeId}`,
    );
  }
  if (!(annotation.method in methodCounts())) {
    throw new Error(
      `Invalid coding annotation method: ${annotation.taskEpisodeId}`,
    );
  }
  assertNonblank(annotation.taskEpisodeId, "taskEpisodeId");
  assertNonblank(annotation.reviewer, `${annotation.taskEpisodeId}.reviewer`);
  assertNonblank(annotation.rationale, `${annotation.taskEpisodeId}.rationale`);
  assertNonblank(
    annotation.sourceEpisodeId,
    `${annotation.taskEpisodeId}.sourceEpisodeId`,
  );
  if (
    annotation.method === "inherited_label_preserving_derivative" &&
    !annotation.inheritedFromEpisodeId
  ) {
    throw new Error(
      `Inherited coding annotation lacks source: ${annotation.taskEpisodeId}`,
    );
  }
  if (
    annotation.method !== "inherited_label_preserving_derivative" &&
    annotation.inheritedFromEpisodeId
  ) {
    throw new Error(
      `Non-inherited coding annotation names an inherited source: ${annotation.taskEpisodeId}`,
    );
  }
};

export const auditLunaAccuracyCodingAnnotations = (
  episodes: readonly TaskEpisode[],
  annotations: readonly LunaAccuracyCodingAnnotation[],
): LunaAccuracyCodingAnnotationAudit => {
  const episodeIds = new Set<string>();
  for (const episode of episodes) {
    if (episodeIds.has(episode.id)) {
      throw new Error(`Duplicate coding-annotation episode: ${episode.id}`);
    }
    episodeIds.add(episode.id);
  }

  const seen = new Set<string>();
  const duplicateEpisodeIds = new Set<string>();
  const unknownEpisodeIds = new Set<string>();
  const decisions = decisionCounts();
  const methods = methodCounts();
  for (const annotation of annotations) {
    validateAnnotationShape(annotation);
    if (seen.has(annotation.taskEpisodeId)) {
      duplicateEpisodeIds.add(annotation.taskEpisodeId);
      continue;
    }
    seen.add(annotation.taskEpisodeId);
    if (!episodeIds.has(annotation.taskEpisodeId)) {
      unknownEpisodeIds.add(annotation.taskEpisodeId);
      continue;
    }
    decisions[annotation.decision] += 1;
    methods[annotation.method] += 1;
  }

  const missingEpisodeIds = [...episodeIds]
    .filter((id) => !seen.has(id))
    .sort(lexicalCompare);
  const sortedAnnotations = [...annotations].sort((left, right) =>
    lexicalCompare(left.taskEpisodeId, right.taskEpisodeId)
  );
  const codingEpisodeIds = sortedAnnotations
    .filter(
      (annotation) =>
        episodeIds.has(annotation.taskEpisodeId) &&
        annotation.decision === "coding",
    )
    .map((annotation) => annotation.taskEpisodeId);
  const excludedAmbiguousEpisodeIds = sortedAnnotations
    .filter(
      (annotation) =>
        episodeIds.has(annotation.taskEpisodeId) &&
        annotation.decision === "excluded_ambiguous",
    )
    .map((annotation) => annotation.taskEpisodeId);
  const duplicate = [...duplicateEpisodeIds].sort(lexicalCompare);
  const unknown = [...unknownEpisodeIds].sort(lexicalCompare);
  const ready =
    annotations.length === episodes.length &&
    missingEpisodeIds.length === 0 &&
    unknown.length === 0 &&
    duplicate.length === 0;

  return {
    schemaVersion: 1,
    policyVersion: LUNA_ACCURACY_CODING_ANNOTATION_POLICY_VERSION,
    role: "frozen_coding_intent_annotations",
    episodes: episodes.length,
    annotations: annotations.length,
    decisions,
    methods,
    missingEpisodeIds,
    unknownEpisodeIds: unknown,
    duplicateEpisodeIds: duplicate,
    codingEpisodeIds,
    excludedAmbiguousEpisodeIds,
    episodeSetHash: contentHash(
      [...episodes]
        .sort((left, right) => lexicalCompare(left.id, right.id))
        .map((episode) => ({
          id: episode.id,
          repositoryId: episode.repositoryId,
          repositorySnapshot: episode.repositorySnapshot,
          sessionHash: episode.sessionHash,
          lineageHash: episode.lineageHash,
          currentRequest: episode.currentRequest,
          taskAnchor: episode.taskAnchor ?? null,
          precedingAssistant: episode.precedingAssistant ?? null,
          earlierUserContext: episode.earlierUserContext ?? [],
          relevantDiagnostic: episode.relevantDiagnostic ?? null,
        })),
    ),
    annotationSetHash: contentHash(sortedAnnotations),
    ready,
    criteria: {
      coding:
        "The visible task asks to implement, fix, refactor, debug, test, configure, or deploy software or repository artifacts.",
      noncoding:
        "The visible task asks for research, explanation, product design, marketing, general writing, or specification work without requesting a software or repository change.",
      excludedAmbiguous:
        "The visible task-aware context is insufficient to determine whether a software or repository change is requested.",
    },
    warning:
      "Coding intent is source-independent metadata. Do not derive it from the known/unknown area label or Luna output.",
  };
};

export const buildReviewedLunaAccuracyCodingAnnotations = (input: {
  episodes: readonly TaskEpisode[];
  drafts: readonly LunaAccuracyCodingAnnotationDraft[];
  reviewer: string;
}): LunaAccuracyCodingAnnotationSet => {
  assertNonblank(input.reviewer, "reviewer");
  const episodeIds = new Set(input.episodes.map((episode) => episode.id));
  const annotations: LunaAccuracyCodingAnnotation[] = input.drafts.map(
    (draft) => {
      if (!episodeIds.has(draft.taskEpisodeId)) {
        throw new Error(
          `Coding annotation draft has no episode: ${draft.taskEpisodeId}`,
        );
      }
      assertNonblank(draft.rationale, `${draft.taskEpisodeId}.rationale`);
      return {
        schemaVersion: 1,
        policyVersion: LUNA_ACCURACY_CODING_ANNOTATION_POLICY_VERSION,
        taskEpisodeId: draft.taskEpisodeId,
        decision: draft.decision,
        coding: draft.decision === "coding",
        method: "manual_task_intent_review",
        reviewer: input.reviewer,
        rationale: draft.rationale,
        sourceEpisodeId: draft.taskEpisodeId,
      };
    },
  );
  const audit = auditLunaAccuracyCodingAnnotations(
    input.episodes,
    annotations,
  );
  if (!audit.ready) {
    throw new Error(
      `Coding annotation set is incomplete: ${audit.missingEpisodeIds.join(", ")}`,
    );
  }
  return { annotations, audit };
};

/**
 * GitHub pull-request tasks are explicit repository change requests. This
 * source-derived annotation does not inspect changed paths or area labels.
 */
export const buildGithubLunaAccuracyCodingAnnotations = (input: {
  episodes: readonly TaskEpisode[];
  reviewer: string;
}): LunaAccuracyCodingAnnotationSet => {
  assertNonblank(input.reviewer, "reviewer");
  const annotations = input.episodes.map(
    (episode): LunaAccuracyCodingAnnotation => {
      if (episode.source !== "github") {
        throw new Error(
          `GitHub coding annotation source is not GitHub: ${episode.id}`,
        );
      }
      return {
        schemaVersion: 1,
        policyVersion: LUNA_ACCURACY_CODING_ANNOTATION_POLICY_VERSION,
        taskEpisodeId: episode.id,
        decision: "coding",
        coding: true,
        method: "github_change_request_source",
        reviewer: input.reviewer,
        rationale:
          "The source record is a merged GitHub pull-request task, which is an explicit repository change request.",
        sourceEpisodeId: episode.id,
      };
    },
  );
  const audit = auditLunaAccuracyCodingAnnotations(
    input.episodes,
    annotations,
  );
  if (!audit.ready) {
    throw new Error("GitHub coding annotation set failed its completeness audit");
  }
  return { annotations, audit };
};

export const inheritLunaAccuracyCodingAnnotations = (input: {
  sourceAnnotations: readonly LunaAccuracyCodingAnnotation[];
  derivedEpisodes: readonly TaskEpisode[];
  sourceEpisodeIdByDerivedId: ReadonlyMap<string, string>;
  reviewer: string;
}): LunaAccuracyCodingAnnotationSet => {
  assertNonblank(input.reviewer, "reviewer");
  const sourceById = new Map(
    input.sourceAnnotations.map((annotation) => [
      annotation.taskEpisodeId,
      annotation,
    ]),
  );
  const annotations = input.derivedEpisodes.map(
    (episode): LunaAccuracyCodingAnnotation => {
      const sourceEpisodeId = input.sourceEpisodeIdByDerivedId.get(episode.id);
      if (!sourceEpisodeId) {
        throw new Error(
          `Derived coding annotation has no provenance: ${episode.id}`,
        );
      }
      const source = sourceById.get(sourceEpisodeId);
      if (!source) {
        throw new Error(
          `Derived coding annotation has no source annotation: ${episode.id}`,
        );
      }
      return {
        schemaVersion: 1,
        policyVersion: LUNA_ACCURACY_CODING_ANNOTATION_POLICY_VERSION,
        taskEpisodeId: episode.id,
        decision: source.decision,
        coding: source.coding,
        method: "inherited_label_preserving_derivative",
        reviewer: input.reviewer,
        rationale:
          `Coding intent is inherited from ${sourceEpisodeId}; the derivative preserves the complete source objective by construction.`,
        sourceEpisodeId,
        inheritedFromEpisodeId: sourceEpisodeId,
      };
    },
  );
  const audit = auditLunaAccuracyCodingAnnotations(
    input.derivedEpisodes,
    annotations,
  );
  if (!audit.ready) {
    throw new Error(
      "Inherited coding annotation set failed its completeness audit",
    );
  }
  return { annotations, audit };
};

export const codingEpisodeIdsFromAnnotations = (
  episodes: readonly TaskEpisode[],
  annotations: readonly LunaAccuracyCodingAnnotation[],
): Set<string> => {
  const audit = auditLunaAccuracyCodingAnnotations(episodes, annotations);
  if (!audit.ready) {
    throw new Error(
      `Coding annotations are not ready: missing=${audit.missingEpisodeIds.length}, unknown=${audit.unknownEpisodeIds.length}, duplicate=${audit.duplicateEpisodeIds.length}`,
    );
  }
  return new Set(audit.codingEpisodeIds);
};
