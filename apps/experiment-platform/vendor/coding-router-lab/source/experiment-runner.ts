import { areaOverviewText } from "./area-text.ts";
import { applyThresholds, centroidScores, descriptionScores, exemplarScores, type AreaVectors } from "./classifiers.ts";
import { calculateExtendedMetrics } from "./experiment-metrics.ts";
import { serializeTaskEnvelope } from "./serialization.ts";
import type {
  AreaCardV1, ClassifierPredictionV1, DenseVector, RepositoryProfileV1, SilverLabelV1, TaskEpisode, ThresholdsV1,
} from "./types.ts";

export type ContextRepresentation = "task_aware_repo_profile";
export type EmbeddingMethod = "description" | "centroid" | "topk-1" | "topk-3" | "topk-5";
export const embeddingMethods: EmbeddingMethod[] = ["description", "centroid", "topk-1", "topk-3", "topk-5"];

export const serializeRepresentation = (
  episode: TaskEpisode,
  profile: RepositoryProfileV1,
  representation: ContextRepresentation,
): string => {
  if (representation !== "task_aware_repo_profile") {
    throw new Error(`Unsupported context representation: ${String(representation)}`);
  }
  return serializeTaskEnvelope(episode, profile).text;
};

export interface SavedVectorArtifact {
  schemaVersion: 1;
  embeddingModel: string;
  serializationVersion: string;
  taskVectors: Array<DenseVector & { representation: ContextRepresentation }>;
  overviewVectors: DenseVector[];
  exampleVectors: DenseVector[];
}

export const buildAreaVectors = (cards: AreaCardV1[], vectors: SavedVectorArtifact): AreaVectors[] => {
  const overview = new Map(vectors.overviewVectors.map((item) => [item.id, item]));
  const examples = new Map(vectors.exampleVectors.map((item) => [item.id, item]));
  return cards.map((card) => {
    const overviewVector = overview.get(`overview:${card.areaId}`);
    if (!overviewVector) throw new Error(`Missing overview vector for ${card.areaId}`);
    return {
      areaId: card.areaId, overview: overviewVector,
      examples: card.positiveExampleIds.map((id) => {
        const vector = examples.get(`example:${card.areaId}:${id}`);
        if (!vector) throw new Error(`Missing example vector for ${card.areaId}:${id}`);
        return vector;
      }),
    };
  });
};

export const buildHiddenAreaVectors = (
  cards: AreaCardV1[],
  vectors: SavedVectorArtifact,
): AreaVectors[] => {
  const allowedAreaIds = new Set(cards.map((card) => card.areaId));
  const hiddenVectors: SavedVectorArtifact = {
    ...vectors,
    overviewVectors: vectors.overviewVectors.filter((vector) => {
      const match = /^overview:(.+)$/u.exec(vector.id);
      return Boolean(match?.[1] && allowedAreaIds.has(match[1]));
    }),
    exampleVectors: vectors.exampleVectors.filter((vector) => {
      const match = /^example:([^:]+):/u.exec(vector.id);
      return Boolean(match?.[1] && allowedAreaIds.has(match[1]));
    }),
  };
  return buildAreaVectors(cards, hiddenVectors);
};

export const classifyEmbeddingMethod = (
  tasks: DenseVector[],
  areas: AreaVectors[],
  method: EmbeddingMethod,
  thresholds: ThresholdsV1,
): ClassifierPredictionV1[] => tasks.map((task) => {
  const started = performance.now();
  const scores = method === "description" ? descriptionScores(task, areas)
    : method === "centroid" ? centroidScores(task, areas)
      : exemplarScores(task, areas, Number(method.split("-")[1]));
  return applyThresholds(task.id, method, scores, thresholds, performance.now() - started);
});

export const classifyAllEmbeddingMethods = (
  tasks: DenseVector[],
  areas: AreaVectors[],
  thresholds: ThresholdsV1,
): Record<EmbeddingMethod, ClassifierPredictionV1[]> =>
  Object.fromEntries(embeddingMethods.map((method) => [method, classifyEmbeddingMethod(tasks, areas, method, thresholds)])) as Record<EmbeddingMethod, ClassifierPredictionV1[]>;

export interface ThresholdSearchResult {
  thresholds: ThresholdsV1;
  objective: { falseKnownRate: number | null; topTwoRecall: number; routingCoverage: number; exactLabelSetMatch: number };
  candidatesEvaluated: number;
  coverageCurve: Array<{
    falseKnownRate: number | null;
    falseUnknownRate: number | null;
    routingCoverage: number;
    correctnessAmongRouted: number | null;
    topTwoRecall: number;
    exactLabelSetMatch: number;
    thresholds: ThresholdsV1;
  }>;
}

export const tuneThresholds = (
  labels: SilverLabelV1[],
  rawPredictions: ClassifierPredictionV1[],
  maximumFalseKnownRate = 0.1,
): ThresholdSearchResult => {
  const scoreValues = [...new Set(rawPredictions.flatMap((prediction) =>
    prediction.areaScores.slice(0, 2).map((score) => Number(score.score.toFixed(4))),
  ))].sort((a, b) => a - b);
  const margins = [...new Set(rawPredictions.map((prediction) =>
    Number(((prediction.areaScores[0]?.score ?? -1) - (prediction.areaScores[1]?.score ?? -1)).toFixed(4)),
  ))].sort((a, b) => a - b);
  const topGrid = [-1, ...scoreValues], marginGrid = [0, ...margins], secondGrid = [...scoreValues];
  let best: ThresholdSearchResult | undefined;
  let candidatesEvaluated = 0;
  const curveByOutcome = new Map<
    string,
    ThresholdSearchResult["coverageCurve"][number]
  >();
  for (const minimumTopScore of topGrid) for (const minimumMargin of marginGrid) for (const minimumSecondScoreForMultiArea of secondGrid) {
    const thresholds: ThresholdsV1 = { minimumTopScore, minimumMargin, minimumSecondScoreForMultiArea, maximumSelectedAreas: 2 };
    const predictions = rawPredictions.map((prediction) => applyThresholds(prediction.taskEpisodeId, prediction.classifier, prediction.areaScores, thresholds, prediction.durationMs));
    const metrics = calculateExtendedMetrics(labels, predictions); candidatesEvaluated += 1;
    const candidate: ThresholdSearchResult = {
      thresholds,
      objective: {
        falseKnownRate: metrics.core.falseKnownRate, topTwoRecall: metrics.core.topTwoRecall,
        routingCoverage: metrics.routingCoverage, exactLabelSetMatch: metrics.core.exactLabelSetMatch,
      },
      candidatesEvaluated,
      coverageCurve: [],
    };
    const point: ThresholdSearchResult["coverageCurve"][number] = {
      falseKnownRate: metrics.core.falseKnownRate,
      falseUnknownRate: metrics.core.falseUnknownRate,
      routingCoverage: metrics.routingCoverage,
      correctnessAmongRouted: metrics.correctnessAmongRouted,
      topTwoRecall: metrics.core.topTwoRecall,
      exactLabelSetMatch: metrics.core.exactLabelSetMatch,
      thresholds,
    };
    const pointKey = [
      metrics.core.raw.falseKnown,
      metrics.core.raw.falseUnknown,
      Math.round(metrics.routingCoverage * labels.length),
      metrics.correctnessAmongRouted === null
        ? "null"
        : metrics.correctnessAmongRouted.toFixed(6),
    ].join(":");
    const priorPoint = curveByOutcome.get(pointKey);
    if (
      !priorPoint ||
      point.exactLabelSetMatch > priorPoint.exactLabelSetMatch ||
      (
        point.exactLabelSetMatch === priorPoint.exactLabelSetMatch &&
        point.topTwoRecall > priorPoint.topTwoRecall
      )
    ) {
      curveByOutcome.set(pointKey, point);
    }
    const safe = metrics.core.falseKnownRate === null || metrics.core.falseKnownRate <= maximumFalseKnownRate;
    const bestSafe = best && (best.objective.falseKnownRate === null || best.objective.falseKnownRate <= maximumFalseKnownRate);
    const tuple = [safe ? 1 : 0, -Number(metrics.core.falseKnownRate ?? 0), metrics.core.topTwoRecall, metrics.routingCoverage, metrics.core.exactLabelSetMatch];
    const bestTuple = best ? [bestSafe ? 1 : 0, -Number(best.objective.falseKnownRate ?? 0), best.objective.topTwoRecall, best.objective.routingCoverage, best.objective.exactLabelSetMatch] : [];
    if (!best || tuple.some((value, index) => value !== bestTuple[index] && value > (bestTuple[index] ?? Number.NEGATIVE_INFINITY) && tuple.slice(0, index).every((prior, priorIndex) => prior === bestTuple[priorIndex]))) best = candidate;
  }
  return {
    ...best!,
    candidatesEvaluated,
    coverageCurve: [...curveByOutcome.values()].sort(
      (left, right) =>
        Number(left.falseKnownRate ?? 0) -
          Number(right.falseKnownRate ?? 0) ||
        left.routingCoverage - right.routingCoverage ||
        Number(left.falseUnknownRate ?? 0) -
          Number(right.falseUnknownRate ?? 0),
    ),
  };
};

export interface LunaConfidenceSearchResult {
  minimumConfidence: number;
  objective: {
    falseKnownRate: number | null;
    falseUnknownRate: number | null;
    routingCoverage: number;
    correctnessAmongRouted: number | null;
    topTwoRecall: number;
    exactLabelSetMatch: number;
  };
  candidatesEvaluated: number;
  coverageCurve: Array<{
    minimumConfidence: number;
    falseKnownRate: number | null;
    falseUnknownRate: number | null;
    routingCoverage: number;
    correctnessAmongRouted: number | null;
    topTwoRecall: number;
    exactLabelSetMatch: number;
  }>;
}

export const applyLunaConfidenceThreshold = (
  predictions: ClassifierPredictionV1[],
  minimumConfidence: number,
): ClassifierPredictionV1[] => predictions.map((prediction) => {
  if (!prediction.known || prediction.confidence >= minimumConfidence) {
    return prediction;
  }
  return {
    ...prediction,
    classifier: `${prediction.classifier}:confidence>=${minimumConfidence}`,
    selectedAreaIds: [],
    known: false,
    abstentionReason: "confidence_below_validation_threshold",
  };
});

export const tuneLunaConfidence = (
  labels: SilverLabelV1[],
  predictions: ClassifierPredictionV1[],
  maximumFalseKnownRate = 0.1,
): LunaConfidenceSearchResult => {
  const candidates = [
    0,
    ...new Set(predictions.map((prediction) => prediction.confidence)),
    1 + Number.EPSILON,
  ].sort((left, right) => left - right);
  let best: LunaConfidenceSearchResult | undefined;
  const coverageCurve: LunaConfidenceSearchResult["coverageCurve"] = [];
  for (const minimumConfidence of candidates) {
    const thresholded = applyLunaConfidenceThreshold(
      predictions,
      minimumConfidence,
    );
    const metrics = calculateExtendedMetrics(labels, thresholded);
    const point = {
      minimumConfidence,
      falseKnownRate: metrics.core.falseKnownRate,
      falseUnknownRate: metrics.core.falseUnknownRate,
      routingCoverage: metrics.routingCoverage,
      correctnessAmongRouted: metrics.correctnessAmongRouted,
      topTwoRecall: metrics.core.topTwoRecall,
      exactLabelSetMatch: metrics.core.exactLabelSetMatch,
    };
    coverageCurve.push(point);
    const candidate: LunaConfidenceSearchResult = {
      minimumConfidence,
      objective: {
        falseKnownRate: point.falseKnownRate,
        falseUnknownRate: point.falseUnknownRate,
        routingCoverage: point.routingCoverage,
        correctnessAmongRouted: point.correctnessAmongRouted,
        topTwoRecall: point.topTwoRecall,
        exactLabelSetMatch: point.exactLabelSetMatch,
      },
      candidatesEvaluated: candidates.length,
      coverageCurve: [],
    };
    const safe =
      point.falseKnownRate === null ||
      point.falseKnownRate <= maximumFalseKnownRate;
    const bestSafe = best &&
      (
        best.objective.falseKnownRate === null ||
        best.objective.falseKnownRate <= maximumFalseKnownRate
      );
    const tuple = [
      safe ? 1 : 0,
      -Number(point.falseKnownRate ?? 0),
      point.routingCoverage,
      Number(point.correctnessAmongRouted ?? 0),
      point.topTwoRecall,
      point.exactLabelSetMatch,
    ];
    const bestTuple = best
      ? [
          bestSafe ? 1 : 0,
          -Number(best.objective.falseKnownRate ?? 0),
          best.objective.routingCoverage,
          Number(best.objective.correctnessAmongRouted ?? 0),
          best.objective.topTwoRecall,
          best.objective.exactLabelSetMatch,
        ]
      : [];
    if (
      !best ||
      tuple.some(
        (entry, index) =>
          entry !== bestTuple[index] &&
          entry > (bestTuple[index] ?? Number.NEGATIVE_INFINITY) &&
          tuple
            .slice(0, index)
            .every((prior, priorIndex) => prior === bestTuple[priorIndex]),
      )
    ) {
      best = candidate;
    }
  }
  return { ...best!, coverageCurve };
};

export interface CascadeResult {
  predictions: ClassifierPredictionV1[];
  embeddingAccepted: number;
  lunaUsed: number;
  fallbackUsed: number;
}

export const simulateCascade = (
  embedding: ClassifierPredictionV1[],
  luna: ClassifierPredictionV1[],
): CascadeResult => {
  const lunaById = new Map(luna.map((prediction) => [prediction.taskEpisodeId, prediction]));
  let embeddingAccepted = 0, lunaUsed = 0, fallbackUsed = 0;
  const predictions = embedding.map((prediction) => {
    if (prediction.known) { embeddingAccepted += 1; return { ...prediction, classifier: `cascade:${prediction.classifier}` }; }
    const escalation = lunaById.get(prediction.taskEpisodeId);
    if (escalation?.known) { lunaUsed += 1; return { ...escalation, classifier: `cascade:${prediction.classifier}->${escalation.classifier}` }; }
    fallbackUsed += 1;
    return { ...(escalation ?? prediction), classifier: `cascade:${prediction.classifier}->safe-fallback`, known: false, selectedAreaIds: [], abstentionReason: escalation?.abstentionReason ?? prediction.abstentionReason ?? "safe_fallback" };
  });
  return { predictions, embeddingAccepted, lunaUsed, fallbackUsed };
};

export interface WithheldAreaDataset {
  withheldAreaId: string;
  cards: AreaCardV1[];
  knownLabels: SilverLabelV1[];
  hiddenLabels: SilverLabelV1[];
}

export const withholdArea = (cards: AreaCardV1[], labels: SilverLabelV1[], areaId: string): WithheldAreaDataset => {
  if (!cards.some((card) => card.areaId === areaId)) throw new Error(`Unknown area to withhold: ${areaId}`);
  return {
    withheldAreaId: areaId,
    cards: cards.filter((card) => card.areaId !== areaId).map((card) => ({ ...card, confusableAreaIds: card.confusableAreaIds.filter((id) => id !== areaId) })),
    knownLabels: labels.filter((label) => !label.selectedAreaIds.includes(areaId)),
    hiddenLabels: labels.filter((label) => label.selectedAreaIds.includes(areaId)).map((label) => ({
      ...label, selectedAreaIds: [], known: false, unknownType: "new_repository_area", difficulty: "unknown",
      reason: `Area ${areaId} was withheld for the unknown-detection experiment.`,
    })),
  };
};

export const renderLunaAreaCards = (cards: AreaCardV1[]): string =>
  cards.map((card) => areaOverviewText(card)).join("\n\n---\n\n");

export interface RefreshSimulation {
  restoredAreaId: string;
  restoredOverviewVector: boolean;
  restoredExampleVectors: number;
  existingOverviewVectorsReused: number;
  existingExampleVectorsReused: number;
  requiredHostedVectorIds: string[];
  beforePredictions?: ClassifierPredictionV1[];
  afterPredictions?: ClassifierPredictionV1[];
  changedPredictions?: number;
}

export const simulateAreaRefresh = (
  fullCards: AreaCardV1[],
  hiddenCards: AreaCardV1[],
  fullVectors: SavedVectorArtifact,
  areaId: string,
  taskRepresentation: ContextRepresentation,
  thresholds: ThresholdsV1,
): RefreshSimulation => {
  const restored = fullCards.find((card) => card.areaId === areaId);
  if (!restored || hiddenCards.some((card) => card.areaId === areaId)) throw new Error("Area must exist only in the full registry");
  const hiddenOverviewIds = new Set(hiddenCards.map((card) => `overview:${card.areaId}`));
  const hiddenExampleIds = new Set(hiddenCards.flatMap((card) => card.positiveExampleIds.map((id) => `example:${card.areaId}:${id}`)));
  const requiredHostedVectorIds = [
    `overview:${areaId}`,
    ...restored.positiveExampleIds.map((id) => `example:${areaId}:${id}`),
  ].filter((id) => !fullVectors.overviewVectors.some((vector) => vector.id === id) && !fullVectors.exampleVectors.some((vector) => vector.id === id));
  const taskVectors = fullVectors.taskVectors.filter((vector) => vector.representation === taskRepresentation);
  let beforePredictions: ClassifierPredictionV1[] | undefined, afterPredictions: ClassifierPredictionV1[] | undefined, changedPredictions: number | undefined;
  try {
    beforePredictions = classifyEmbeddingMethod(taskVectors, buildHiddenAreaVectors(hiddenCards, fullVectors), "topk-3", thresholds);
    afterPredictions = classifyEmbeddingMethod(taskVectors, buildAreaVectors(fullCards, fullVectors), "topk-3", thresholds);
    changedPredictions = beforePredictions.filter((prediction, index) =>
      JSON.stringify(prediction.selectedAreaIds) !== JSON.stringify(afterPredictions?.[index]?.selectedAreaIds)
      || prediction.known !== afterPredictions?.[index]?.known,
    ).length;
  } catch {
    // Refresh accounting remains useful before the new vectors have been generated.
  }
  return {
    restoredAreaId: areaId,
    restoredOverviewVector: fullVectors.overviewVectors.some((vector) => vector.id === `overview:${areaId}`),
    restoredExampleVectors: restored.positiveExampleIds.filter((id) => fullVectors.exampleVectors.some((vector) => vector.id === `example:${areaId}:${id}`)).length,
    existingOverviewVectorsReused: fullVectors.overviewVectors.filter((vector) => hiddenOverviewIds.has(vector.id)).length,
    existingExampleVectorsReused: fullVectors.exampleVectors.filter((vector) => hiddenExampleIds.has(vector.id)).length,
    requiredHostedVectorIds,
    ...(beforePredictions ? { beforePredictions } : {}),
    ...(afterPredictions ? { afterPredictions } : {}),
    ...(changedPredictions !== undefined ? { changedPredictions } : {}),
  };
};
