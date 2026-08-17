import { calculateExtendedMetrics } from "./experiment-metrics.ts";
import type {
  LunaAreaContextMode,
  LunaDecisionMode,
  LunaOutputMode,
  LunaPromptOrder,
  LunaReasoningEffort,
  LunaTaskContextMode,
} from "./luna-context.ts";
import type {
  ClassifierPredictionV1,
  SilverLabelV1,
} from "./types.ts";

export type LunaTaskKind =
  | "repository_task"
  | "outside_scope"
  | "insufficient_information";

export interface LunaTaskKindPredictionV1 {
  schemaVersion: 1;
  taskEpisodeId: string;
  classifier: string;
  taskKind: LunaTaskKind;
  confidence: number;
  durationMs: number;
  inputCharacters?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  costUsd?: number;
}

export interface LunaCascadeVariant {
  id: string;
  gateTaskContext: LunaTaskContextMode;
  gateReasoningEffort: LunaReasoningEffort;
  gateMaxOutputTokens: number;
  areaTaskContext: LunaTaskContextMode;
  areaContext: LunaAreaContextMode;
  areaPromptOrder: LunaPromptOrder;
  areaDecisionMode: LunaDecisionMode;
  areaOutputMode: LunaOutputMode;
  areaReasoningEffort: LunaReasoningEffort;
  areaMaxOutputTokens: number;
}

export interface LunaCascadeMatrix {
  schemaVersion: 1;
  description?: string;
  variants: LunaCascadeVariant[];
}

const safeVariantId = /^[a-z0-9][a-z0-9_-]{0,79}$/u;

export const validateLunaCascadeMatrix = (
  matrix: LunaCascadeMatrix,
): void => {
  if (matrix.schemaVersion !== 1) {
    throw new Error("Unsupported Luna cascade matrix schema");
  }
  if (!matrix.variants.length) {
    throw new Error("Luna cascade matrix must contain at least one variant");
  }
  const seen = new Set<string>();
  const assertOneOf = (
    value: string,
    values: readonly string[],
    field: string,
    id: string,
  ): void => {
    if (!values.includes(value)) {
      throw new Error(`Invalid ${field} for Luna cascade ${id}: ${value}`);
    }
  };
  for (const variant of matrix.variants) {
    if (!safeVariantId.test(variant.id)) {
      throw new Error(`Invalid Luna cascade variant ID: ${variant.id}`);
    }
    if (seen.has(variant.id)) {
      throw new Error(`Duplicate Luna cascade variant ID: ${variant.id}`);
    }
    seen.add(variant.id);
    assertOneOf(
      variant.gateTaskContext,
      ["full", "balanced", "compact"],
      "gateTaskContext",
      variant.id,
    );
    assertOneOf(
      variant.gateReasoningEffort,
      ["none", "low", "medium", "high"],
      "gateReasoningEffort",
      variant.id,
    );
    assertOneOf(
      variant.areaTaskContext,
      ["full", "balanced", "compact"],
      "areaTaskContext",
      variant.id,
    );
    assertOneOf(
      variant.areaContext,
      ["identity", "compact", "semantic", "full"],
      "areaContext",
      variant.id,
    );
    assertOneOf(
      variant.areaPromptOrder,
      ["registry_first", "task_first"],
      "areaPromptOrder",
      variant.id,
    );
    assertOneOf(
      variant.areaDecisionMode,
      ["direct", "gated", "novelty_strict"],
      "areaDecisionMode",
      variant.id,
    );
    assertOneOf(
      variant.areaOutputMode,
      ["minimal", "lean", "verbose"],
      "areaOutputMode",
      variant.id,
    );
    assertOneOf(
      variant.areaReasoningEffort,
      ["none", "low", "medium", "high"],
      "areaReasoningEffort",
      variant.id,
    );
    for (const [name, tokens] of [
      ["gateMaxOutputTokens", variant.gateMaxOutputTokens],
      ["areaMaxOutputTokens", variant.areaMaxOutputTokens],
    ] as const) {
      if (
        !Number.isInteger(tokens) ||
        tokens < 16 ||
        tokens > 1_024
      ) {
        throw new Error(`Invalid ${name} for Luna cascade ${variant.id}`);
      }
    }
  }
};

export const expectedLunaTaskKind = (
  label: SilverLabelV1,
): LunaTaskKind => {
  if (label.known || label.unknownType === "new_repository_area") {
    return "repository_task";
  }
  if (label.unknownType === "outside_scope") return "outside_scope";
  return "insufficient_information";
};

const summed = <K extends keyof LunaTaskKindPredictionV1>(
  left: LunaTaskKindPredictionV1,
  right: ClassifierPredictionV1,
  key: K,
): number | undefined => {
  const a = left[key];
  const b = right[key as keyof ClassifierPredictionV1];
  return typeof a === "number" && typeof b === "number"
    ? a + b
    : undefined;
};

export const combineLunaCascadePrediction = (
  gate: LunaTaskKindPredictionV1,
  area: ClassifierPredictionV1 | undefined,
  variantId: string,
): ClassifierPredictionV1 => {
  if (gate.taskKind !== "repository_task") {
    return {
      schemaVersion: 1,
      taskEpisodeId: gate.taskEpisodeId,
      classifier: `luna-cascade:${variantId}:gate`,
      areaScores: [],
      selectedAreaIds: [],
      known: false,
      unknownType: gate.taskKind,
      confidence: gate.confidence,
      abstentionReason: `task_kind_${gate.taskKind}`,
      durationMs: gate.durationMs,
      ...(gate.inputCharacters !== undefined
        ? { inputCharacters: gate.inputCharacters }
        : {}),
      ...(gate.inputTokens !== undefined
        ? { inputTokens: gate.inputTokens }
        : {}),
      ...(gate.cachedInputTokens !== undefined
        ? { cachedInputTokens: gate.cachedInputTokens }
        : {}),
      ...(gate.outputTokens !== undefined
        ? { outputTokens: gate.outputTokens }
        : {}),
      ...(gate.reasoningOutputTokens !== undefined
        ? { reasoningOutputTokens: gate.reasoningOutputTokens }
        : {}),
      ...(gate.costUsd !== undefined ? { costUsd: gate.costUsd } : {}),
    };
  }
  if (!area) {
    throw new Error(
      `Missing area prediction after repository-task gate for ${gate.taskEpisodeId}`,
    );
  }
  const inputCharacters = summed(gate, area, "inputCharacters");
  const inputTokens = summed(gate, area, "inputTokens");
  const cachedInputTokens = summed(gate, area, "cachedInputTokens");
  const outputTokens = summed(gate, area, "outputTokens");
  const reasoningOutputTokens = summed(
    gate,
    area,
    "reasoningOutputTokens",
  );
  const costUsd = summed(gate, area, "costUsd");
  return {
    ...area,
    classifier: `luna-cascade:${variantId}:${area.classifier}`,
    confidence: Math.min(gate.confidence, area.confidence),
    durationMs: gate.durationMs + area.durationMs,
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

export interface LunaTaskKindMetrics {
  count: number;
  correct: number;
  accuracy: number;
  actionableCases: number;
  predictedActionable: number;
  actionableTruePositive: number;
  actionablePrecision: number | null;
  actionableRecall: number | null;
  falseActionable: number;
  missedActionable: number;
  confusion: Record<LunaTaskKind, Record<LunaTaskKind, number>>;
}

export const calculateLunaTaskKindMetrics = (
  labels: SilverLabelV1[],
  predictions: LunaTaskKindPredictionV1[],
): LunaTaskKindMetrics => {
  const predictionById = new Map(
    predictions.map((prediction) => [
      prediction.taskEpisodeId,
      prediction,
    ]),
  );
  const kinds: LunaTaskKind[] = [
    "repository_task",
    "outside_scope",
    "insufficient_information",
  ];
  const confusion = Object.fromEntries(
    kinds.map((actual) => [
      actual,
      Object.fromEntries(kinds.map((predicted) => [predicted, 0])),
    ]),
  ) as Record<LunaTaskKind, Record<LunaTaskKind, number>>;
  let correct = 0;
  let actionableCases = 0;
  let predictedActionable = 0;
  let actionableTruePositive = 0;
  for (const label of labels) {
    const prediction = predictionById.get(label.taskEpisodeId);
    if (!prediction) {
      throw new Error(
        `Missing Luna task-kind prediction for ${label.taskEpisodeId}`,
      );
    }
    const actual = expectedLunaTaskKind(label);
    confusion[actual][prediction.taskKind] += 1;
    if (actual === prediction.taskKind) correct += 1;
    if (actual === "repository_task") actionableCases += 1;
    if (prediction.taskKind === "repository_task") {
      predictedActionable += 1;
      if (actual === "repository_task") actionableTruePositive += 1;
    }
  }
  return {
    count: labels.length,
    correct,
    accuracy: correct / Math.max(1, labels.length),
    actionableCases,
    predictedActionable,
    actionableTruePositive,
    actionablePrecision: predictedActionable
      ? actionableTruePositive / predictedActionable
      : null,
    actionableRecall: actionableCases
      ? actionableTruePositive / actionableCases
      : null,
    falseActionable: predictedActionable - actionableTruePositive,
    missedActionable: actionableCases - actionableTruePositive,
    confusion,
  };
};

export interface LunaCascadeVariantReport {
  variant: LunaCascadeVariant;
  gate: LunaTaskKindMetrics & {
    calls: number;
    latencyMs: { p50: number | null; p95: number | null };
    costUsd: { total: number | null; perCase: number | null };
  };
  areaCalls: number;
  final: ReturnType<typeof calculateExtendedMetrics>;
  projected: {
    costPer1kTasksUsd: number | null;
    p50SequentialLatencyMs: number | null;
    p95SequentialLatencyMs: number | null;
  };
}

const quantile = (
  values: number[],
  fraction: number,
): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) * fraction)] ?? null;
};

export const buildLunaCascadeVariantReport = (
  variant: LunaCascadeVariant,
  labels: SilverLabelV1[],
  gates: LunaTaskKindPredictionV1[],
  areas: ClassifierPredictionV1[],
  finalPredictions: ClassifierPredictionV1[],
): LunaCascadeVariantReport => {
  const gateMetrics = calculateLunaTaskKindMetrics(labels, gates);
  const gateCosts = gates
    .map((prediction) => prediction.costUsd)
    .filter((cost): cost is number => cost !== undefined);
  const final = calculateExtendedMetrics(labels, finalPredictions);
  return {
    variant,
    gate: {
      ...gateMetrics,
      calls: gates.length,
      latencyMs: {
        p50: quantile(
          gates.map((prediction) => prediction.durationMs),
          0.5,
        ),
        p95: quantile(
          gates.map((prediction) => prediction.durationMs),
          0.95,
        ),
      },
      costUsd: {
        total: gateCosts.length
          ? gateCosts.reduce((sum, cost) => sum + cost, 0)
          : null,
        perCase: gateCosts.length
          ? gateCosts.reduce((sum, cost) => sum + cost, 0) /
            gates.length
          : null,
      },
    },
    areaCalls: areas.length,
    final,
    projected: {
      costPer1kTasksUsd: final.costUsd.perCase === null
        ? null
        : final.costUsd.perCase * 1_000,
      p50SequentialLatencyMs: final.latencyMs.p50,
      p95SequentialLatencyMs: final.latencyMs.p95,
    },
  };
};
