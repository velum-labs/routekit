import {
  CompositionPrediction as CompositionPredictionSchema,
  type CompositionPrediction
} from "@velum-labs/routekit-eval-contracts";
import { Schema } from "effect";

import type { ProportionMetric } from "./classification-metrics.js";

export type CompositionEvaluationRole = "composition_reference" | "composition_candidate";

export type CompositionEvaluationEntry = {
  comparisonGroup?: string;
  treatmentId: string;
  taskId: string;
  seed: number;
  evaluationRole: CompositionEvaluationRole;
  prediction?: CompositionPrediction;
  latencyMs: number;
  providerCostUsd: number;
  infrastructureCostUsd: number;
};

export type CompositionPredictionDefaults = Pick<
  CompositionPrediction,
  "latencyMs" | "providerCostUsd" | "infrastructureCostUsd" | "provenance"
>;

export type CompositionReferenceMetrics = {
  treatmentId: string;
  attempts: number;
  validPredictions: number;
  contractValidity: ProportionMetric;
  medianLatencyMs: number;
  providerCostUsd: number;
  infrastructureCostUsd: number;
};

export type CompositionTreatmentMetrics = {
  treatmentId: string;
  attempts: number;
  validPredictions: number;
  contractValidity: ProportionMetric;
  pairedPredictions: number;
  meanCosineSimilarity?: number;
  meanAllAreaAbsoluteError?: number;
  meanActiveAreaAbsoluteError?: number;
  meanInactiveAreaAbsoluteError?: number;
  activeAreaPrecision?: number;
  activeAreaRecall?: number;
  activeAreaF1?: number;
  topAreaAgreement?: ProportionMetric;
  meanTopTwoOverlap?: number;
  allActiveAreasAt3?: ProportionMetric;
  meanUnknownAbsoluteError?: number;
  unknownAgreementAtPointThree?: ProportionMetric;
  unknownAgreementAtPointFive?: ProportionMetric;
  unknownAgreementAtPointSeven?: ProportionMetric;
  medianLatencyMs: number;
  providerCostUsd: number;
  infrastructureCostUsd: number;
};

export type CompositionEvaluationMetrics = {
  activeAreaThreshold: number;
  reference?: CompositionReferenceMetrics;
  treatments: CompositionTreatmentMetrics[];
};

export type GroupedCompositionEvaluationMetrics = {
  comparisonGroup: string;
  metrics: CompositionEvaluationMetrics;
};

const probabilityInRange = (value: number): boolean =>
  Number.isFinite(value) && value >= 0 && value <= 1;

function normalizeCompositionPrediction(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const object = value as Record<string, unknown>;
  if (object.areaCompositionScores !== undefined || object.unknownProbability !== undefined) {
    return value;
  }
  const rawScores = object.area_composition_scores;
  const unknownProbability = object.unknown_probability;
  if (
    typeof rawScores !== "object" ||
    rawScores === null ||
    Array.isArray(rawScores) ||
    typeof unknownProbability !== "number"
  ) {
    return value;
  }
  return {
    areaCompositionScores: rawScores,
    unknownProbability
  };
}

function decodePrediction(
  value: unknown,
  defaults: CompositionPredictionDefaults | undefined
): CompositionPrediction | undefined {
  try {
    const normalized = normalizeCompositionPrediction(value);
    if (typeof normalized !== "object" || normalized === null || Array.isArray(normalized)) {
      return undefined;
    }
    const object = normalized as Record<string, unknown>;
    const provenance =
      defaults !== undefined &&
      typeof object.provenance === "object" &&
      object.provenance !== null &&
      !Array.isArray(object.provenance)
        ? { ...defaults.provenance, ...(object.provenance as Record<string, unknown>) }
        : defaults?.provenance;
    const decoded = Schema.decodeUnknownSync(CompositionPredictionSchema)(
      defaults === undefined
        ? object
        : {
            ...object,
            latencyMs: object.latencyMs ?? defaults.latencyMs,
            providerCostUsd: object.providerCostUsd ?? defaults.providerCostUsd,
            infrastructureCostUsd: object.infrastructureCostUsd ?? defaults.infrastructureCostUsd,
            provenance
          }
    );
    const scores = Object.values(decoded.areaCompositionScores);
    if (
      scores.length === 0 ||
      !scores.every(probabilityInRange) ||
      !probabilityInRange(decoded.unknownProbability) ||
      decoded.latencyMs < 0 ||
      decoded.providerCostUsd < 0 ||
      decoded.infrastructureCostUsd < 0
    ) {
      return undefined;
    }
    return decoded;
  } catch {
    return undefined;
  }
}

function parseJsonContent(value: unknown): unknown {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  const fenced = trimmed.length >= 6 && trimmed.startsWith("```") && trimmed.endsWith("```");
  const bodyStart = fenced && trimmed.slice(3, 7).toLowerCase() === "json" ? 7 : 3;
  const candidate = fenced ? trimmed.slice(bodyStart, -3).trim() : trimmed;
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    return undefined;
  }
}

function openAiResponseContent(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const object = value as Record<string, unknown>;
  const response =
    typeof object.response === "object" &&
    object.response !== null &&
    !Array.isArray(object.response)
      ? (object.response as Record<string, unknown>)
      : object;
  const choices = response.choices;
  if (!Array.isArray(choices)) return undefined;
  const first = choices[0];
  if (typeof first !== "object" || first === null || Array.isArray(first)) return undefined;
  const message = (first as Record<string, unknown>).message;
  if (typeof message !== "object" || message === null || Array.isArray(message)) return undefined;
  const content = (message as Record<string, unknown>).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  return content
    .flatMap((part) => {
      if (typeof part !== "object" || part === null || Array.isArray(part)) return [];
      const text = (part as Record<string, unknown>).text;
      return typeof text === "string" ? [text] : [];
    })
    .join("");
}

export function extractCompositionPrediction(
  value: unknown,
  defaults?: CompositionPredictionDefaults,
  maximumDepth = 4
): CompositionPrediction | undefined {
  const visit = (candidate: unknown, depth: number): CompositionPrediction | undefined => {
    const direct = decodePrediction(candidate, defaults);
    if (direct !== undefined || depth >= maximumDepth) return direct;

    if (typeof candidate === "string") {
      const parsed = parseJsonContent(candidate);
      return parsed === undefined ? undefined : visit(parsed, depth + 1);
    }
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      return undefined;
    }

    const object = candidate as Record<string, unknown>;
    for (const key of ["compositionPrediction", "prediction", "result", "output"] as const) {
      if (object[key] === undefined) continue;
      const nested = visit(object[key], depth + 1);
      if (nested !== undefined) return nested;
    }

    const content = openAiResponseContent(object);
    if (content === undefined) return undefined;
    const parsed = parseJsonContent(content);
    return parsed === undefined ? undefined : visit(parsed, depth + 1);
  };

  return visit(value, 0);
}

function wilson(correct: number, total: number): ProportionMetric {
  if (total === 0) {
    return { correct, total, rate: 0, confidence95Low: 0, confidence95High: 0 };
  }
  const z = 1.959963984540054;
  const rate = correct / total;
  const denominator = 1 + (z * z) / total;
  const center = (rate + (z * z) / (2 * total)) / denominator;
  const margin =
    (z * Math.sqrt((rate * (1 - rate)) / total + (z * z) / (4 * total * total))) / denominator;
  return {
    correct,
    total,
    rate,
    confidence95Low: Math.max(0, center - margin),
    confidence95High: Math.min(1, center + margin)
  };
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function mean(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function keyFor(entry: Pick<CompositionEvaluationEntry, "taskId" | "seed">): string {
  return `${entry.taskId}\u0000${entry.seed}`;
}

function rankedAreas(scores: Readonly<Record<string, number>>): string[] {
  return Object.entries(scores)
    .sort(([leftId, left], [rightId, right]) => right - left || leftId.localeCompare(rightId))
    .map(([areaId]) => areaId);
}

function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  let dot = 0;
  let leftSquared = 0;
  let rightSquared = 0;
  for (const [index, leftValue] of left.entries()) {
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftSquared += leftValue * leftValue;
    rightSquared += rightValue * rightValue;
  }
  if (leftSquared === 0 && rightSquared === 0) return 1;
  if (leftSquared === 0 || rightSquared === 0) return 0;
  return dot / Math.sqrt(leftSquared * rightSquared);
}

function percentage(metric: ProportionMetric | undefined): string {
  if (metric === undefined) return "n/a";
  return `${(metric.rate * 100).toFixed(1)}% (${(metric.confidence95Low * 100).toFixed(
    1
  )}–${(metric.confidence95High * 100).toFixed(1)}%)`;
}

export function evaluateCompositionPredictions(
  entries: readonly CompositionEvaluationEntry[],
  activeAreaThreshold = 0.25
): CompositionEvaluationMetrics {
  if (!probabilityInRange(activeAreaThreshold)) {
    throw new Error("active area threshold must be in [0, 1]");
  }
  const references = entries.filter((entry) => entry.evaluationRole === "composition_reference");
  const referenceTreatmentIds = [...new Set(references.map((entry) => entry.treatmentId))];
  if (referenceTreatmentIds.length > 1) {
    throw new Error("composition evaluation requires exactly one reference treatment");
  }
  const referenceByKey = new Map<string, CompositionEvaluationEntry>();
  for (const entry of references) {
    const key = keyFor(entry);
    if (referenceByKey.has(key)) {
      throw new Error(`duplicate composition reference for ${entry.taskId} seed ${entry.seed}`);
    }
    referenceByKey.set(key, entry);
  }
  const referenceTreatmentId = referenceTreatmentIds[0];
  const reference =
    referenceTreatmentId === undefined
      ? undefined
      : {
          treatmentId: referenceTreatmentId,
          attempts: references.length,
          validPredictions: references.filter((entry) => entry.prediction !== undefined).length,
          contractValidity: wilson(
            references.filter((entry) => entry.prediction !== undefined).length,
            references.length
          ),
          medianLatencyMs: median(references.map((entry) => entry.latencyMs)),
          providerCostUsd: references.reduce((sum, entry) => sum + entry.providerCostUsd, 0),
          infrastructureCostUsd: references.reduce(
            (sum, entry) => sum + entry.infrastructureCostUsd,
            0
          )
        };

  const grouped = new Map<string, CompositionEvaluationEntry[]>();
  for (const entry of entries) {
    if (entry.evaluationRole !== "composition_candidate") continue;
    const current = grouped.get(entry.treatmentId) ?? [];
    current.push(entry);
    grouped.set(entry.treatmentId, current);
  }

  const treatments = [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([treatmentId, attempts]): CompositionTreatmentMetrics => {
      const valid = attempts.filter(
        (entry): entry is CompositionEvaluationEntry & { prediction: CompositionPrediction } =>
          entry.prediction !== undefined
      );
      const pairs = valid.flatMap((candidate) => {
        const referenceEntry = referenceByKey.get(keyFor(candidate));
        if (referenceEntry?.prediction === undefined) return [];
        return [{ candidate, reference: referenceEntry.prediction }];
      });
      const cosine: number[] = [];
      const allErrors: number[] = [];
      const activeErrors: number[] = [];
      const inactiveErrors: number[] = [];
      const unknownErrors: number[] = [];
      const topAgreement: boolean[] = [];
      const topTwoOverlap: number[] = [];
      const allActiveAt3: boolean[] = [];
      const unknownThresholdAgreement = new Map<number, boolean[]>([
        [0.3, []],
        [0.5, []],
        [0.7, []]
      ]);
      let truePositive = 0;
      let falsePositive = 0;
      let falseNegative = 0;

      for (const pair of pairs) {
        const candidateScores = pair.candidate.prediction.areaCompositionScores;
        const referenceScores = pair.reference.areaCompositionScores;
        const areaIds = [
          ...new Set([...Object.keys(referenceScores), ...Object.keys(candidateScores)])
        ].sort();
        const candidateVector = areaIds.map((areaId) => candidateScores[areaId] ?? 0);
        const referenceVector = areaIds.map((areaId) => referenceScores[areaId] ?? 0);
        cosine.push(cosineSimilarity(candidateVector, referenceVector));
        const activeAreas = new Set(
          areaIds.filter((areaId) => (referenceScores[areaId] ?? 0) >= activeAreaThreshold)
        );
        const candidateActiveAreas = new Set(
          areaIds.filter((areaId) => (candidateScores[areaId] ?? 0) >= activeAreaThreshold)
        );
        for (const areaId of areaIds) {
          const error = Math.abs((candidateScores[areaId] ?? 0) - (referenceScores[areaId] ?? 0));
          allErrors.push(error);
          if (activeAreas.has(areaId)) activeErrors.push(error);
          else inactiveErrors.push(error);
          if (activeAreas.has(areaId) && candidateActiveAreas.has(areaId)) truePositive += 1;
          else if (!activeAreas.has(areaId) && candidateActiveAreas.has(areaId)) falsePositive += 1;
          else if (activeAreas.has(areaId)) falseNegative += 1;
        }
        const candidateRanked = rankedAreas(candidateScores);
        const referenceRanked = rankedAreas(referenceScores);
        if (activeAreas.size > 0) {
          topAgreement.push(candidateRanked[0] === referenceRanked[0]);
          const topTwoReference = new Set(referenceRanked.slice(0, 2));
          const overlap = candidateRanked
            .slice(0, 2)
            .filter((areaId) => topTwoReference.has(areaId)).length;
          topTwoOverlap.push(overlap / Math.min(2, areaIds.length));
          const candidateTopThree = new Set(candidateRanked.slice(0, 3));
          allActiveAt3.push([...activeAreas].every((areaId) => candidateTopThree.has(areaId)));
        }
        unknownErrors.push(
          Math.abs(pair.candidate.prediction.unknownProbability - pair.reference.unknownProbability)
        );
        for (const [threshold, agreements] of unknownThresholdAgreement) {
          agreements.push(
            pair.candidate.prediction.unknownProbability >= threshold ===
              pair.reference.unknownProbability >= threshold
          );
        }
      }

      const precision =
        truePositive + falsePositive === 0 ? 0 : truePositive / (truePositive + falsePositive);
      const recall =
        truePositive + falseNegative === 0 ? 0 : truePositive / (truePositive + falseNegative);
      const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
      const agreementMetric = (values: readonly boolean[]): ProportionMetric =>
        wilson(values.filter(Boolean).length, values.length);

      return {
        treatmentId,
        attempts: attempts.length,
        validPredictions: valid.length,
        contractValidity: wilson(valid.length, attempts.length),
        pairedPredictions: pairs.length,
        meanCosineSimilarity: mean(cosine),
        meanAllAreaAbsoluteError: mean(allErrors),
        meanActiveAreaAbsoluteError: mean(activeErrors),
        meanInactiveAreaAbsoluteError: mean(inactiveErrors),
        activeAreaPrecision: pairs.length === 0 ? undefined : precision,
        activeAreaRecall: pairs.length === 0 ? undefined : recall,
        activeAreaF1: pairs.length === 0 ? undefined : f1,
        topAreaAgreement: topAgreement.length === 0 ? undefined : agreementMetric(topAgreement),
        meanTopTwoOverlap: mean(topTwoOverlap),
        allActiveAreasAt3: allActiveAt3.length === 0 ? undefined : agreementMetric(allActiveAt3),
        meanUnknownAbsoluteError: mean(unknownErrors),
        unknownAgreementAtPointThree:
          pairs.length === 0
            ? undefined
            : agreementMetric(unknownThresholdAgreement.get(0.3) ?? []),
        unknownAgreementAtPointFive:
          pairs.length === 0
            ? undefined
            : agreementMetric(unknownThresholdAgreement.get(0.5) ?? []),
        unknownAgreementAtPointSeven:
          pairs.length === 0
            ? undefined
            : agreementMetric(unknownThresholdAgreement.get(0.7) ?? []),
        medianLatencyMs: median(attempts.map((entry) => entry.latencyMs)),
        providerCostUsd: attempts.reduce((sum, entry) => sum + entry.providerCostUsd, 0),
        infrastructureCostUsd: attempts.reduce((sum, entry) => sum + entry.infrastructureCostUsd, 0)
      };
    });

  return { activeAreaThreshold, reference, treatments };
}

export function evaluateGroupedCompositionPredictions(
  entries: readonly CompositionEvaluationEntry[],
  activeAreaThreshold = 0.25
): GroupedCompositionEvaluationMetrics[] {
  const grouped = new Map<string, CompositionEvaluationEntry[]>();
  for (const entry of entries) {
    const comparisonGroup = entry.comparisonGroup ?? "default";
    const current = grouped.get(comparisonGroup) ?? [];
    current.push(entry);
    grouped.set(comparisonGroup, current);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([comparisonGroup, groupEntries]) => ({
      comparisonGroup,
      metrics: evaluateCompositionPredictions(groupEntries, activeAreaThreshold)
    }));
}

const decimal = (value: number | undefined): string =>
  value === undefined ? "n/a" : value.toFixed(4);

export function renderCompositionMetrics(metrics: CompositionEvaluationMetrics): string {
  if (metrics.reference === undefined && metrics.treatments.length === 0) {
    return "## Composition metrics\n\nNo composition predictions were available.\n";
  }
  const lines = [
    "## Composition metrics",
    "",
    `Candidate vectors are compared with the reference treatment. An area is active when the reference score is at least ${metrics.activeAreaThreshold.toFixed(
      2
    )}. Higher cosine/F1/agreement values are better; lower MAE values are better.`,
    ""
  ];
  if (metrics.reference !== undefined) {
    lines.push(
      `Reference: \`${metrics.reference.treatmentId}\` — ${metrics.reference.validPredictions}/${metrics.reference.attempts} valid (${percentage(
        metrics.reference.contractValidity
      )}), median latency ${metrics.reference.medianLatencyMs.toFixed(0)} ms, total cost $${(
        metrics.reference.providerCostUsd + metrics.reference.infrastructureCostUsd
      ).toFixed(4)}.`,
      ""
    );
  }
  if (metrics.treatments.length === 0) {
    lines.push("No candidate treatments were available.", "");
    return lines.join("\n");
  }
  lines.push(
    "| Treatment | Valid contract | Pairs | Cosine | All-area MAE | Active MAE | Inactive MAE | Active F1 | Top area | Top-2 overlap | All active @3 | Unknown MAE | Unknown @0.5 | Median latency | Total cost |",
    "| -- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: |",
    ...metrics.treatments.map(
      (entry) =>
        `| ${entry.treatmentId} | ${entry.validPredictions}/${entry.attempts} (${percentage(
          entry.contractValidity
        )}) | ${entry.pairedPredictions} | ${decimal(
          entry.meanCosineSimilarity
        )} | ${decimal(entry.meanAllAreaAbsoluteError)} | ${decimal(
          entry.meanActiveAreaAbsoluteError
        )} | ${decimal(entry.meanInactiveAreaAbsoluteError)} | ${decimal(
          entry.activeAreaF1
        )} | ${percentage(entry.topAreaAgreement)} | ${decimal(
          entry.meanTopTwoOverlap
        )} | ${percentage(entry.allActiveAreasAt3)} | ${decimal(
          entry.meanUnknownAbsoluteError
        )} | ${percentage(entry.unknownAgreementAtPointFive)} | ${entry.medianLatencyMs.toFixed(
          0
        )} ms | $${(entry.providerCostUsd + entry.infrastructureCostUsd).toFixed(4)} |`
    ),
    ""
  );
  return lines.join("\n");
}

export function renderGroupedCompositionMetrics(
  groups: readonly GroupedCompositionEvaluationMetrics[]
): string {
  if (groups.length === 0) {
    return "## Composition metrics\n\nNo composition predictions were available.\n";
  }
  if (groups.length === 1 && groups[0]?.comparisonGroup === "default") {
    return renderCompositionMetrics(groups[0].metrics);
  }
  return [
    "## Grouped composition metrics",
    "",
    "Each comparison group has its own semantic Area Registry and exactly one reference treatment.",
    "",
    ...groups.flatMap((group) => [
      `### ${group.comparisonGroup}`,
      "",
      renderCompositionMetrics(group.metrics).replace(/^## Composition metrics\n\n/u, ""),
      ""
    ])
  ].join("\n");
}
