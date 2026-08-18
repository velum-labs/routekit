import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { contentHash } from "./hash.ts";
import type { AreaCardV1, RepositoryProfileV1, TaskEpisode } from "./types.ts";
import { validateAreaCards, validateRepositoryProfile } from "./validation.ts";

const execFileAsync = promisify(execFile);

export interface RegistryFreezeReport {
  schemaVersion: 1;
  generatedAt: string;
  repositoryId: string;
  repositorySnapshot: string;
  registryVersion: string;
  profileHash: string;
  areaCardsHash: string;
  referenceDatasetHash: string;
  generatorVersions: string[];
  areas: Array<{
    areaId: string;
    referenceExamples: number;
    missingExampleIds: string[];
    nonReferenceExampleIds: string[];
    existingPathAnchors: string[];
    missingPathAnchors: string[];
    completeness: {
      inclusions: boolean;
      exclusions: boolean;
      boundaryExamples: boolean;
      codeEvidence: boolean;
      confusables: boolean;
      minimumFiveExamples: boolean;
    };
  }>;
  gates: Array<{ gate: string; passed: boolean; detail: string }>;
  ready: boolean;
}

const gitPathExists = async (repository: string, snapshot: string, candidate: string): Promise<boolean> => {
  try {
    await execFileAsync("git", ["-C", repository, "cat-file", "-e", `${snapshot}:${candidate}`]);
    return true;
  } catch {
    return false;
  }
};

export const freezeRegistry = async (
  profile: RepositoryProfileV1,
  cards: AreaCardV1[],
  episodes: TaskEpisode[],
  repository?: string,
): Promise<RegistryFreezeReport> => {
  validateRepositoryProfile(profile);
  validateAreaCards(cards, profile);
  if (new Set(cards.map((card) => card.registryVersion)).size !== 1) throw new Error("Area Cards must share one registryVersion");
  const byId = new Map(episodes.map((episode) => [episode.id, episode]));
  const areas = [];
  for (const card of cards) {
    const missingExampleIds = card.positiveExampleIds.filter((id) => !byId.has(id));
    const nonReferenceExampleIds = card.positiveExampleIds.filter((id) => byId.get(id)?.split !== "reference");
    const existingPathAnchors: string[] = [], missingPathAnchors: string[] = [];
    for (const anchor of card.pathAnchors) {
      if (!repository || await gitPathExists(repository, profile.snapshot, anchor)) existingPathAnchors.push(anchor);
      else missingPathAnchors.push(anchor);
    }
    areas.push({
      areaId: card.areaId, referenceExamples: card.positiveExampleIds.length, missingExampleIds, nonReferenceExampleIds,
      existingPathAnchors, missingPathAnchors,
      completeness: {
        inclusions: card.inclusions.length > 0, exclusions: card.exclusions.length > 0,
        boundaryExamples: card.boundaryExamples.length > 0,
        codeEvidence: card.codeSummaries.length > 0 || card.codeSnippets.length > 0,
        confusables: card.confusableAreaIds.every((areaId) => cards.some((candidate) => candidate.areaId === areaId)),
        minimumFiveExamples: card.positiveExampleIds.length >= 5,
      },
    });
  }
  const gates = [
    { gate: "profile-snapshot-valid", passed: /^[0-9a-f]{7,64}$/iu.test(profile.snapshot), detail: profile.snapshot },
    { gate: "all-examples-exist", passed: areas.every((area) => area.missingExampleIds.length === 0), detail: `${areas.reduce((sum, area) => sum + area.missingExampleIds.length, 0)} missing` },
    { gate: "reference-only-area-examples", passed: areas.every((area) => area.nonReferenceExampleIds.length === 0), detail: `${areas.reduce((sum, area) => sum + area.nonReferenceExampleIds.length, 0)} non-reference` },
    { gate: "minimum-five-examples-per-area", passed: areas.every((area) => area.completeness.minimumFiveExamples), detail: `${areas.filter((area) => area.completeness.minimumFiveExamples).length}/${areas.length}` },
    { gate: "path-anchors-exist-at-snapshot", passed: areas.every((area) => area.missingPathAnchors.length === 0), detail: `${areas.reduce((sum, area) => sum + area.missingPathAnchors.length, 0)} missing` },
    { gate: "rich-card-fields-complete", passed: areas.every((area) => Object.values(area.completeness).every(Boolean)), detail: `${areas.filter((area) => Object.values(area.completeness).every(Boolean)).length}/${areas.length}` },
  ];
  return {
    schemaVersion: 1, generatedAt: new Date().toISOString(), repositoryId: profile.repositoryId,
    repositorySnapshot: profile.snapshot, registryVersion: cards[0]!.registryVersion,
    profileHash: contentHash(profile), areaCardsHash: contentHash(cards),
    referenceDatasetHash: contentHash(episodes.filter((episode) => episode.split === "reference")),
    generatorVersions: [...new Set([profile.generatorVersion, ...cards.map((card) => card.generatorVersion)])].sort(),
    areas, gates, ready: gates.every((gate) => gate.passed),
  };
};
