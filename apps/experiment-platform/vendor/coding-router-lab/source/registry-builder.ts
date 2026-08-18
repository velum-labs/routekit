import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { contentHash } from "./hash.ts";
import { ROUTEKIT_AREAS } from "./routekit-seed.ts";
import type {
  AreaCardV1,
  RepositoryProfileV1,
  TaskEpisode,
} from "./types.ts";

const execFileAsync = promisify(execFile);
const MAX_EXAMPLES_PER_AREA = 12;
const MINIMUM_EXAMPLES_PER_AREA = 5;

interface AreaMatch {
  areaId: string;
  score: number;
}

export interface ReferenceRegistryBuildResult {
  profile: RepositoryProfileV1;
  cards: AreaCardV1[];
  registryEpisodes: TaskEpisode[];
  assignments: Array<{
    taskEpisodeId: string;
    selectedAreaIds: string[];
    evidence: string[];
  }>;
  excludedReferenceEpisodes: number;
  areasBelowMinimumExamples: string[];
}

const repositoryPaths = async (
  repository: string,
  snapshot: string,
): Promise<string[]> => {
  const result = await execFileAsync(
    "git",
    ["-C", repository, "ls-tree", "-r", "--name-only", snapshot],
    { maxBuffer: 32 * 1024 * 1024 },
  );
  return result.stdout.split(/\r?\n/u).filter(Boolean);
};

const normalized = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9_./-]+/gu, " ");

const containsAnchor = (text: string, anchor: string): boolean => {
  const escaped = anchor
    .toLowerCase()
    .replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9_./-])${escaped}(?:$|[^a-z0-9_./-]|/)`, "u").test(text);
};

const keywordScores: Record<string, RegExp[]> = {
  "gateway-routing": [
    /\bgateway\b/iu,
    /\brouter|routing|route selection\b/iu,
    /\bprovider|model call|stream|responses api|anthropic|gemini|bedrock\b/iu,
    /\btool call|tool_search_call|wire|codec|translation|id shape|compatibility-normalization\b/iu,
  ],
  "accounts-identity": [
    /\baccount|subscription|credential|relogin|re-login|login|api key\b/iu,
    /\brate limit|usage limit|used_percent|reset\b/iu,
    /\btoken|identity|peer|enroll|auth recovery\b/iu,
  ],
  "daemon-control": [
    /\bdaemon|worker|supervis|restart|reload|zero.downtime|gateway stopped\b/iu,
    /\bcontrol plane|control rpc|ipc|singleton|lifecycle\b/iu,
    /\bstatus|health|generation\b/iu,
  ],
  "cli-configuration": [
    /\bcli|command|flag|option|setup|onboarding\b/iu,
    /\bconfig|configuration|init|doctor|prompt|terminal\b/iu,
    /\bcompletion|diagnostic|migration\b/iu,
  ],
  "coding-tool-integrations": [
    /\bcodex|claude code|cursor|opencode|coding agent\b/iu,
    /\binstall|launcher|model picker|client version|supported client|harness\b/iu,
    /\bconfig\.toml|native client|session protocol\b/iu,
  ],
  "documentation-release": [
    /\bdocs|documentation|readme|fumadocs|landing page|favicon|og preview\b/iu,
    /\brelease|changeset|changelog|publish|publint|attw\b/iu,
    /\bvercel|deploy docs|dependency warning|ci\b/iu,
  ],
  "cloud-deployment": [
    /\baws|iam|kubernetes|helm|docker|ssh|remote environment\b/iu,
    /\bt3|vercel|provision|infrastructure|deployment\b/iu,
    /\bworkload identity|sandbox|ephemeral\b/iu,
  ],
};

const scoreEpisode = (
  episode: TaskEpisode,
  repositoryFileSet: Set<string>,
): { matches: AreaMatch[]; evidence: string[] } => {
  const text = normalized(
    [
      episode.taskAnchor,
      episode.currentRequest,
      episode.precedingAssistant,
      ...(episode.earlierUserContext ?? []),
      episode.relevantDiagnostic,
    ]
      .filter(Boolean)
      .join("\n"),
  );
  const evidence: string[] = [];
  const scores = new Map<string, number>();
  for (const area of ROUTEKIT_AREAS) {
    let score = 0;
    for (const pattern of keywordScores[area.areaId] ?? []) {
      if (pattern.test(text)) score += 1;
    }
    for (const anchor of area.pathAnchors) {
      if (
        containsAnchor(text, anchor) &&
        [...repositoryFileSet].some(
          (file) => file === anchor || file.startsWith(`${anchor}/`),
        )
      ) {
        score += 3;
        evidence.push(`${area.areaId}:path:${anchor}`);
      }
    }
    for (const symbol of area.symbolAnchors) {
      if (containsAnchor(text, symbol)) {
        score += 2;
        evidence.push(`${area.areaId}:symbol:${symbol}`);
      }
    }
    if (score > 0) scores.set(area.areaId, score);
  }
  return {
    matches: [...scores]
      .map(([areaId, score]) => ({ areaId, score }))
      .sort((left, right) => right.score - left.score || left.areaId.localeCompare(right.areaId)),
    evidence,
  };
};

const selectAreas = (matches: AreaMatch[]): string[] => {
  const top = matches[0];
  if (!top || top.score < 1) return [];
  const selected = [top.areaId];
  const second = matches[1];
  if (
    second &&
    second.score >= 2 &&
    second.score >= Math.max(2, Math.ceil(top.score * 0.65))
  ) {
    selected.push(second.areaId);
  }
  return selected;
};

export const buildReferenceRegistry = async (input: {
  repository: string;
  episodes: TaskEpisode[];
  supplementalEpisodes?: TaskEpisode[];
  supplementalAssignments?: Array<{
    taskEpisodeId: string;
    selectedAreaIds: string[];
  }>;
}): Promise<ReferenceRegistryBuildResult> => {
  const referenceEpisodes = input.episodes.filter(
    (episode) => episode.split === "reference",
  );
  if (referenceEpisodes.length === 0) {
    throw new Error("Reference registry construction requires reference episodes");
  }
  const latestReferenceEpisode = [...referenceEpisodes]
    .sort(
      (left, right) =>
        right.timestamp.localeCompare(left.timestamp) ||
        right.id.localeCompare(left.id),
    )[0]!;
  const snapshot = latestReferenceEpisode.repositorySnapshot;
  const paths = await repositoryPaths(input.repository, snapshot);
  const repositoryFileSet = new Set(paths);
  const assignments = referenceEpisodes.map((episode) => {
    const scored = scoreEpisode(episode, repositoryFileSet);
    return {
      taskEpisodeId: episode.id,
      selectedAreaIds: selectAreas(scored.matches),
      evidence: scored.evidence,
      scores: scored.matches,
    };
  });
  const supplementalEpisodes = (input.supplementalEpisodes ?? []).filter(
    (episode) =>
      episode.timestamp <= latestReferenceEpisode.timestamp &&
      episode.split === "reference",
  );
  const supplementalAssignments = input.supplementalAssignments ?? [];
  const supplementalById = new Map(
    supplementalAssignments.map((assignment) => [
      assignment.taskEpisodeId,
      assignment.selectedAreaIds,
    ]),
  );
  const eligibleSupplemental = supplementalEpisodes.filter(
    (episode) => (supplementalById.get(episode.id)?.length ?? 0) > 0,
  );
  const byId = new Map(
    [...referenceEpisodes, ...eligibleSupplemental].map((episode) => [
      episode.id,
      episode,
    ]),
  );
  const registryDatasetId = contentHash(
    referenceEpisodes.map((episode) => ({
      id: episode.id,
      snapshot: episode.repositorySnapshot,
    })),
  ).slice(0, 10);
  const profile: RepositoryProfileV1 = {
    schemaVersion: 1,
    repositoryId: "velum-labs/routekit",
    snapshot,
    name: "RouteKit",
    purpose:
      "A TypeScript CLI and singleton daemon exposing an authenticated, OpenAI-compatible gateway across coding subscriptions and API providers.",
    languages: ["TypeScript", "Shell", "MDX"],
    frameworks: ["Node.js", "pnpm", "Turborepo", "Next.js", "Fumadocs"],
    components: ROUTEKIT_AREAS.map((area) => ({
      name: area.name,
      purpose: area.description,
      paths: area.pathAnchors,
    })),
    generatorVersion: "routekit-reference-registry-v1",
  };
  const cards: AreaCardV1[] = ROUTEKIT_AREAS.map((area) => {
    const realCandidates = assignments
      .filter((assignment) => assignment.selectedAreaIds.includes(area.areaId))
      .sort((left, right) => {
        const leftScore =
          left.scores.find((score) => score.areaId === area.areaId)?.score ?? 0;
        const rightScore =
          right.scores.find((score) => score.areaId === area.areaId)?.score ?? 0;
        return (
          rightScore - leftScore ||
          (byId.get(left.taskEpisodeId)?.timestamp ?? "").localeCompare(
            byId.get(right.taskEpisodeId)?.timestamp ?? "",
          )
        );
      });
    const realIds = new Set(
      realCandidates.map((candidate) => candidate.taskEpisodeId),
    );
    const supplementalCandidates = eligibleSupplemental
      .filter((episode) =>
        supplementalById.get(episode.id)?.includes(area.areaId),
      )
      .filter((episode) => !realIds.has(episode.id))
      .map((episode) => ({
        taskEpisodeId: episode.id,
        selectedAreaIds: supplementalById.get(episode.id) ?? [],
        evidence: ["supplemental:changed-path-assignment"],
        scores: [{ areaId: area.areaId, score: 1 }],
      }));
    const candidates = [...realCandidates, ...supplementalCandidates].slice(
      0,
      MAX_EXAMPLES_PER_AREA,
    );
    const representativeTasks = candidates
      .slice(0, 6)
      .map((candidate) => byId.get(candidate.taskEpisodeId)?.currentRequest)
      .filter((request): request is string => Boolean(request))
      .map((request) => request.replace(/\s+/gu, " ").slice(0, 240));
    return {
      schemaVersion: 1,
      registryVersion: `routekit-reference-v1-${snapshot.slice(0, 10)}-${registryDatasetId}`,
      repositoryId: profile.repositoryId,
      areaId: area.areaId,
      name: area.name,
      description: area.description,
      inclusions: area.inclusions,
      exclusions: area.exclusions,
      confusableAreaIds: ROUTEKIT_AREAS.filter(
        (other) =>
          other.areaId !== area.areaId &&
          (other.pathAnchors.some((anchor) => area.pathAnchors.includes(anchor)) ||
            candidates.some((candidate) =>
              candidate.selectedAreaIds.includes(other.areaId),
            )),
      ).map((other) => other.areaId),
      pathAnchors: area.pathAnchors.filter((anchor) =>
        paths.some((file) => file === anchor || file.startsWith(`${anchor}/`)),
      ),
      componentAnchors: area.componentAnchors,
      symbolAnchors: area.symbolAnchors,
      codeSummaries: [
        ...area.codeSummaries,
        ...representativeTasks.map(
          (task) => `Representative reference-period task: ${task}`,
        ),
      ],
      codeSnippets: [],
      positiveExampleIds: candidates.map((candidate) => candidate.taskEpisodeId),
      boundaryExamples: area.boundaryExamples,
      sourceHashes: [
        contentHash({
          areaId: area.areaId,
          snapshot,
          exampleIds: candidates.map((candidate) => candidate.taskEpisodeId),
        }),
      ],
      generatorVersion: "routekit-reference-registry-v1",
    };
  });
  return {
    profile,
    cards,
    registryEpisodes: [...referenceEpisodes, ...eligibleSupplemental],
    assignments: assignments.map(({ scores: _scores, ...assignment }) => assignment),
    excludedReferenceEpisodes: assignments.filter(
      (assignment) => assignment.selectedAreaIds.length === 0,
    ).length,
    areasBelowMinimumExamples: cards
      .filter((card) => card.positiveExampleIds.length < MINIMUM_EXAMPLES_PER_AREA)
      .map((card) => card.areaId),
  };
};
