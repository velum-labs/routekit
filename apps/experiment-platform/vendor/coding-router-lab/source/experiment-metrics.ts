import type { ClassifierPredictionV1, SilverLabelV1 } from "./types.ts";
import { calculateMetrics } from "./metrics.ts";
import { topTwoAreaIds } from "./metrics.ts";

const quantile = (values: number[], fraction: number): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * fraction)] ?? null;
};
const mean = (values: number[]): number | null =>
  values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
const jaccard = (left: readonly string[], right: readonly string[]): number => {
  const a = new Set(left), b = new Set(right);
  const intersection = [...a].filter((item) => b.has(item)).length;
  const union = new Set([...a, ...b]).size;
  return union ? intersection / union : 1;
};

export interface ExtendedMetrics {
  core: ReturnType<typeof calculateMetrics>;
  multiLabelJaccard: number;
  macroF1: number | null;
  unknownPrecision: number | null;
  unknownRecall: number | null;
  routingCoverage: number;
  correctnessAmongRouted: number | null;
  latencyMs: {
    mean: number | null;
    p50: number | null;
    p95: number | null;
    maximum: number | null;
  };
  costUsd: { total: number | null; perCase: number | null };
  usage: {
    inputCharacters: {
      total: number | null;
      perCase: number | null;
      p50: number | null;
      p95: number | null;
    };
    inputTokens: {
      total: number | null;
      perCase: number | null;
      p50: number | null;
      p95: number | null;
    };
    cachedInputTokens: {
      total: number | null;
      perCase: number | null;
      shareOfInput: number | null;
    };
    outputTokens: {
      total: number | null;
      perCase: number | null;
      p50: number | null;
      p95: number | null;
    };
    reasoningOutputTokens: {
      total: number | null;
      perCase: number | null;
    };
  };
  unknownType: {
    countWithType: number;
    exact: number;
    accuracy: number | null;
    confusion: Record<string, Record<string, number>>;
  };
  perArea: Record<string, { truePositive: number; falsePositive: number; falseNegative: number; precision: number | null; recall: number | null; f1: number | null }>;
}

export const calculateExtendedMetrics = (labels: SilverLabelV1[], predictions: ClassifierPredictionV1[]): ExtendedMetrics => {
  const byId = new Map(predictions.map((prediction) => [prediction.taskEpisodeId, prediction]));
  const areaIds = [...new Set([...labels.flatMap((label) => label.selectedAreaIds), ...predictions.flatMap((prediction) => prediction.selectedAreaIds)])].sort();
  const perArea: ExtendedMetrics["perArea"] = {};
  for (const areaId of areaIds) {
    let truePositive = 0, falsePositive = 0, falseNegative = 0;
    for (const label of labels) {
      const predicted = byId.get(label.taskEpisodeId); if (!predicted) throw new Error(`Missing prediction for ${label.taskEpisodeId}`);
      const actualHas = label.selectedAreaIds.includes(areaId), predictedHas = predicted.selectedAreaIds.includes(areaId);
      if (actualHas && predictedHas) truePositive += 1;
      else if (!actualHas && predictedHas) falsePositive += 1;
      else if (actualHas) falseNegative += 1;
    }
    const precision = truePositive + falsePositive ? truePositive / (truePositive + falsePositive) : null;
    const recall = truePositive + falseNegative ? truePositive / (truePositive + falseNegative) : null;
    const f1 = precision !== null && recall !== null && precision + recall > 0 ? 2 * precision * recall / (precision + recall) : null;
    perArea[areaId] = { truePositive, falsePositive, falseNegative, precision, recall, f1 };
  }
  let predictedUnknown = 0, trueUnknownPredicted = 0, actualUnknown = 0, routed = 0, routedCorrect = 0;
  let jaccardSum = 0;
  for (const label of labels) {
    const prediction = byId.get(label.taskEpisodeId); if (!prediction) throw new Error(`Missing prediction for ${label.taskEpisodeId}`);
    jaccardSum += jaccard(label.selectedAreaIds, prediction.selectedAreaIds);
    if (!prediction.known) { predictedUnknown += 1; if (!label.known) trueUnknownPredicted += 1; }
    if (!label.known) actualUnknown += 1;
    if (prediction.known) {
      routed += 1;
      if (label.known && label.selectedAreaIds.every((area) => prediction.selectedAreaIds.includes(area))) routedCorrect += 1;
    }
  }
  const costs = predictions.map((prediction) => prediction.costUsd).filter((value): value is number => value !== undefined);
  const totalCost = costs.length ? costs.reduce((sum, value) => sum + value, 0) : null;
  const usageValues = <K extends keyof ClassifierPredictionV1>(
    key: K,
  ): number[] => predictions
    .map((prediction) => prediction[key])
    .filter((entry): entry is ClassifierPredictionV1[K] & number =>
      typeof entry === "number" && Number.isFinite(entry)
    );
  const inputCharacters = usageValues("inputCharacters");
  const inputTokens = usageValues("inputTokens");
  const cachedInputTokens = usageValues("cachedInputTokens");
  const outputTokens = usageValues("outputTokens");
  const reasoningOutputTokens = usageValues("reasoningOutputTokens");
  const durationValues = predictions
    .map((prediction) => prediction.durationMs)
    .filter(Number.isFinite);
  const unknownConfusion: Record<string, Record<string, number>> = {};
  let unknownTypeCount = 0;
  let unknownTypeExact = 0;
  for (const label of labels) {
    if (label.known || !label.unknownType) continue;
    const prediction = byId.get(label.taskEpisodeId);
    if (!prediction) throw new Error(`Missing prediction for ${label.taskEpisodeId}`);
    const predictedType = prediction.known
      ? "predicted_known"
      : prediction.unknownType ?? "missing";
    unknownConfusion[label.unknownType] ??= {};
    unknownConfusion[label.unknownType]![predictedType] =
      (unknownConfusion[label.unknownType]![predictedType] ?? 0) + 1;
    unknownTypeCount += 1;
    if (!prediction.known && prediction.unknownType === label.unknownType) {
      unknownTypeExact += 1;
    }
  }
  const f1Values = Object.values(perArea).map((area) => area.f1).filter((value): value is number => value !== null);
  return {
    core: calculateMetrics(labels, predictions),
    multiLabelJaccard: jaccardSum / Math.max(1, labels.length),
    macroF1: f1Values.length ? f1Values.reduce((sum, value) => sum + value, 0) / f1Values.length : null,
    unknownPrecision: predictedUnknown ? trueUnknownPredicted / predictedUnknown : null,
    unknownRecall: actualUnknown ? trueUnknownPredicted / actualUnknown : null,
    routingCoverage: routed / Math.max(1, labels.length),
    correctnessAmongRouted: routed ? routedCorrect / routed : null,
    latencyMs: {
      mean: mean(durationValues),
      p50: quantile(durationValues, 0.5),
      p95: quantile(durationValues, 0.95),
      maximum: durationValues.length ? Math.max(...durationValues) : null,
    },
    costUsd: { total: totalCost, perCase: totalCost !== null ? totalCost / Math.max(1, predictions.length) : null },
    usage: {
      inputCharacters: {
        total: inputCharacters.length
          ? inputCharacters.reduce((sum, entry) => sum + entry, 0)
          : null,
        perCase: mean(inputCharacters),
        p50: quantile(inputCharacters, 0.5),
        p95: quantile(inputCharacters, 0.95),
      },
      inputTokens: {
        total: inputTokens.length
          ? inputTokens.reduce((sum, entry) => sum + entry, 0)
          : null,
        perCase: mean(inputTokens),
        p50: quantile(inputTokens, 0.5),
        p95: quantile(inputTokens, 0.95),
      },
      cachedInputTokens: {
        total: cachedInputTokens.length
          ? cachedInputTokens.reduce((sum, entry) => sum + entry, 0)
          : null,
        perCase: mean(cachedInputTokens),
        shareOfInput: cachedInputTokens.length && inputTokens.length
          ? cachedInputTokens.reduce((sum, entry) => sum + entry, 0) /
            Math.max(1, inputTokens.reduce((sum, entry) => sum + entry, 0))
          : null,
      },
      outputTokens: {
        total: outputTokens.length
          ? outputTokens.reduce((sum, entry) => sum + entry, 0)
          : null,
        perCase: mean(outputTokens),
        p50: quantile(outputTokens, 0.5),
        p95: quantile(outputTokens, 0.95),
      },
      reasoningOutputTokens: {
        total: reasoningOutputTokens.length
          ? reasoningOutputTokens.reduce((sum, entry) => sum + entry, 0)
          : null,
        perCase: mean(reasoningOutputTokens),
      },
    },
    unknownType: {
      countWithType: unknownTypeCount,
      exact: unknownTypeExact,
      accuracy: unknownTypeCount
        ? unknownTypeExact / unknownTypeCount
        : null,
      confusion: unknownConfusion,
    },
    perArea,
  };
};

export const pairedBootstrapDifference = (
  labels: SilverLabelV1[],
  left: ClassifierPredictionV1[],
  right: ClassifierPredictionV1[],
  iterations = 2_000,
  seed = 17,
): {
  metric: "safe_top_two_case_score";
  meanDifference: number;
  lower95: number;
  upper95: number;
  iterations: number;
  seed: number;
} => {
  if (!Number.isInteger(iterations) || iterations < 100) throw new Error("Bootstrap iterations must be at least 100");
  const leftById = new Map(left.map((item) => [item.taskEpisodeId, item])), rightById = new Map(right.map((item) => [item.taskEpisodeId, item]));
  const differences = labels.map((label) => {
    const a = leftById.get(label.taskEpisodeId), b = rightById.get(label.taskEpisodeId);
    if (!a || !b) throw new Error(`Missing paired prediction for ${label.taskEpisodeId}`);
    const score = (prediction: ClassifierPredictionV1): number => {
      if (!label.known) return prediction.known ? 0 : 1;
      const topTwo = topTwoAreaIds(prediction);
      return label.selectedAreaIds.filter((area) => topTwo.includes(area)).length /
        Math.max(1, label.selectedAreaIds.length);
    };
    return score(a) - score(b);
  });
  let state = seed >>> 0;
  const random = (): number => { state = (1664525 * state + 1013904223) >>> 0; return state / 2 ** 32; };
  const estimates: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let total = 0;
    for (let index = 0; index < differences.length; index += 1) total += differences[Math.floor(random() * differences.length)] ?? 0;
    estimates.push(total / Math.max(1, differences.length));
  }
  estimates.sort((a, b) => a - b);
  return {
    metric: "safe_top_two_case_score",
    meanDifference: differences.reduce((sum, value) => sum + value, 0) / Math.max(1, differences.length),
    lower95: estimates[Math.floor(iterations * 0.025)] ?? 0, upper95: estimates[Math.floor(iterations * 0.975)] ?? 0,
    iterations, seed,
  };
};
