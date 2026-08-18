#!/usr/bin/env node

import { execFile } from "node:child_process";
import {
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  analyzeWithGitNexus,
  buildGitNexusOnlyResult,
  fuseCurrentHybridWithGitNexus,
  GITNEXUS_VERSION,
  materializeGitNexusSnippets,
  parseGitNexusDefinitions,
  queryGitNexus,
  type GitNexusRetrievalProvenance,
} from "./gitnexus-retrieval-experiment.ts";
import { contentHash } from "./hash.ts";
import { readJsonl } from "./jsonl.ts";
import {
  evaluateLunaPerformanceRetrieval,
  type LunaPerformanceRetrievalResult,
} from "./luna-performance-retrieval.ts";
import type {
  AreaCardV1,
  SilverLabelV1,
  TaskEpisode,
} from "./types.ts";

const execFileAsync = promisify(execFile);

interface RepositoryExperimentConfig {
  repositoryId: string;
  repository: string;
  profile: string;
  areas: string;
  publicEpisodes?: string;
  publicOfflineEvidence?: string;
}

interface PerformanceExperimentConfig {
  schemaVersion: 1;
  episodes: string;
  labels: string;
  developmentEpisodeIds: string[];
  repositories: RepositoryExperimentConfig[];
}

const parseArguments = (
  argv: readonly string[],
): { command: string; values: Map<string, string> } => {
  const command = argv[0];
  if (!command) throw new Error("Missing command");
  const values = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 1) {
    const item = argv[index]!;
    if (!item.startsWith("--")) throw new Error(`Unexpected argument ${item}`);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      throw new Error(`Missing value for ${item}`);
    }
    values.set(item, next);
    index += 1;
  }
  return { command, values };
};

const required = (
  args: ReturnType<typeof parseArguments>,
  name: string,
): string => {
  const value = args.values.get(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};

const exists = async (file: string): Promise<boolean> => {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

const writeAtomic = async (file: string, value: unknown): Promise<void> => {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, file);
};

const readConfig = async (file: string): Promise<PerformanceExperimentConfig> =>
  JSON.parse(await readFile(path.resolve(file), "utf8")) as PerformanceExperimentConfig;

const checkoutSnapshot = async (input: {
  sourceRepository: string;
  worktree: string;
  snapshot: string;
}): Promise<void> => {
  if (!(await exists(path.join(input.worktree, ".git")))) {
    await mkdir(path.dirname(input.worktree), { recursive: true });
    await execFileAsync(
      "git",
      [
        "-C",
        input.sourceRepository,
        "worktree",
        "add",
        "--detach",
        input.worktree,
        input.snapshot,
      ],
      { maxBuffer: 64 * 1024 * 1024 },
    );
  } else {
    await execFileAsync(
      "git",
      ["-C", input.worktree, "checkout", "--detach", "--force", input.snapshot],
      { maxBuffer: 64 * 1024 * 1024 },
    );
  }
  const actual = (
    await execFileAsync("git", ["-C", input.worktree, "rev-parse", "HEAD"], {
      encoding: "utf8",
    })
  ).stdout.trim();
  if (actual !== input.snapshot) {
    throw new Error(`Snapshot mismatch: expected ${input.snapshot}, got ${actual}`);
  }
};

const commitTimestamp = async (
  repository: string,
  snapshot: string,
): Promise<number> => {
  const output = (
    await execFileAsync(
      "git",
      ["-C", repository, "show", "-s", "--format=%ct", snapshot],
      { encoding: "utf8" },
    )
  ).stdout.trim();
  return Number(output);
};

const retrievalFile = (
  directory: string,
  episodeId: string,
): string =>
  path.join(directory, "retrieval", "hybrid_rerank", `${episodeId}.json`);

const runMaterialization = async (
  args: ReturnType<typeof parseArguments>,
): Promise<void> => {
  const configFile = path.resolve(required(args, "--config"));
  const config = await readConfig(configFile);
  const outputDirectory = path.resolve(required(args, "--output-directory"));
  const baselineDirectory = path.resolve(required(args, "--baseline-retrieval-directory"));
  const worktreeRoot = path.resolve(required(args, "--worktree-root"));
  const binary = path.resolve(required(args, "--gitnexus-binary"));
  const development = new Set(config.developmentEpisodeIds);
  const requestedEpisodeIds = args.values.get("--episode-ids");
  const requested = requestedEpisodeIds
    ? new Set(
        requestedEpisodeIds
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
      )
    : undefined;
  const allEpisodes = await readJsonl<TaskEpisode>(path.resolve(config.episodes));
  const episodes = allEpisodes.filter(
    (episode) =>
      development.has(episode.id) &&
      (!requested || requested.has(episode.id)),
  );
  if (requested && episodes.length !== requested.size) {
    throw new Error(
      `Requested ${requested.size} episode IDs but found ${episodes.length}`,
    );
  }
  const repositoryById = new Map(
    config.repositories.map((repository) => [
      repository.repositoryId,
      repository,
    ]),
  );
  const cardsById = new Map<string, AreaCardV1[]>();
  for (const repository of config.repositories) {
    cardsById.set(
      repository.repositoryId,
      await readJsonl<AreaCardV1>(path.resolve(repository.areas)),
    );
  }
  const scheduled = await Promise.all(
    episodes.map(async (episode) => {
      const repository = repositoryById.get(episode.repositoryId);
      if (!repository) throw new Error(`Unknown repository ${episode.repositoryId}`);
      return {
        episode,
        repository,
        commitTimestamp: await commitTimestamp(
          repository.repository,
          episode.repositorySnapshot,
        ),
      };
    }),
  );
  scheduled.sort(
    (left, right) =>
      left.repository.repositoryId.localeCompare(right.repository.repositoryId) ||
      left.commitTimestamp - right.commitTimestamp ||
      left.episode.id.localeCompare(right.episode.id),
  );
  if (!(await exists(path.join(outputDirectory, "manifest.json")))) {
    await writeAtomic(path.join(outputDirectory, "manifest.json"), {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      gitNexusVersion: GITNEXUS_VERSION,
      config: configFile,
      configHash: contentHash(config),
      developmentCases: config.developmentEpisodeIds.length,
      ordering: "repository_then_exact_commit_timestamp",
      semanticVectorSearchAvailable: false,
      labelsReadDuringRetrieval: false,
      taskAwareContextOnly: true,
    });
  }
  for (const [index, item] of scheduled.entries()) {
    const gitNexusOutput = retrievalFile(
      path.join(outputDirectory, "gitnexus-only"),
      item.episode.id,
    );
    const fusionOutput = retrievalFile(
      path.join(outputDirectory, "fusion"),
      item.episode.id,
    );
    if ((await exists(gitNexusOutput)) && (await exists(fusionOutput))) {
      console.error(JSON.stringify({
        skipped: item.episode.id,
        completed: index + 1,
        total: scheduled.length,
      }));
      continue;
    }
    const slug = item.repository.repositoryId.replaceAll("/", "-");
    const worktree = path.join(worktreeRoot, slug);
    const suffix = args.values.get("--index-alias-suffix") ?? "";
    if (suffix && !/^[a-z0-9-]+$/u.test(suffix)) {
      throw new Error("Unsafe --index-alias-suffix");
    }
    const indexAlias = `experiment-${slug}${suffix ? `-${suffix}` : ""}`;
    await checkoutSnapshot({
      sourceRepository: item.repository.repository,
      worktree,
      snapshot: item.episode.repositorySnapshot,
    });
    const perEpisodeArtifacts = path.join(
      outputDirectory,
      "gitnexus-runtime",
      item.episode.id,
    );
    const analyze = await analyzeWithGitNexus(
      {
        binary,
        repository: worktree,
        indexAlias,
        artifactDirectory: perEpisodeArtifacts,
        workers: Number(args.values.get("--workers") ?? "3"),
      },
      item.episode.repositorySnapshot,
    );
    const query = await queryGitNexus({
      binary,
      indexAlias,
      episode: item.episode,
      limit: 8,
    });
    await writeAtomic(path.join(perEpisodeArtifacts, "query-output.json"), query.output);
    const definitions = parseGitNexusDefinitions(query.output);
    const snippets = await materializeGitNexusSnippets({
      worktree,
      definitions,
      cards: cardsById.get(item.episode.repositoryId) ?? [],
      maximumCandidates: 12,
    });
    const provenance: Omit<GitNexusRetrievalProvenance, "source"> = {
      experimentVersion: "gitnexus-retrieval-experiment-v1",
      gitNexusVersion: GITNEXUS_VERSION,
      indexAlias,
      exactSnapshotSha: item.episode.repositorySnapshot,
      queryText: query.queryText,
      querySha256: contentHash(query.queryText),
      taskAwareContextSha256: contentHash(query.taskContext),
      queryDurationMs: query.durationMs,
      queryTiming: query.output.timing,
      analyze,
      graphProcessesReturned: query.output.processes?.length ?? 0,
      graphDefinitionsReturned: definitions.length,
      uniqueDefinitionPaths: new Set(definitions.map((item) => item.path)).size,
      semanticVectorSearchAvailable: false,
      labelsReadDuringRetrieval: false,
      changedPathsRead: false,
      postTaskStateRead: false,
    };
    const gitNexus = buildGitNexusOnlyResult({
      episode: item.episode,
      snippets,
      provenance,
    });
    const current = JSON.parse(
      await readFile(
        retrievalFile(baselineDirectory, item.episode.id),
        "utf8",
      ),
    ) as LunaPerformanceRetrievalResult;
    if (current.repositorySnapshot !== item.episode.repositorySnapshot) {
      throw new Error(`Baseline snapshot mismatch for ${item.episode.id}`);
    }
    const fusion = fuseCurrentHybridWithGitNexus({
      episode: item.episode,
      current,
      gitNexus,
    });
    await writeAtomic(gitNexusOutput, gitNexus);
    await writeAtomic(fusionOutput, fusion);
    console.error(JSON.stringify({
      completed: index + 1,
      total: scheduled.length,
      episodeId: item.episode.id,
      repositoryId: item.episode.repositoryId,
      snapshot: item.episode.repositorySnapshot,
      definitions: definitions.length,
      paths: gitNexus.candidates.length,
      analyzeMs: analyze.durationMs,
      queryMs: query.durationMs,
    }));
  }
};

const prepareDevelopment = async (
  args: ReturnType<typeof parseArguments>,
): Promise<void> => {
  const config = await readConfig(required(args, "--config"));
  const directory = path.resolve(required(args, "--output-directory"));
  const development = new Set(config.developmentEpisodeIds);
  const episodes = (await readJsonl<TaskEpisode>(path.resolve(config.episodes)))
    .filter((episode) => development.has(episode.id));
  const labels = (await readJsonl<SilverLabelV1>(path.resolve(config.labels)))
    .filter((label) => development.has(label.taskEpisodeId));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(directory, "episodes.jsonl"),
    `${episodes.map((episode) => JSON.stringify(episode)).join("\n")}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    path.join(directory, "labels.jsonl"),
    `${labels.map((label) => JSON.stringify(label)).join("\n")}\n`,
    { mode: 0o600 },
  );
  const developmentConfig: PerformanceExperimentConfig = {
    ...config,
    episodes: path.join(directory, "episodes.jsonl"),
    labels: path.join(directory, "labels.jsonl"),
    developmentEpisodeIds: episodes.map((episode) => episode.id),
  };
  await writeAtomic(path.join(directory, "performance-config.json"), developmentConfig);
  const arms = (source: string) => ({
    schemaVersion: 1,
    description: `${source}: compare direct and evidence-first Luna on the 24 burned development cases.`,
    arms: [
      {
        id: `${source}_direct`,
        retrievalVariant: "hybrid_rerank",
        evidencePresentation: "eight_short",
        areaCardVariant: "enriched",
        inferenceStrategy: "direct",
        seeds: [181081],
      },
      {
        id: `${source}_evidence_first`,
        retrievalVariant: "hybrid_rerank",
        evidencePresentation: "eight_short",
        areaCardVariant: "enriched",
        inferenceStrategy: "evidence_first",
        seeds: [181081],
      },
    ],
  });
  await writeAtomic(path.join(directory, "matrix-gitnexus-only.json"), arms("gitnexus_only"));
  await writeAtomic(path.join(directory, "matrix-fusion.json"), arms("fusion"));
  console.log(JSON.stringify({
    ok: true,
    cases: episodes.length,
    config: path.join(directory, "performance-config.json"),
  }, null, 2));
};

const analyzeRetrieval = async (
  args: ReturnType<typeof parseArguments>,
): Promise<void> => {
  const config = await readConfig(required(args, "--config"));
  const development = new Set(config.developmentEpisodeIds);
  const episodes = (await readJsonl<TaskEpisode>(path.resolve(config.episodes)))
    .filter((episode) => development.has(episode.id));
  const labels = (await readJsonl<SilverLabelV1>(path.resolve(config.labels)))
    .filter((label) => development.has(label.taskEpisodeId));
  const outputDirectory = path.resolve(required(args, "--output-directory"));
  const readResults = async (root: string) =>
    Promise.all(
      episodes.map(async (episode) =>
        JSON.parse(
          await readFile(retrievalFile(root, episode.id), "utf8"),
        ) as LunaPerformanceRetrievalResult
      ),
    );
  const baseline = await readResults(path.resolve(required(args, "--baseline-retrieval-directory")));
  const gitNexus = await readResults(path.join(outputDirectory, "gitnexus-only"));
  const fusion = await readResults(path.join(outputDirectory, "fusion"));
  const diagnostics = (results: LunaPerformanceRetrievalResult[]) => ({
    oraclePaths: evaluateLunaPerformanceRetrieval({ results, labels }),
    meanUniquePaths:
      results.reduce(
        (sum, result) =>
          sum + new Set(result.selected.map((item) => item.path)).size,
        0,
      ) / results.length,
    testOrDocNoiseRate:
      results.reduce(
        (sum, result) =>
          sum +
          result.selected.filter((item) =>
            /(?:^|\/)(?:test|tests|docs?|examples?|fixtures?)(?:\/|$)|(?:_test|\.test|\.spec)\.[^/]+$/iu.test(
              item.path,
            )
          ).length,
        0,
      ) / results.reduce((sum, result) => sum + result.selected.length, 0),
  });
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    cases: episodes.length,
    baseline: diagnostics(baseline),
    gitNexusOnly: diagnostics(gitNexus),
    fusion: diagnostics(fusion),
  };
  await writeAtomic(path.resolve(required(args, "--analysis-output")), report);
  console.log(JSON.stringify(report, null, 2));
};

const reselectMaterialized = async (
  args: ReturnType<typeof parseArguments>,
): Promise<void> => {
  const config = await readConfig(required(args, "--config"));
  const development = new Set(config.developmentEpisodeIds);
  const episodes = (await readJsonl<TaskEpisode>(path.resolve(config.episodes)))
    .filter((episode) => development.has(episode.id));
  const outputDirectory = path.resolve(required(args, "--output-directory"));
  const baselineDirectory = path.resolve(
    required(args, "--baseline-retrieval-directory"),
  );
  for (const episode of episodes) {
    const gitNexusFile = retrievalFile(
      path.join(outputDirectory, "gitnexus-only"),
      episode.id,
    );
    if (!(await exists(gitNexusFile))) continue;
    const existing = JSON.parse(
      await readFile(gitNexusFile, "utf8"),
    ) as import("./gitnexus-retrieval-experiment.ts").GitNexusRetrievalResult;
    const { source: _source, fusionVersion: _fusionVersion, ...provenance } =
      existing.gitNexusProvenance;
    const gitNexus = buildGitNexusOnlyResult({
      episode,
      snippets: existing.candidates,
      provenance,
    });
    const current = JSON.parse(
      await readFile(retrievalFile(baselineDirectory, episode.id), "utf8"),
    ) as LunaPerformanceRetrievalResult;
    const fusion = fuseCurrentHybridWithGitNexus({
      episode,
      current,
      gitNexus,
    });
    await writeAtomic(gitNexusFile, gitNexus);
    await writeAtomic(
      retrievalFile(path.join(outputDirectory, "fusion"), episode.id),
      fusion,
    );
  }
  console.log(JSON.stringify({ ok: true, cases: episodes.length }, null, 2));
};

const main = async (): Promise<void> => {
  const args = parseArguments(process.argv.slice(2));
  if (args.command === "prepare-development") return prepareDevelopment(args);
  if (args.command === "materialize") return runMaterialization(args);
  if (args.command === "reselect") return reselectMaterialized(args);
  if (args.command === "analyze-retrieval") return analyzeRetrieval(args);
  throw new Error(
    "Usage: gitnexus-retrieval-experiment-cli <prepare-development|materialize|reselect|analyze-retrieval> ...",
  );
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
