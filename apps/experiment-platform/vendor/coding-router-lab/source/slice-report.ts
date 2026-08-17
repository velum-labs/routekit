import { isReferentialRequest } from "./codex-collector.ts";
import { calculateExtendedMetrics } from "./experiment-metrics.ts";
import type {
  ClassifierPredictionV1,
  SilverLabelV1,
  TaskEpisode,
} from "./types.ts";

export interface SliceReport {
  schemaVersion: 1;
  slices: Array<{
    slice: string;
    cases: number;
    validation: number;
    test: number;
    known: number;
    unknown: number;
    metrics: Record<
      string,
      ReturnType<typeof calculateExtendedMetrics>
    >;
  }>;
  warnings: string[];
}

const correction = (episode: TaskEpisode): boolean =>
  /\b(?:no[, ]|I meant|rather than|not the|instead)\b/iu.test(
    episode.currentRequest,
  );

export const buildSliceReport = (
  episodes: TaskEpisode[],
  labels: SilverLabelV1[],
  predictions: Record<string, ClassifierPredictionV1[]>,
): SliceReport => {
  const episodeById = new Map(episodes.map((episode) => [episode.id, episode]));
  const labelById = new Map(labels.map((label) => [label.taskEpisodeId, label]));
  const slices: Array<{
    name: string;
    predicate: (episode: TaskEpisode, label: SilverLabelV1) => boolean;
  }> = [
    { name: "all", predicate: () => true },
    {
      name: "explicit_or_natural",
      predicate: (episode) => !isReferentialRequest(episode.currentRequest),
    },
    {
      name: "contextual_referential",
      predicate: (episode) => isReferentialRequest(episode.currentRequest),
    },
    {
      name: "diagnostic_followup",
      predicate: (episode) => Boolean(episode.relevantDiagnostic),
    },
    { name: "correction", predicate: correction },
    {
      name: "new_task_boundary",
      predicate: (episode) =>
        !isReferentialRequest(episode.currentRequest) &&
        Boolean(
          episode.taskAnchor ||
          episode.precedingAssistant ||
          (episode.earlierUserContext?.length ?? 0) > 0,
        ),
    },
    { name: "known", predicate: (_episode, label) => label.known },
    { name: "unknown", predicate: (_episode, label) => !label.known },
    {
      name: "single_area",
      predicate: (_episode, label) => label.selectedAreaIds.length === 1,
    },
    {
      name: "multi_area",
      predicate: (_episode, label) => label.selectedAreaIds.length === 2,
    },
    {
      name: "insufficient_information",
      predicate: (_episode, label) =>
        label.unknownType === "insufficient_information",
    },
    {
      name: "new_repository_area",
      predicate: (_episode, label) =>
        label.unknownType === "new_repository_area",
    },
    {
      name: "outside_scope",
      predicate: (_episode, label) => label.unknownType === "outside_scope",
    },
  ];
  const reports = slices.map((slice) => {
    const sliceLabels = labels.filter((label) => {
      const episode = episodeById.get(label.taskEpisodeId);
      if (!episode) throw new Error(`Missing slice episode ${label.taskEpisodeId}`);
      return slice.predicate(episode, label);
    });
    const ids = new Set(sliceLabels.map((label) => label.taskEpisodeId));
    const sliceEpisodes = [...ids].map((id) => episodeById.get(id)!);
    return {
      slice: slice.name,
      cases: sliceLabels.length,
      validation: sliceEpisodes.filter(
        (episode) => episode.split === "validation",
      ).length,
      test: sliceEpisodes.filter((episode) => episode.split === "test").length,
      known: sliceLabels.filter((label) => label.known).length,
      unknown: sliceLabels.filter((label) => !label.known).length,
      metrics: Object.fromEntries(
        Object.entries(predictions).map(([name, values]) => {
          const byId = new Map(
            values.map((prediction) => [
              prediction.taskEpisodeId,
              prediction,
            ]),
          );
          const slicePredictions = [...ids].map((id) => {
            const prediction = byId.get(id);
            if (!prediction) {
              throw new Error(`Missing ${name} slice prediction ${id}`);
            }
            return prediction;
          });
          return [
            name,
            calculateExtendedMetrics(sliceLabels, slicePredictions),
          ];
        }),
      ),
    };
  });
  const warnings: string[] = [];
  const newTaskBoundary = reports.find(
    (report) => report.slice === "new_task_boundary",
  );
  if (!newTaskBoundary?.cases) {
    warnings.push(
      "No recovered evaluation case qualified as a new-task-boundary slice.",
    );
  }
  for (const report of reports) {
    if (report.cases > 0 && report.cases < 10) {
      warnings.push(
        `${report.slice} has only ${report.cases} cases; percentages are unstable.`,
      );
    }
  }
  return { schemaVersion: 1, slices: reports, warnings };
};
