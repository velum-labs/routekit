import { centroid, cosine } from "./vectors.ts";
import type { AreaScore, ClassifierPredictionV1, DenseVector, ThresholdsV1 } from "./types.ts";

export interface AreaVectors {
  areaId: string;
  overview: DenseVector;
  examples: DenseVector[];
}

const rank = (scores: AreaScore[]): AreaScore[] => [...scores].sort((a, b) => b.score - a.score || a.areaId.localeCompare(b.areaId));

export const descriptionScores = (task: DenseVector, areas: AreaVectors[]): AreaScore[] =>
  rank(areas.map((area) => ({ areaId: area.areaId, score: cosine(task.values, area.overview.values), evidenceIds: [area.overview.id] })));

export const centroidScores = (task: DenseVector, areas: AreaVectors[]): AreaScore[] =>
  rank(areas.map((area) => ({ areaId: area.areaId, score: cosine(task.values, centroid(area.examples.map((item) => item.values))), evidenceIds: area.examples.map((item) => item.id) })));

export const exemplarScores = (task: DenseVector, areas: AreaVectors[], k: number): AreaScore[] => {
  if (k < 1) throw new Error("k must be positive");
  return rank(areas.map((area) => {
    const matches = area.examples.map((item) => ({ id: item.id, score: cosine(task.values, item.values) })).sort((a, b) => b.score - a.score).slice(0, k);
    const weight = matches.reduce((sum, item) => sum + Math.max(0, item.score), 0);
    return { areaId: area.areaId, score: matches.length === 0 ? -1 : weight / matches.length, evidenceIds: matches.map((item) => item.id) };
  }));
};

export const applyThresholds = (
  taskEpisodeId: string,
  classifier: string,
  areaScores: AreaScore[],
  thresholds: ThresholdsV1,
  durationMs = 0
): ClassifierPredictionV1 => {
  const ordered = rank(areaScores);
  const top = ordered[0];
  const second = ordered[1];
  if (!top || top.score < thresholds.minimumTopScore) {
    return { schemaVersion: 1, taskEpisodeId, classifier, areaScores: ordered, selectedAreaIds: [], known: false, confidence: 0, abstentionReason: "top_score_below_threshold", durationMs };
  }
  const margin = second ? top.score - second.score : 1;
  const selectedAreaIds = second && second.score >= thresholds.minimumSecondScoreForMultiArea
    ? [top.areaId, second.areaId]
    : [top.areaId];
  if (selectedAreaIds.length === 1 && margin < thresholds.minimumMargin) {
    return { schemaVersion: 1, taskEpisodeId, classifier, areaScores: ordered, selectedAreaIds: [], known: false, confidence: Math.max(0, top.score), abstentionReason: "top_margin_below_threshold", durationMs };
  }
  return { schemaVersion: 1, taskEpisodeId, classifier, areaScores: ordered, selectedAreaIds: selectedAreaIds.slice(0, thresholds.maximumSelectedAreas), known: true, confidence: Math.max(0, Math.min(1, selectedAreaIds.length === 2 ? second!.score : Math.max(top.score, margin))), durationMs };
};
