import { isReferentialRequest } from "./codex-collector.ts";
import type { RepositoryProfileV1, TaskEpisode } from "./types.ts";

export interface CanarySelection {
  episodes: TaskEpisode[];
  composition: {
    clear: number;
    contextual: number;
    diagnostic: number;
    likelyBoundary: number;
    syntheticUnknown: number;
  };
  warnings: string[];
}

const likelyBoundary = (episode: TaskEpisode): boolean =>
  /\b(?:and|across|both|end-to-end|integrat|migration|release|deploy)\b/iu.test(episode.currentRequest);
const likelyClear = (episode: TaskEpisode): boolean =>
  !isReferentialRequest(episode.currentRequest) && !episode.relevantDiagnostic && episode.currentRequest.length >= 30;

export const selectOracleCanary = (
  episodes: TaskEpisode[],
  profile: RepositoryProfileV1,
  count = 10,
): CanarySelection => {
  if (count < 6) throw new Error("Canary count must be at least six");
  const validation = episodes.filter((episode) => episode.split === "validation").sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id));
  const selected: TaskEpisode[] = [];
  const take = (predicate: (episode: TaskEpisode) => boolean, desired: number): number => {
    let added = 0;
    for (const episode of validation) {
      if (added >= desired || selected.some((item) => item.id === episode.id) || !predicate(episode)) continue;
      selected.push(episode); added += 1;
    }
    return added;
  };
  const contextual = take((episode) => isReferentialRequest(episode.currentRequest) && Boolean(episode.taskAnchor || episode.precedingAssistant), 2);
  const diagnostic = take((episode) => Boolean(episode.relevantDiagnostic), 1);
  const boundary = take(likelyBoundary, 2);
  const clear = take(likelyClear, 3);
  take(() => true, Math.max(0, count - 2 - selected.length));
  const validationTimestamp =
    episodes
      .filter((episode) => episode.split === "validation")
      .map((episode) => episode.timestamp)
      .sort()
      .at(-1) ??
    episodes.map((episode) => episode.timestamp).sort().at(-1) ??
    "1970-01-01T00:00:00.000Z";
  const unknowns: TaskEpisode[] = [
    {
      schemaVersion: 1, id: `${profile.repositoryId.replace(/[^a-z0-9]+/giu, "-")}-derived-unknown-outside-scope`,
      repositoryId: profile.repositoryId, repositorySnapshot: profile.snapshot, sessionHash: "derived-unknown-outside-scope",
      lineageHash: "derived-unknown-outside-scope", timestamp: validationTimestamp, split: "validation",
      currentRequest: `Write the company's quarterly investor update and sales forecast. This is not a change to ${profile.name} or its repository.`,
      source: "derived",
    },
    {
      schemaVersion: 1, id: `${profile.repositoryId.replace(/[^a-z0-9]+/giu, "-")}-derived-unknown-insufficient`,
      repositoryId: profile.repositoryId, repositorySnapshot: profile.snapshot, sessionHash: "derived-unknown-insufficient",
      lineageHash: "derived-unknown-insufficient", timestamp: validationTimestamp, split: "validation", currentRequest: "fix it", source: "derived",
    },
  ];
  const knownTarget = Math.max(0, count - unknowns.length);
  const result = [...selected.slice(0, knownTarget), ...unknowns].map((episode) => ({ ...episode, split: "validation" as const }));
  const warnings: string[] = [];
  if (contextual < 2) warnings.push(`Only ${contextual}/2 contextual cases were available.`);
  if (diagnostic < 1) warnings.push("No diagnostic-heavy validation case was available.");
  if (boundary < 2) warnings.push(`Only ${boundary}/2 likely boundary cases were available.`);
  if (clear < 2) warnings.push(`Only ${clear} likely clear cases were available.`);
  if (result.length < count) warnings.push(`Canary contains ${result.length}/${count} requested cases.`);
  return {
    episodes: result,
    composition: {
      clear: result.filter(likelyClear).length,
      contextual: result.filter((episode) => isReferentialRequest(episode.currentRequest) && Boolean(episode.taskAnchor || episode.precedingAssistant)).length,
      diagnostic: result.filter((episode) => Boolean(episode.relevantDiagnostic)).length,
      likelyBoundary: result.filter(likelyBoundary).length,
      syntheticUnknown: unknowns.length,
    },
    warnings,
  };
};
