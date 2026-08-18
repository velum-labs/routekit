import { execFile } from "node:child_process";
import {
  mkdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { contentHash, sha256 } from "./hash.ts";
import type {
  LunaPerformanceRetrievalResult,
  LunaPerformanceSnippet,
} from "./luna-performance-retrieval.ts";
import type { AreaCardV1, TaskEpisode } from "./types.ts";
import { redactText } from "./validation.ts";

const execFileAsync = promisify(execFile);

export const GITNEXUS_EXPERIMENT_VERSION =
  "gitnexus-retrieval-experiment-v1" as const;
export const GITNEXUS_VERSION = "1.6.10-rc.205" as const;
export const GITNEXUS_FUSION_VERSION =
  "weighted-rrf-current-1.0-gitnexus-1.2-diverse-v1" as const;

interface GitNexusLocation {
  filePath?: unknown;
  startLine?: unknown;
  endLine?: unknown;
  name?: unknown;
  module?: unknown;
}

export interface GitNexusQueryOutput {
  processes?: unknown[];
  process_symbols?: unknown[];
  definitions?: unknown[];
  timing?: {
    vector?: number;
    bm25?: number;
    merge?: number;
    symbol_lookup?: number;
    ranking?: number;
    formatting?: number;
    wall?: number;
  };
}

export interface GitNexusDefinition {
  path: string;
  startLine: number;
  endLine: number;
  name: string;
  module?: string;
  rawRank: number;
}

export interface GitNexusAnalyzeMetrics {
  durationMs: number;
  maximumResidentSetKb?: number;
  fileSystemOutputs?: number;
  storageBytesBefore: number;
  storageBytesAfter: number;
  logFile: string;
  resourceFile: string;
}

export interface GitNexusRetrievalProvenance {
  experimentVersion: typeof GITNEXUS_EXPERIMENT_VERSION;
  gitNexusVersion: typeof GITNEXUS_VERSION;
  indexAlias: string;
  exactSnapshotSha: string;
  queryText: string;
  querySha256: string;
  taskAwareContextSha256: string;
  queryDurationMs: number;
  queryTiming: GitNexusQueryOutput["timing"];
  analyze: GitNexusAnalyzeMetrics;
  graphProcessesReturned: number;
  graphDefinitionsReturned: number;
  uniqueDefinitionPaths: number;
  semanticVectorSearchAvailable: false;
  labelsReadDuringRetrieval: false;
  changedPathsRead: false;
  postTaskStateRead: false;
  source: "gitnexus_only" | "current_hybrid_plus_gitnexus";
  fusionVersion?: typeof GITNEXUS_FUSION_VERSION;
}

export type GitNexusRetrievalResult = LunaPerformanceRetrievalResult & {
  gitNexusProvenance: GitNexusRetrievalProvenance;
};

export interface GitNexusCommandOptions {
  binary: string;
  repository: string;
  indexAlias: string;
  artifactDirectory: string;
  workers?: number;
}

const asPositiveInteger = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;

const taskAwareText = (episode: TaskEpisode): string =>
  redactText(
    [
      episode.taskAnchor,
      ...(episode.earlierUserContext ?? []),
      episode.precedingAssistant,
      episode.relevantDiagnostic,
      episode.currentRequest,
    ]
      .filter((value): value is string => Boolean(value?.trim()))
      .join("\n")
      .slice(-24_000),
  ).text;

const meaningfulLine = (text: string): string =>
  text
    .split("\n")
    .map((line) => line.trim())
    .find(
      (line) =>
        line.length >= 3 &&
        !/^problem context:?$/iu.test(line) &&
        !/^#{1,6}\s/u.test(line),
    ) ?? text.trim().slice(0, 240);

const identifierHints = (text: string): string[] => {
  const found = new Set<string>();
  for (const match of text.matchAll(/`([^`\n]{2,100})`/gu)) {
    found.add(match[1]!.trim());
  }
  for (const match of text.matchAll(
    /(?:--[a-z0-9][a-z0-9-]*|[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+|[A-Za-z_$][\w$]*\([^)\n]{0,30}\))/gu,
  )) {
    found.add(match[0].trim());
  }
  return [...found]
    .filter(
      (value) =>
        value.length <= 100 &&
        !/^(?:github\.com|pkg\.go\.dev|www\.[a-z0-9.-]+)$/iu.test(value),
    )
    .slice(0, 10);
};

export const buildGitNexusSearchQuery = (episode: TaskEpisode): string => {
  const context = taskAwareText(episode);
  const title = meaningfulLine(episode.currentRequest).slice(0, 240);
  const hints = identifierHints(context);
  return [title, ...hints].filter(Boolean).join(" ").slice(0, 640);
};

export const buildGitNexusTaskContext = (episode: TaskEpisode): string =>
  taskAwareText(episode).slice(-12_000);

const collectLocations = (
  value: unknown,
  result: GitNexusLocation[],
): void => {
  if (Array.isArray(value)) {
    for (const item of value) collectLocations(item, result);
    return;
  }
  if (!value || typeof value !== "object") return;
  const item = value as Record<string, unknown>;
  if (typeof item.filePath === "string") result.push(item);
  for (const child of Object.values(item)) {
    if (child && typeof child === "object") collectLocations(child, result);
  }
};

const safeRepositoryPath = (candidate: string): string | undefined => {
  const normalized = path.posix.normalize(candidate.replaceAll("\\", "/"));
  if (
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/") ||
    normalized.includes("\0")
  ) {
    return undefined;
  }
  return normalized;
};

export const parseGitNexusDefinitions = (
  output: GitNexusQueryOutput,
): GitNexusDefinition[] => {
  const locations: GitNexusLocation[] = [];
  collectLocations(output.processes ?? [], locations);
  collectLocations(output.process_symbols ?? [], locations);
  collectLocations(output.definitions ?? [], locations);
  const seen = new Set<string>();
  const result: GitNexusDefinition[] = [];
  for (const [rank, location] of locations.entries()) {
    if (typeof location.filePath !== "string") continue;
    const filePath = safeRepositoryPath(location.filePath);
    if (!filePath) continue;
    const startLine = asPositiveInteger(location.startLine, 1);
    const endLine = Math.max(
      startLine,
      asPositiveInteger(location.endLine, startLine + 20),
    );
    const name =
      typeof location.name === "string" && location.name.trim()
        ? location.name.trim().slice(0, 160)
        : path.posix.basename(filePath);
    const key = `${filePath}:${startLine}:${endLine}:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      path: filePath,
      startLine,
      endLine,
      name,
      ...(typeof location.module === "string" && location.module.trim()
        ? { module: location.module.trim().slice(0, 160) }
        : {}),
      rawRank: rank + 1,
    });
  }
  return result;
};

const readDirectoryBytes = async (directory: string): Promise<number> => {
  try {
    const entries = await import("node:fs/promises").then((fs) =>
      fs.readdir(directory, { withFileTypes: true })
    );
    let total = 0;
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) total += await readDirectoryBytes(file);
      else if (entry.isFile()) total += (await stat(file)).size;
    }
    return total;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
};

const parseTimeVerbose = (
  text: string,
): Pick<
  GitNexusAnalyzeMetrics,
  "maximumResidentSetKb" | "fileSystemOutputs"
> => {
  const maximumResidentSet = text.match(
    /Maximum resident set size \(kbytes\):\s*(\d+)/u,
  );
  const fileSystemOutputs = text.match(/File system outputs:\s*(\d+)/u);
  return {
    ...(maximumResidentSet
      ? { maximumResidentSetKb: Number(maximumResidentSet[1]) }
      : {}),
    ...(fileSystemOutputs
      ? { fileSystemOutputs: Number(fileSystemOutputs[1]) }
      : {}),
  };
};

export const analyzeWithGitNexus = async (
  options: GitNexusCommandOptions,
  snapshot: string,
): Promise<GitNexusAnalyzeMetrics> => {
  const safeId = snapshot.slice(0, 12);
  await mkdir(options.artifactDirectory, { recursive: true, mode: 0o700 });
  const logFile = path.join(
    options.artifactDirectory,
    `analyze-${safeId}.log`,
  );
  const resourceFile = path.join(
    options.artifactDirectory,
    `analyze-${safeId}.time`,
  );
  const storageDirectory = path.join(options.repository, ".gitnexus");
  const storageBytesBefore = await readDirectoryBytes(storageDirectory);
  const started = performance.now();
  const result = await execFileAsync(
    "/usr/bin/time",
    [
      "-v",
      "-o",
      resourceFile,
      options.binary,
      "analyze",
      options.repository,
      "--index-only",
      "--workers",
      String(options.workers ?? 3),
      "--no-stats",
      "--name",
      options.indexAlias,
    ],
    {
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
      env: {
        ...process.env,
        GITNEXUS_LBUG_EXTENSION_INSTALL: "auto",
      },
    },
  );
  const durationMs = performance.now() - started;
  await writeFile(
    logFile,
    [result.stdout, result.stderr].filter(Boolean).join("\n"),
    { mode: 0o600 },
  );
  const resourceText = await readFile(resourceFile, "utf8");
  const storageBytesAfter = await readDirectoryBytes(storageDirectory);
  return {
    durationMs,
    ...parseTimeVerbose(resourceText),
    storageBytesBefore,
    storageBytesAfter,
    logFile,
    resourceFile,
  };
};

export const queryGitNexus = async (input: {
  binary: string;
  indexAlias: string;
  episode: TaskEpisode;
  limit?: number;
}): Promise<{
  output: GitNexusQueryOutput;
  queryText: string;
  taskContext: string;
  durationMs: number;
}> => {
  const queryText = buildGitNexusSearchQuery(input.episode);
  const taskContext = buildGitNexusTaskContext(input.episode);
  const started = performance.now();
  const result = await execFileAsync(
    input.binary,
    [
      "query",
      "-r",
      input.indexAlias,
      "-q",
      queryText,
      "-c",
      taskContext,
      "-g",
      "Find implementation evidence and the likely owning repository subsystem for this coding task",
      "-l",
      String(input.limit ?? 8),
    ],
    {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  const durationMs = performance.now() - started;
  return {
    output: JSON.parse(result.stdout) as GitNexusQueryOutput,
    queryText,
    taskContext,
    durationMs,
  };
};

const likelyAreas = (
  filePath: string,
  symbols: readonly string[],
  cards: readonly AreaCardV1[],
): string[] => {
  const pathLower = filePath.toLowerCase();
  const symbolsLower = symbols.join("\n").toLowerCase();
  return cards
    .map((card) => {
      const pathMatches = card.pathAnchors.filter((anchor) => {
        const normalized = anchor.replace(/^\/+/u, "").toLowerCase();
        return normalized.length >= 2 && pathLower.startsWith(normalized);
      }).length;
      const symbolMatches = card.symbolAnchors.filter((anchor) =>
        symbolsLower.includes(anchor.toLowerCase())
      ).length;
      return { areaId: card.areaId, score: pathMatches * 4 + symbolMatches };
    })
    .filter((item) => item.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score || left.areaId.localeCompare(right.areaId),
    )
    .map((item) => item.areaId)
    .slice(0, 3);
};

const clipLines = (
  text: string,
  startLine: number,
  endLine: number,
  maximumCharacters = 1_240,
): { startLine: number; endLine: number; text: string } => {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  const center = Math.max(0, Math.min(lines.length - 1, startLine - 1));
  const requestedEnd = Math.max(center, Math.min(lines.length - 1, endLine - 1));
  let from = Math.max(0, center - 5);
  let to = Math.min(lines.length, Math.max(requestedEnd + 3, center + 18));
  while (from < to) {
    const value = lines.slice(from, to).join("\n");
    if (value.length <= maximumCharacters) {
      return {
        startLine: from + 1,
        endLine: to,
        text: redactText(value).text,
      };
    }
    if (to - requestedEnd > center - from) to -= 1;
    else from += 1;
  }
  const fallback = lines[center] ?? "";
  return {
    startLine: center + 1,
    endLine: center + 1,
    text: redactText(fallback.slice(0, maximumCharacters)).text,
  };
};

const pathNoisePenalty = (filePath: string): number =>
  /(?:^|\/)(?:testdata|fixtures?|examples?)(?:\/|$)|(?:^|\/)\.changelog|(?:^|\/)changelog|(?:^|\/)zz_generated|\.generated\.|generated\.openapi/iu.test(
    filePath,
  )
    ? 0.15
    : /(?:^|\/)docs?(?:\/|$)/iu.test(filePath)
      ? 0.04
      : 0;

export const materializeGitNexusSnippets = async (input: {
  worktree: string;
  definitions: readonly GitNexusDefinition[];
  cards: readonly AreaCardV1[];
  maximumCandidates?: number;
}): Promise<LunaPerformanceSnippet[]> => {
  const byPath = new Map<string, GitNexusDefinition[]>();
  for (const definition of input.definitions) {
    byPath.set(definition.path, [
      ...(byPath.get(definition.path) ?? []),
      definition,
    ]);
  }
  const ranked = [...byPath.entries()]
    .map(([filePath, definitions]) => {
      const bestRank = Math.min(...definitions.map((item) => item.rawRank));
      return {
        filePath,
        definitions,
        score: 1 / (20 + bestRank) - pathNoisePenalty(filePath),
      };
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.filePath.localeCompare(right.filePath),
    )
    .slice(0, input.maximumCandidates ?? 12);
  const result: LunaPerformanceSnippet[] = [];
  for (const [rank, candidate] of ranked.entries()) {
    const absolute = path.join(input.worktree, candidate.filePath);
    let source: string;
    try {
      source = await readFile(absolute, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const definition = candidate.definitions[0]!;
    const clipped = clipLines(
      source,
      definition.startLine,
      definition.endLine,
    );
    const symbols = [
      ...new Set(
        candidate.definitions
          .map((item) => item.name)
          .filter((name) => name !== path.posix.basename(candidate.filePath)),
      ),
    ].slice(0, 8);
    const reciprocal = 1 / (rank + 1);
    result.push({
      path: candidate.filePath,
      ...clipped,
      symbols,
      likelyAreaIds: likelyAreas(candidate.filePath, symbols, input.cards),
      retrievalReason: [
        "GitNexus local BM25 and code-graph symbol lookup found this definition.",
        definition.module ? `Graph module: ${definition.module}.` : "",
      ]
        .filter(Boolean)
        .join(" "),
      scores: {
        lexical: reciprocal,
        pathSymbol: symbols.length,
        bm25: reciprocal,
        embedding: 0,
        hybrid: candidate.score,
        diversityAdjusted: reciprocal,
      },
    });
  }
  return result;
};

const pathTokens = (filePath: string): Set<string> =>
  new Set(filePath.toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean));

const similarity = (left: string, right: string): number => {
  const a = pathTokens(left);
  const b = pathTokens(right);
  const overlap = [...a].filter((token) => b.has(token)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : overlap / union;
};

const diverseTop = (
  candidates: readonly LunaPerformanceSnippet[],
  scores: ReadonlyMap<string, number>,
  limit: number,
): LunaPerformanceSnippet[] => {
  const remaining = [...candidates];
  const selected: LunaPerformanceSnippet[] = [];
  const maximum = Math.max(...scores.values(), 1e-9);
  while (selected.length < limit && remaining.length > 0) {
    const next = remaining
      .map((candidate) => {
        const redundancy =
          selected.length === 0
            ? 0
            : Math.max(
                ...selected.map((item) =>
                  similarity(candidate.path, item.path)
                ),
              );
        return {
          candidate,
          score:
            0.95 * ((scores.get(candidate.path) ?? 0) / maximum) -
            0.05 * redundancy -
            pathNoisePenalty(candidate.path),
        };
      })
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.candidate.path.localeCompare(right.candidate.path),
      )[0]!;
    selected.push({
      ...next.candidate,
      scores: {
        ...next.candidate.scores,
        diversityAdjusted: next.score,
      },
    });
    remaining.splice(remaining.indexOf(next.candidate), 1);
  }
  return selected;
};

const baseResult = (input: {
  episode: TaskEpisode;
  candidates: LunaPerformanceSnippet[];
  selected: LunaPerformanceSnippet[];
  queryText: string;
  source: GitNexusRetrievalProvenance["source"];
  provenance: GitNexusRetrievalProvenance;
}): GitNexusRetrievalResult => {
  const binding = {
    taskEpisodeId: input.episode.id,
    repositorySnapshot: input.episode.repositorySnapshot,
    source: input.source,
    candidates: input.candidates,
  };
  return {
    schemaVersion: 1,
    specificationVersion: "luna-performance-retrieval-v1",
    taskEpisodeId: input.episode.id,
    repositoryId: input.episode.repositoryId,
    repositorySnapshot: input.episode.repositorySnapshot,
    variant: "hybrid_rerank",
    querySource: "task_aware_context",
    candidates: input.candidates,
    selected: input.selected,
    safeguards: {
      exactPreTaskSnapshot: true,
      taskAwareContextOnly: true,
      labelsReadDuringRetrieval: false,
      changedPathsRead: false,
      postTaskDiffRead: false,
    },
    provenance: {
      candidatePoolSize: input.candidates.length,
      selectedFiles: input.selected.length,
      querySha256: sha256(input.queryText),
      resultSha256: contentHash(binding),
      embeddingInputTokens: 0,
    },
    gitNexusProvenance: input.provenance,
  };
};

export const buildGitNexusOnlyResult = (input: {
  episode: TaskEpisode;
  snippets: LunaPerformanceSnippet[];
  provenance: Omit<GitNexusRetrievalProvenance, "source">;
}): GitNexusRetrievalResult => {
  const candidates = [...input.snippets]
    .sort(
      (left, right) =>
        right.scores.lexical -
          pathNoisePenalty(right.path) -
          (left.scores.lexical - pathNoisePenalty(left.path)) ||
        left.path.localeCompare(right.path),
    )
    .slice(0, 12);
  const scores = new Map(
    candidates.map((candidate, index) => [
      candidate.path,
      1 / (60 + index + 1),
    ]),
  );
  return baseResult({
    episode: input.episode,
    candidates,
    selected: diverseTop(candidates, scores, 8),
    queryText: input.provenance.queryText,
    source: "gitnexus_only",
    provenance: {
      ...input.provenance,
      source: "gitnexus_only",
    },
  });
};

export const fuseCurrentHybridWithGitNexus = (input: {
  episode: TaskEpisode;
  current: LunaPerformanceRetrievalResult;
  gitNexus: GitNexusRetrievalResult;
}): GitNexusRetrievalResult => {
  const byPath = new Map<string, LunaPerformanceSnippet>();
  const currentRank = new Map<string, number>();
  const gitNexusRank = new Map<string, number>();
  input.current.candidates.forEach((candidate, index) => {
    currentRank.set(candidate.path, index + 1);
    byPath.set(candidate.path, candidate);
  });
  input.gitNexus.candidates.forEach((candidate, index) => {
    gitNexusRank.set(candidate.path, index + 1);
    const existing = byPath.get(candidate.path);
    byPath.set(
      candidate.path,
      existing
        ? {
            ...candidate,
            symbols: [...new Set([...candidate.symbols, ...existing.symbols])],
            likelyAreaIds: [
              ...new Set([
                ...candidate.likelyAreaIds,
                ...existing.likelyAreaIds,
              ]),
            ],
          }
        : candidate,
    );
  });
  const scores = new Map<string, number>();
  for (const filePath of byPath.keys()) {
    scores.set(
      filePath,
      (currentRank.has(filePath)
        ? 1 / (60 + currentRank.get(filePath)!)
        : 0) +
        (gitNexusRank.has(filePath)
          ? 1.2 / (60 + gitNexusRank.get(filePath)!)
          : 0),
    );
  }
  const candidates = [...byPath.values()]
    .sort(
      (left, right) =>
        (scores.get(right.path) ?? 0) - (scores.get(left.path) ?? 0) ||
        left.path.localeCompare(right.path),
    )
    .slice(0, 12)
    .map((candidate) => ({
      ...candidate,
      retrievalReason: [
        currentRank.has(candidate.path)
          ? `Current hybrid rank ${currentRank.get(candidate.path)}.`
          : "",
        gitNexusRank.has(candidate.path)
          ? `GitNexus graph/BM25 rank ${gitNexusRank.get(candidate.path)}.`
          : "",
        `Fused with ${GITNEXUS_FUSION_VERSION}.`,
      ]
        .filter(Boolean)
        .join(" "),
      scores: {
        ...candidate.scores,
        hybrid: scores.get(candidate.path) ?? 0,
      },
    }));
  return baseResult({
    episode: input.episode,
    candidates,
    selected: diverseTop(candidates, scores, 8),
    queryText: input.gitNexus.gitNexusProvenance.queryText,
    source: "current_hybrid_plus_gitnexus",
    provenance: {
      ...input.gitNexus.gitNexusProvenance,
      source: "current_hybrid_plus_gitnexus",
      fusionVersion: GITNEXUS_FUSION_VERSION,
    },
  });
};
