#!/usr/bin/env node

import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { BudgetLedger } from "./budget.ts";
import {
  estimateTokens,
  fetchEmbeddingModelPrices,
  fetchModelPrices,
  maximumCallCost,
  type ModelPrice,
} from "./cost.ts";
import { EmbeddingCache } from "./embedding-cache.ts";
import { contentHash } from "./hash.ts";
import { readJsonl } from "./jsonl.ts";
import {
  analyzeLunaRetrievalClassificationFailures,
  buildEnrichedAreaCards,
  classifyLunaPerformanceCase,
  ensembleLunaDistributionalPredictions,
  fitLunaTemperatureCalibration,
  applyLunaTemperatureCalibration,
  summarizeLunaPerformanceArm,
  type LunaEvidencePresentation,
  type LunaInferenceStrategy,
  type LunaPerformanceClassificationRecord,
} from "./luna-performance-experiment.ts";
import {
  evaluateLunaPerformanceRetrieval,
  LUNA_PERFORMANCE_EMBEDDING_MODEL,
  LUNA_PERFORMANCE_RETRIEVAL_VARIANTS,
  retrieveLunaPerformanceEvidence,
  type LunaGeneratedRepositoryQuery,
  type LunaPerformanceRetrievalResult,
  type LunaPerformanceRetrievalVariant,
} from "./luna-performance-retrieval.ts";
import {
  callLunaOpenRouter,
  type LunaProviderCallResult,
} from "./luna-bounded-tool-harness.ts";
import {
  LUNA_ACCURACY_MODEL,
} from "./luna-accuracy-openrouter.ts";
import { serializeLunaAccuracyTaskContext } from "./luna-accuracy-context.ts";
import {
  getOpenRouterKeyStatus,
} from "./openrouter.ts";
import type {
  AreaCardV1,
  RepositoryProfileV1,
  SilverLabelV1,
  TaskEpisode,
} from "./types.ts";
import {
  validateAreaCards,
  validateRepositoryProfile,
} from "./validation.ts";

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

interface ClassificationArm {
  id: string;
  retrievalVariant: LunaPerformanceRetrievalVariant;
  evidencePresentation: LunaEvidencePresentation;
  areaCardVariant: "baseline" | "enriched";
  inferenceStrategy: LunaInferenceStrategy;
  seeds: number[];
}

interface ClassificationMatrix {
  schemaVersion: 1;
  description?: string;
  arms: ClassificationArm[];
}

interface RepositoryResources {
  config: RepositoryExperimentConfig;
  profile: RepositoryProfileV1;
  baselineCards: AreaCardV1[];
  enrichedCards: AreaCardV1[];
}

interface QueryRecord {
  schemaVersion: 1;
  taskEpisodeId: string;
  query: LunaGeneratedRepositoryQuery;
  call: {
    durationMs: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
    costUsd: number;
  };
  promptSha256: string;
}

const parseArguments = (
  argv: readonly string[],
): { command: string; values: Map<string, string>; flags: Set<string> } => {
  const command = argv[0];
  if (!command) throw new Error("Missing command");
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 1; index < argv.length; index += 1) {
    const item = argv[index]!;
    if (!item.startsWith("--")) throw new Error(`Unexpected argument ${item}`);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      flags.add(item);
    } else {
      values.set(item, next);
      index += 1;
    }
  }
  return { command, values, flags };
};

const required = (
  args: ReturnType<typeof parseArguments>,
  name: string,
): string => {
  const found = args.values.get(name);
  if (!found) throw new Error(`Missing ${name}`);
  return found;
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

const readConfig = async (file: string): Promise<PerformanceExperimentConfig> => {
  const config = JSON.parse(
    await readFile(path.resolve(file), "utf8"),
  ) as PerformanceExperimentConfig;
  if (
    config.schemaVersion !== 1 ||
    !Array.isArray(config.repositories) ||
    config.repositories.length < 1 ||
    !Array.isArray(config.developmentEpisodeIds)
  ) {
    throw new Error("Invalid performance experiment config");
  }
  return config;
};

const referenceExamples = async (
  repository: RepositoryExperimentConfig,
  excludedIds: ReadonlySet<string>,
): Promise<Record<string, string[]>> => {
  if (!repository.publicEpisodes || !repository.publicOfflineEvidence) {
    return {};
  }
  const episodes = await readJsonl<TaskEpisode>(
    path.resolve(repository.publicEpisodes),
  );
  const evidence = await readJsonl<{
    taskEpisodeId: string;
    mappedAreaIds: string[];
    samplingKind: string;
  }>(path.resolve(repository.publicOfflineEvidence));
  const episodeById = new Map(episodes.map((episode) => [episode.id, episode]));
  const result: Record<string, string[]> = {};
  for (const item of evidence) {
    if (
      item.samplingKind !== "known" ||
      excludedIds.has(item.taskEpisodeId)
    ) {
      continue;
    }
    const episode = episodeById.get(item.taskEpisodeId);
    if (!episode || episode.split !== "reference") continue;
    for (const areaId of item.mappedAreaIds) {
      result[areaId] = [
        ...(result[areaId] ?? []),
        episode.currentRequest,
      ];
    }
  }
  return result;
};

const loadResources = async (
  config: PerformanceExperimentConfig,
  episodeIds: ReadonlySet<string>,
): Promise<Map<string, RepositoryResources>> => {
  const result = new Map<string, RepositoryResources>();
  for (const repository of config.repositories) {
    const profile = JSON.parse(
      await readFile(path.resolve(repository.profile), "utf8"),
    ) as RepositoryProfileV1;
    const baselineCards = await readJsonl<AreaCardV1>(
      path.resolve(repository.areas),
    );
    validateRepositoryProfile(profile);
    validateAreaCards(baselineCards, profile, {
      requirePositiveExamples: false,
    });
    const examples = await referenceExamples(repository, episodeIds);
    const enrichedCards = buildEnrichedAreaCards({
      cards: baselineCards,
      referenceExamplesByArea: examples,
    });
    result.set(repository.repositoryId, {
      config: repository,
      profile,
      baselineCards,
      enrichedCards,
    });
  }
  return result;
};

const retrievalFile = (
  outputDirectory: string,
  variant: LunaPerformanceRetrievalVariant,
  episodeId: string,
): string =>
  path.join(outputDirectory, "retrieval", variant, `${episodeId}.json`);

const queryFile = (outputDirectory: string, episodeId: string): string =>
  path.join(outputDirectory, "queries", `${episodeId}.json`);

const classificationFile = (
  outputDirectory: string,
  armId: string,
  seed: number,
  episodeId: string,
): string =>
  path.join(
    outputDirectory,
    "classification",
    armId,
    String(seed),
    `${episodeId}.json`,
  );

const querySchema = {
  type: "object",
  additionalProperties: false,
  required: ["search_queries", "identifiers", "path_hints"],
  properties: {
    search_queries: {
      type: "array",
      minItems: 1,
      maxItems: 3,
      items: { type: "string", minLength: 2, maxLength: 240 },
    },
    identifiers: {
      type: "array",
      maxItems: 10,
      items: { type: "string", minLength: 1, maxLength: 120 },
    },
    path_hints: {
      type: "array",
      maxItems: 8,
      items: { type: "string", minLength: 1, maxLength: 160 },
    },
  },
} as const;

const parseQuery = (content: string): LunaGeneratedRepositoryQuery => {
  const raw = JSON.parse(content) as {
    search_queries?: unknown;
    identifiers?: unknown;
    path_hints?: unknown;
  };
  if (
    !Array.isArray(raw.search_queries) ||
    raw.search_queries.length < 1 ||
    raw.search_queries.some((item) => typeof item !== "string") ||
    !Array.isArray(raw.identifiers) ||
    raw.identifiers.some((item) => typeof item !== "string") ||
    !Array.isArray(raw.path_hints) ||
    raw.path_hints.some((item) => typeof item !== "string")
  ) {
    throw new Error("Invalid generated repository query");
  }
  return {
    searchQueries: [...new Set(raw.search_queries as string[])],
    identifiers: [...new Set(raw.identifiers as string[])],
    pathHints: [...new Set(raw.path_hints as string[])],
  };
};

const generateQuery = async (input: {
  episode: TaskEpisode;
  profile: RepositoryProfileV1;
  price: ModelPrice;
  seed: number;
}): Promise<QueryRecord> => {
  const taskContext = serializeLunaAccuracyTaskContext(
    input.episode,
    input.profile,
    "labeled_sections",
    "6k",
    "components",
  );
  const system = [
    "You generate a small deterministic-retrieval query for a coding task.",
    "Do not classify the task, choose an area, or invent exact repository paths.",
    "Use the complete task-aware context. Produce one to three concise search queries, likely code identifiers, and optional path fragments that would help a lexical or BM25 retriever find implementation evidence.",
    "Prefer concrete nouns, symbols, error strings, APIs, configuration keys, and behavior descriptions. Avoid broad words such as fix, change, code, feature, frontend, or backend unless part of a concrete identifier.",
    "Return strict JSON and no prose.",
  ].join("\n");
  const user = [
    "[REPOSITORY PROFILE AND TASK-AWARE CONTEXT]",
    taskContext,
  ].join("\n");
  const call = await callLunaOpenRouter({
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    seed: input.seed,
    maxTokens: 2_048,
    price: input.price,
    responseSchema: querySchema,
    options: {},
  });
  if (!call.message.content) throw new Error("Luna returned no query");
  const query = parseQuery(call.message.content);
  return {
    schemaVersion: 1,
    taskEpisodeId: input.episode.id,
    query,
    call: {
      durationMs: call.durationMs,
      inputTokens: call.usage.inputTokens,
      cachedInputTokens: call.usage.cachedInputTokens,
      outputTokens: call.usage.outputTokens,
      reasoningOutputTokens: call.usage.reasoningOutputTokens,
      costUsd: call.usage.costUsd,
    },
    promptSha256: contentHash({ system, user }),
  };
};

const readQueryRecord = async (
  outputDirectory: string,
  episodeId: string,
): Promise<QueryRecord | undefined> => {
  const file = queryFile(outputDirectory, episodeId);
  if (!(await exists(file))) return undefined;
  return JSON.parse(await readFile(file, "utf8")) as QueryRecord;
};

const totalRetrievalCost = async (
  outputDirectory: string,
  embeddingPrice: ModelPrice,
): Promise<number> => {
  let total = 0;
  const queryDirectory = path.join(outputDirectory, "queries");
  if (await exists(queryDirectory)) {
    for (const file of await readdir(queryDirectory)) {
      if (!file.endsWith(".json")) continue;
      const record = JSON.parse(
        await readFile(path.join(queryDirectory, file), "utf8"),
      ) as QueryRecord;
      total += record.call.costUsd;
    }
  }
  const retrievalRoot = path.join(outputDirectory, "retrieval");
  if (await exists(retrievalRoot)) {
    for (const variant of await readdir(retrievalRoot)) {
      for (const file of await readdir(path.join(retrievalRoot, variant))) {
        if (!file.endsWith(".json")) continue;
        const record = JSON.parse(
          await readFile(path.join(retrievalRoot, variant, file), "utf8"),
        ) as LunaPerformanceRetrievalResult;
        total += maximumCallCost(
          embeddingPrice,
          record.provenance.embeddingInputTokens,
          0,
        );
      }
    }
  }
  return total;
};

const runRetrieval = async (
  args: ReturnType<typeof parseArguments>,
): Promise<void> => {
  if (!args.flags.has("--confirm-external-run")) {
    throw new Error("Refusing external retrieval calls without confirmation");
  }
  const config = await readConfig(required(args, "--config"));
  const outputDirectory = path.resolve(required(args, "--output-directory"));
  const episodes = await readJsonl<TaskEpisode>(path.resolve(config.episodes));
  const episodeIds = new Set(episodes.map((episode) => episode.id));
  const resources = await loadResources(config, episodeIds);
  const variants = (
    args.values.get("--variants")?.split(",").filter(Boolean) ??
    [...LUNA_PERFORMANCE_RETRIEVAL_VARIANTS]
  ) as LunaPerformanceRetrievalVariant[];
  if (
    variants.some(
      (variant) =>
        !LUNA_PERFORMANCE_RETRIEVAL_VARIANTS.includes(variant),
    )
  ) {
    throw new Error("Invalid retrieval variant");
  }
  const modelPrices = await fetchModelPrices();
  const lunaPrice = modelPrices.get(LUNA_ACCURACY_MODEL);
  const embeddingPrices = await fetchEmbeddingModelPrices();
  const embeddingPrice = embeddingPrices.get(
    LUNA_PERFORMANCE_EMBEDDING_MODEL,
  );
  if (!lunaPrice || !embeddingPrice) throw new Error("Missing model price");
  const maximumCostUsd = Number(required(args, "--maximum-cost-usd"));
  const previouslyRecordedCostUsd = await totalRetrievalCost(
    outputDirectory,
    embeddingPrice,
  );
  const ledger = new BudgetLedger(
    path.resolve(
      args.values.get("--budget-ledger") ?? "artifacts/global-budget.json",
    ),
    200,
  );
  await ledger.reserve(maximumCostUsd);
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const manifest = {
    schemaVersion: 1,
    command: "retrieve",
    createdAt: new Date().toISOString(),
    cases: episodes.length,
    variants,
    model: LUNA_ACCURACY_MODEL,
    embeddingModel: LUNA_PERFORMANCE_EMBEDDING_MODEL,
    maximumCostUsd,
    datasetHash: contentHash(episodes),
  };
  if (!(await exists(path.join(outputDirectory, "retrieval-manifest.json")))) {
    await writeAtomic(
      path.join(outputDirectory, "retrieval-manifest.json"),
      manifest,
    );
  }
  const before = await getOpenRouterKeyStatus();
  const sharedContext = {
    embeddingCache: new EmbeddingCache(
      path.resolve(
        args.values.get("--embedding-cache") ??
          "data/private/luna-performance-embedding-cache",
      ),
    ),
    treeCache: new Map(),
    blobCache: new Map(),
    baselineCache: new Map(),
  };
  let settled = false;
  try {
    for (const [index, episode] of episodes.entries()) {
      const repository = resources.get(episode.repositoryId);
      if (!repository) {
        throw new Error(`No repository config for ${episode.repositoryId}`);
      }
      let queryRecord = await readQueryRecord(outputDirectory, episode.id);
      if (variants.includes("luna_query") && !queryRecord) {
        queryRecord = await generateQuery({
          episode,
          profile: repository.profile,
          price: lunaPrice,
          seed: 917_381,
        });
        await writeAtomic(queryFile(outputDirectory, episode.id), queryRecord);
      }
      for (const variant of variants) {
        const file = retrievalFile(outputDirectory, variant, episode.id);
        if (await exists(file)) continue;
        const result = await retrieveLunaPerformanceEvidence({
          repository: repository.config.repository,
          episode,
          cards: repository.baselineCards,
          variant,
          context: sharedContext,
          ...(variant === "luna_query"
            ? { generatedQuery: queryRecord!.query }
            : {}),
        });
        await writeAtomic(file, result);
      }
      console.error(
        JSON.stringify({
          completedCases: index + 1,
          cases: episodes.length,
          episodeId: episode.id,
        }),
      );
    }
    const artifactTotalCostUsd = await totalRetrievalCost(
      outputDirectory,
      embeddingPrice,
    );
    const incrementalCostUsd = Math.max(
      0,
      artifactTotalCostUsd - previouslyRecordedCostUsd,
    );
    await ledger.settle(maximumCostUsd, incrementalCostUsd);
    settled = true;
    const after = await getOpenRouterKeyStatus();
    await writeAtomic(path.join(outputDirectory, "retrieval-cost.json"), {
      schemaVersion: 1,
      maximumCostUsd,
      previouslyRecordedCostUsd,
      incrementalCostUsd,
      artifactTotalCostUsd,
      keyStatusBefore: before,
      keyStatusAfter: after,
    });
    console.log(
      JSON.stringify({
        ok: true,
        cases: episodes.length,
        previouslyRecordedCostUsd,
        incrementalCostUsd,
        artifactTotalCostUsd,
      }, null, 2),
    );
  } catch (error) {
    if (!settled) {
      const artifactTotalCostUsd = await totalRetrievalCost(
        outputDirectory,
        embeddingPrice,
      );
      await ledger.settle(
        maximumCostUsd,
        Math.max(0, artifactTotalCostUsd - previouslyRecordedCostUsd),
      );
    }
    throw error;
  }
};

const readMatrix = async (file: string): Promise<ClassificationMatrix> => {
  const matrix = JSON.parse(
    await readFile(path.resolve(file), "utf8"),
  ) as ClassificationMatrix;
  if (
    matrix.schemaVersion !== 1 ||
    !Array.isArray(matrix.arms) ||
    matrix.arms.length < 1
  ) {
    throw new Error("Invalid classification matrix");
  }
  const ids = new Set<string>();
  for (const arm of matrix.arms) {
    if (ids.has(arm.id)) throw new Error(`Duplicate arm ${arm.id}`);
    ids.add(arm.id);
    if (
      !LUNA_PERFORMANCE_RETRIEVAL_VARIANTS.includes(
        arm.retrievalVariant,
      ) ||
      arm.seeds.length < 1 ||
      new Set(arm.seeds).size !== arm.seeds.length
    ) {
      throw new Error(`Invalid arm ${arm.id}`);
    }
  }
  return matrix;
};

const classificationCost = async (
  outputDirectory: string,
  jobs: readonly {
    armId: string;
    seed: number;
    episodeId: string;
  }[],
): Promise<number> => {
  let total = 0;
  for (const job of jobs) {
    const file = classificationFile(
      outputDirectory,
      job.armId,
      job.seed,
      job.episodeId,
    );
    if (!(await exists(file))) continue;
    const record = JSON.parse(
      await readFile(file, "utf8"),
    ) as LunaPerformanceClassificationRecord;
    total += record.prediction.costUsd;
  }
  return total;
};

const runClassification = async (
  args: ReturnType<typeof parseArguments>,
): Promise<void> => {
  if (!args.flags.has("--confirm-external-run")) {
    throw new Error("Refusing classification calls without confirmation");
  }
  const config = await readConfig(required(args, "--config"));
  const matrix = await readMatrix(required(args, "--matrix"));
  const retrievalDirectory = path.resolve(
    required(args, "--retrieval-directory"),
  );
  const outputDirectory = path.resolve(required(args, "--output-directory"));
  const episodes = await readJsonl<TaskEpisode>(path.resolve(config.episodes));
  const episodeById = new Map(episodes.map((episode) => [episode.id, episode]));
  const resources = await loadResources(
    config,
    new Set(episodes.map((episode) => episode.id)),
  );
  const price = (await fetchModelPrices()).get(LUNA_ACCURACY_MODEL);
  if (!price) throw new Error("Missing Luna price");
  const jobs = matrix.arms
    .flatMap((arm) =>
      arm.seeds.flatMap((seed) =>
        episodes.map((episode) => ({
          arm,
          seed,
          episodeId: episode.id,
        })),
      ),
    )
    .sort((left, right) =>
      contentHash({
        schedule: "performance-paired-interleave-v1",
        arm: left.arm.id,
        seed: left.seed,
        episodeId: left.episodeId,
      }).localeCompare(
        contentHash({
          schedule: "performance-paired-interleave-v1",
          arm: right.arm.id,
          seed: right.seed,
          episodeId: right.episodeId,
        }),
      ),
    );
  const pending: Array<(typeof jobs)[number]> = [];
  for (const job of jobs) {
    if (
      !(await exists(
        classificationFile(
          outputDirectory,
          job.arm.id,
          job.seed,
          job.episodeId,
        ),
      ))
    ) {
      pending.push(job);
    }
  }
  const maximumCostUsd = Number(required(args, "--maximum-cost-usd"));
  const costJobs = jobs.map((job) => ({
    armId: job.arm.id,
    seed: job.seed,
    episodeId: job.episodeId,
  }));
  const previouslyRecordedCostUsd = await classificationCost(
    outputDirectory,
    costJobs,
  );
  const ledger = new BudgetLedger(
    path.resolve(
      args.values.get("--budget-ledger") ?? "artifacts/global-budget.json",
    ),
    200,
  );
  await ledger.reserve(maximumCostUsd);
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  if (!(await exists(path.join(outputDirectory, "classification-manifest.json")))) {
    await writeAtomic(path.join(outputDirectory, "classification-manifest.json"), {
      schemaVersion: 1,
      command: "classify",
      createdAt: new Date().toISOString(),
      cases: episodes.length,
      arms: matrix.arms,
      totalJobs: jobs.length,
      pendingJobs: pending.length,
      maximumCostUsd,
      matrixHash: contentHash(matrix),
      datasetHash: contentHash(episodes),
    });
  }
  const before = await getOpenRouterKeyStatus();
  let settled = false;
  const concurrency = Math.max(
    1,
    Math.min(8, Number(args.values.get("--concurrency") ?? "4")),
  );
  try {
    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(concurrency, pending.length) },
      async () => {
        while (true) {
          const index = cursor++;
          const job = pending[index];
          if (!job) return;
          const episode = episodeById.get(job.episodeId)!;
          const repository = resources.get(episode.repositoryId)!;
          const retrieval = JSON.parse(
            await readFile(
              retrievalFile(
                retrievalDirectory,
                job.arm.retrievalVariant,
                episode.id,
              ),
              "utf8",
            ),
          ) as LunaPerformanceRetrievalResult;
          const cards =
            job.arm.areaCardVariant === "enriched"
              ? repository.enrichedCards
              : repository.baselineCards;
          const record = await classifyLunaPerformanceCase({
            armId: job.arm.id,
            episode,
            profile: repository.profile,
            cards,
            retrieval,
            evidencePresentation: job.arm.evidencePresentation,
            areaCardVariant: job.arm.areaCardVariant,
            inferenceStrategy: job.arm.inferenceStrategy,
            seed: job.seed,
            price,
          });
          await writeAtomic(
            classificationFile(
              outputDirectory,
              job.arm.id,
              job.seed,
              episode.id,
            ),
            record,
          );
          console.error(
            JSON.stringify({
              completed: index + 1,
              pending: pending.length,
              arm: job.arm.id,
              seed: job.seed,
              episodeId: episode.id,
              costUsd: record.prediction.costUsd,
            }),
          );
        }
      },
    );
    const settledWorkers = await Promise.allSettled(workers);
    const failure = settledWorkers.find(
      (result): result is PromiseRejectedResult =>
        result.status === "rejected",
    );
    if (failure) throw failure.reason;
    const artifactTotalCostUsd = await classificationCost(
      outputDirectory,
      costJobs,
    );
    const incrementalCostUsd = Math.max(
      0,
      artifactTotalCostUsd - previouslyRecordedCostUsd,
    );
    await ledger.settle(maximumCostUsd, incrementalCostUsd);
    settled = true;
    const after = await getOpenRouterKeyStatus();
    await writeAtomic(path.join(outputDirectory, "classification-cost.json"), {
      schemaVersion: 1,
      maximumCostUsd,
      previouslyRecordedCostUsd,
      incrementalCostUsd,
      artifactTotalCostUsd,
      keyStatusBefore: before,
      keyStatusAfter: after,
    });
    console.log(
      JSON.stringify({
        ok: true,
        jobs: jobs.length,
        pending: pending.length,
        previouslyRecordedCostUsd,
        incrementalCostUsd,
        artifactTotalCostUsd,
      }, null, 2),
    );
  } catch (error) {
    if (!settled) {
      const artifactTotalCostUsd = await classificationCost(
        outputDirectory,
        costJobs,
      );
      await ledger.settle(
        maximumCostUsd,
        Math.max(
          0,
          artifactTotalCostUsd - previouslyRecordedCostUsd,
        ),
      );
    }
    throw error;
  }
};

const readRetrievalResults = async (
  directory: string,
  variant: LunaPerformanceRetrievalVariant,
  episodes: readonly TaskEpisode[],
): Promise<LunaPerformanceRetrievalResult[]> =>
  Promise.all(
    episodes.map(async (episode) =>
      JSON.parse(
        await readFile(retrievalFile(directory, variant, episode.id), "utf8"),
      ) as LunaPerformanceRetrievalResult
    ),
  );

const analyzeRetrieval = async (
  args: ReturnType<typeof parseArguments>,
): Promise<void> => {
  const config = await readConfig(required(args, "--config"));
  const directory = path.resolve(required(args, "--output-directory"));
  const episodes = await readJsonl<TaskEpisode>(path.resolve(config.episodes));
  const labels = await readJsonl<SilverLabelV1>(path.resolve(config.labels));
  const development = new Set(config.developmentEpisodeIds);
  const classificationDirectory = args.values.get(
    "--classification-directory",
  );
  const classificationMatrixFile = args.values.get(
    "--classification-matrix",
  );
  if (Boolean(classificationDirectory) !== Boolean(classificationMatrixFile)) {
    throw new Error(
      "Retrieval/classification diagnostics require both --classification-directory and --classification-matrix",
    );
  }
  const classificationMatrix = classificationMatrixFile
    ? await readMatrix(classificationMatrixFile)
    : undefined;
  const report: Record<string, unknown> = {};
  for (const variant of LUNA_PERFORMANCE_RETRIEVAL_VARIANTS) {
    const results = await readRetrievalResults(directory, variant, episodes);
    const classificationArm = classificationMatrix?.arms.find(
      (arm) =>
        arm.retrievalVariant === variant &&
        arm.seeds.length === 1,
    );
    if (classificationMatrix && !classificationArm) {
      throw new Error(
        `Classification matrix lacks a single-seed arm for ${variant}`,
      );
    }
    const classificationPredictions =
      classificationArm && classificationDirectory
        ? (
            await readClassificationRecords(
              path.resolve(classificationDirectory),
              classificationArm,
              episodes,
            )
          ).map((record) => record.prediction)
        : undefined;
    const evaluate = (selected: ReadonlySet<string>) => {
      const selectedResults = results.filter((result) =>
        selected.has(result.taskEpisodeId),
      );
      const selectedIds = new Set(
        selectedResults.map((result) => result.taskEpisodeId),
      );
      const selectedLabels = labels.filter((label) =>
        selectedIds.has(label.taskEpisodeId),
      );
      return {
        oraclePathMetrics: evaluateLunaPerformanceRetrieval({
          results: selectedResults,
          labels: selectedLabels,
        }),
        ...(classificationPredictions
          ? {
              retrievalClassificationDiagnostics:
                analyzeLunaRetrievalClassificationFailures({
                  results: selectedResults,
                  labels: selectedLabels,
                  predictions: classificationPredictions.filter(
                    (prediction) =>
                      selectedIds.has(prediction.taskEpisodeId),
                  ),
                }),
            }
          : {}),
      };
    };
    const allIds = new Set(episodes.map((episode) => episode.id));
    const confirmation = new Set(
      episodes
        .filter((episode) => !development.has(episode.id))
        .map((episode) => episode.id),
    );
    report[variant] = {
      overall: evaluate(allIds),
      development: evaluate(development),
      confirmation: evaluate(confirmation),
      byRepository: Object.fromEntries(
        [...new Set(episodes.map((episode) => episode.repositoryId))].map(
          (repositoryId) => [
            repositoryId,
            evaluate(
              new Set(
                episodes
                  .filter(
                    (episode) => episode.repositoryId === repositoryId,
                  )
                  .map((episode) => episode.id),
              ),
            ),
          ],
        ),
      ),
    };
  }
  const output = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    cases: episodes.length,
    developmentCases: development.size,
    confirmationCases: episodes.length - development.size,
    variants: report,
  };
  const outputFile = path.resolve(required(args, "--analysis-output"));
  await writeAtomic(outputFile, output);
  console.log(JSON.stringify(output, null, 2));
};

const readClassificationRecords = async (
  outputDirectory: string,
  arm: ClassificationArm,
  episodes: readonly TaskEpisode[],
): Promise<LunaPerformanceClassificationRecord[]> => {
  const result: LunaPerformanceClassificationRecord[] = [];
  for (const seed of arm.seeds) {
    for (const episode of episodes) {
      result.push(
        JSON.parse(
          await readFile(
            classificationFile(outputDirectory, arm.id, seed, episode.id),
            "utf8",
          ),
        ) as LunaPerformanceClassificationRecord,
      );
    }
  }
  return result;
};

const weightedMetrics = (
  values: Array<{
    repositoryId: string;
    metrics: ReturnType<typeof summarizeLunaPerformanceArm>;
  }>,
): Record<string, unknown> => {
  const cases = values.reduce((sum, item) => sum + item.metrics.cases, 0);
  const known = values.reduce(
    (sum, item) => sum + item.metrics.knownCases,
    0,
  );
  const byCases = (
    select: (
      metrics: ReturnType<typeof summarizeLunaPerformanceArm>,
    ) => number,
  ): number =>
    cases === 0
      ? 0
      : values.reduce(
          (sum, item) => sum + select(item.metrics) * item.metrics.cases,
          0,
        ) / cases;
  const byKnown = (
    select: (
      metrics: ReturnType<typeof summarizeLunaPerformanceArm>,
    ) => number,
  ): number =>
    known === 0
      ? 0
      : values.reduce(
          (sum, item) =>
            sum + select(item.metrics) * item.metrics.knownCases,
          0,
        ) / known;
  const calls = values.reduce(
    (sum, item) => sum + item.metrics.usage.providerCalls,
    0,
  );
  const cost = values.reduce(
    (sum, item) => sum + item.metrics.usage.costUsd,
    0,
  );
  return {
    cases,
    knownCases: known,
    scopeHitAt1: byCases((metrics) => metrics.scope.hitAt1),
    scopeBrier: byCases((metrics) => metrics.scope.brier),
    scopeLogLoss: byCases((metrics) => metrics.scope.logLoss),
    areaHitAt1: byKnown((metrics) => metrics.areaRanking.hitAt1),
    allGoldAt3: byKnown((metrics) => metrics.areaRanking.allGoldAt3),
    exactSetAtPointFive: byKnown(
      (metrics) => metrics.thresholdPointFive.exactSetAccuracy,
    ),
    areaBrier: byKnown(
      (metrics) => metrics.areaProbability.conditionalBrier,
    ),
    areaLogLoss: byKnown(
      (metrics) => metrics.areaProbability.conditionalLogLoss,
    ),
    providerCalls: calls,
    totalCostUsd: cost,
    meanCostUsd: cases === 0 ? 0 : cost / cases,
  };
};

const metricsAcrossRepositories = (
  input: {
    episodes: readonly TaskEpisode[];
    labels: readonly SilverLabelV1[];
    predictions: readonly import("./luna-distributional.ts").LunaDistributionalPrediction[];
    resources: ReadonlyMap<string, RepositoryResources>;
    selectedIds: ReadonlySet<string>;
  },
): {
  aggregate: Record<string, unknown>;
  byRepository: Record<string, unknown>;
} => {
  const values: Array<{
    repositoryId: string;
    metrics: ReturnType<typeof summarizeLunaPerformanceArm>;
  }> = [];
  for (const repositoryId of [
    ...new Set(input.episodes.map((episode) => episode.repositoryId)),
  ]) {
    const ids = new Set(
      input.episodes
        .filter(
          (episode) =>
            episode.repositoryId === repositoryId &&
            input.selectedIds.has(episode.id),
        )
        .map((episode) => episode.id),
    );
    if (ids.size === 0) continue;
    const resource = input.resources.get(repositoryId)!;
    values.push({
      repositoryId,
      metrics: summarizeLunaPerformanceArm({
        labels: input.labels.filter((label) =>
          ids.has(label.taskEpisodeId),
        ),
        predictions: input.predictions.filter((prediction) =>
          ids.has(prediction.taskEpisodeId),
        ),
        areaIds: resource.baselineCards.map((card) => card.areaId),
      }),
    });
  }
  return {
    aggregate: weightedMetrics(values),
    byRepository: Object.fromEntries(
      values.map((value) => [value.repositoryId, value.metrics]),
    ),
  };
};

const calibrateAndEvaluateConfirmation = (input: {
  episodes: readonly TaskEpisode[];
  labels: readonly SilverLabelV1[];
  predictions: readonly import("./luna-distributional.ts").LunaDistributionalPrediction[];
  resources: ReadonlyMap<string, RepositoryResources>;
  development: ReadonlySet<string>;
  confirmation: ReadonlySet<string>;
}): {
  calibration: Record<string, unknown>;
  calibratedConfirmation: ReturnType<typeof metricsAcrossRepositories>;
} => {
  const calibrations: Record<string, unknown> = {};
  const calibratedPredictions: import("./luna-distributional.ts").LunaDistributionalPrediction[] =
    [];
  for (const repositoryId of [
    ...new Set(input.episodes.map((episode) => episode.repositoryId)),
  ]) {
    const resource = input.resources.get(repositoryId)!;
    const repositoryIds = new Set(
      input.episodes
        .filter((episode) => episode.repositoryId === repositoryId)
        .map((episode) => episode.id),
    );
    const developmentIds = new Set(
      [...repositoryIds].filter((id) => input.development.has(id)),
    );
    if (developmentIds.size === 0) continue;
    const calibration = fitLunaTemperatureCalibration({
      labels: input.labels.filter((label) =>
        developmentIds.has(label.taskEpisodeId),
      ),
      predictions: input.predictions.filter((prediction) =>
        developmentIds.has(prediction.taskEpisodeId),
      ),
      areaIds: resource.baselineCards.map((card) => card.areaId),
    });
    calibrations[repositoryId] = calibration;
    calibratedPredictions.push(
      ...input.predictions
        .filter((prediction) => repositoryIds.has(prediction.taskEpisodeId))
        .map((prediction) =>
          applyLunaTemperatureCalibration({
            prediction,
            calibration,
          })
        ),
    );
  }
  return {
    calibration: calibrations,
    calibratedConfirmation: metricsAcrossRepositories({
      episodes: input.episodes,
      labels: input.labels,
      predictions: calibratedPredictions,
      resources: input.resources,
      selectedIds: input.confirmation,
    }),
  };
};

const analyzeClassification = async (
  args: ReturnType<typeof parseArguments>,
): Promise<void> => {
  const config = await readConfig(required(args, "--config"));
  const matrix = await readMatrix(required(args, "--matrix"));
  const outputDirectory = path.resolve(required(args, "--output-directory"));
  const episodes = await readJsonl<TaskEpisode>(path.resolve(config.episodes));
  const labels = await readJsonl<SilverLabelV1>(path.resolve(config.labels));
  const development = new Set(config.developmentEpisodeIds);
  const confirmation = new Set(
    episodes
      .filter((episode) => !development.has(episode.id))
      .map((episode) => episode.id),
  );
  const allIds = new Set(episodes.map((episode) => episode.id));
  const resources = await loadResources(config, allIds);
  const arms: Record<string, unknown> = {};
  for (const arm of matrix.arms) {
    const records = await readClassificationRecords(
      outputDirectory,
      arm,
      episodes,
    );
    const predictionsBySeed = new Map(
      arm.seeds.map((seed) => [
        seed,
        records
          .filter((record) => record.seed === seed)
          .map((record) => record.prediction),
      ]),
    );
    const perSeed = Object.fromEntries(
      arm.seeds.map((seed) => [
        String(seed),
        {
          overall: metricsAcrossRepositories({
            episodes,
            labels,
            predictions: predictionsBySeed.get(seed)!,
            resources,
            selectedIds: allIds,
          }),
          development: metricsAcrossRepositories({
            episodes,
            labels,
            predictions: predictionsBySeed.get(seed)!,
            resources,
            selectedIds: development,
          }),
          confirmation: metricsAcrossRepositories({
            episodes,
            labels,
            predictions: predictionsBySeed.get(seed)!,
            resources,
            selectedIds: confirmation,
          }),
          ...calibrateAndEvaluateConfirmation({
            episodes,
            labels,
            predictions: predictionsBySeed.get(seed)!,
            resources,
            development,
            confirmation,
          }),
        },
      ]),
    );
    let ensemble: unknown = null;
    if (arm.seeds.length >= 2) {
      const ensemblePredictions = episodes.map((episode) =>
        ensembleLunaDistributionalPredictions({
          predictions: arm.seeds.map(
            (seed) =>
              predictionsBySeed
                .get(seed)!
                .find(
                  (prediction) =>
                    prediction.taskEpisodeId === episode.id,
                )!,
          ),
          classifier: `${LUNA_ACCURACY_MODEL}:${arm.id}:ensemble-${arm.seeds.length}`,
        })
      );
      const calibrated = calibrateAndEvaluateConfirmation({
        episodes,
        labels,
        predictions: ensemblePredictions,
        resources,
        development,
        confirmation,
      });
      ensemble = {
        raw: {
          overall: metricsAcrossRepositories({
            episodes,
            labels,
            predictions: ensemblePredictions,
            resources,
            selectedIds: allIds,
          }),
          development: metricsAcrossRepositories({
            episodes,
            labels,
            predictions: ensemblePredictions,
            resources,
            selectedIds: development,
          }),
          confirmation: metricsAcrossRepositories({
            episodes,
            labels,
            predictions: ensemblePredictions,
            resources,
            selectedIds: confirmation,
          }),
        },
        ...calibrated,
      };
    }
    arms[arm.id] = { configuration: arm, perSeed, ensemble };
  }
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    cases: episodes.length,
    developmentCases: development.size,
    confirmationCases: confirmation.size,
    arms,
  };
  await writeAtomic(path.resolve(required(args, "--analysis-output")), report);
  console.log(JSON.stringify(report, null, 2));
};

const numericMetric = (
  aggregate: Record<string, unknown>,
  field: string,
): number => {
  const value = aggregate[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Missing selection metric ${field}`);
  }
  return value;
};

const selectClassificationWinner = async (
  args: ReturnType<typeof parseArguments>,
): Promise<void> => {
  const config = await readConfig(required(args, "--config"));
  const matrix = await readMatrix(required(args, "--matrix"));
  const outputDirectory = path.resolve(required(args, "--output-directory"));
  const episodes = await readJsonl<TaskEpisode>(path.resolve(config.episodes));
  const labels = await readJsonl<SilverLabelV1>(path.resolve(config.labels));
  const development = new Set(config.developmentEpisodeIds);
  const developmentEpisodes = episodes.filter((episode) =>
    development.has(episode.id),
  );
  const resources = await loadResources(
    config,
    new Set(episodes.map((episode) => episode.id)),
  );
  const candidates: Array<{
    armId: string;
    predictionKind: "single_seed" | "ensemble";
    seeds: number[];
    aggregate: Record<string, unknown>;
    selectionLoss: number;
    tieBreakers: {
      areaLogLoss: number;
      scopeLogLoss: number;
      exactSetAtPointFive: number;
    };
  }> = [];
  for (const arm of matrix.arms) {
    const records = await readClassificationRecords(
      outputDirectory,
      arm,
      developmentEpisodes,
    );
    const perSeed = new Map(
      arm.seeds.map((seed) => [
        seed,
        records
          .filter((record) => record.seed === seed)
          .map((record) => record.prediction),
      ]),
    );
    const predictions =
      arm.seeds.length === 1
        ? perSeed.get(arm.seeds[0]!)!
        : developmentEpisodes.map((episode) =>
            ensembleLunaDistributionalPredictions({
              predictions: arm.seeds.map(
                (seed) =>
                  perSeed
                    .get(seed)!
                    .find(
                      (prediction) =>
                        prediction.taskEpisodeId === episode.id,
                    )!,
              ),
              classifier: `${LUNA_ACCURACY_MODEL}:${arm.id}:development-selection-ensemble`,
            })
          );
    const developmentMetrics = metricsAcrossRepositories({
      episodes,
      labels,
      predictions,
      resources,
      selectedIds: development,
    });
    const aggregate = developmentMetrics.aggregate;
    const areaBrier = numericMetric(aggregate, "areaBrier");
    const scopeBrier = numericMetric(aggregate, "scopeBrier");
    const areaHitAt1 = numericMetric(aggregate, "areaHitAt1");
    const allGoldAt3 = numericMetric(aggregate, "allGoldAt3");
    candidates.push({
      armId: arm.id,
      predictionKind:
        arm.seeds.length === 1 ? "single_seed" : "ensemble",
      seeds: arm.seeds,
      aggregate,
      selectionLoss:
        areaBrier +
        0.35 * scopeBrier +
        0.15 * (1 - areaHitAt1) +
        0.25 * (1 - allGoldAt3),
      tieBreakers: {
        areaLogLoss: numericMetric(aggregate, "areaLogLoss"),
        scopeLogLoss: numericMetric(aggregate, "scopeLogLoss"),
        exactSetAtPointFive: numericMetric(
          aggregate,
          "exactSetAtPointFive",
        ),
      },
    });
  }
  candidates.sort(
    (left, right) =>
      left.selectionLoss - right.selectionLoss ||
      left.tieBreakers.areaLogLoss - right.tieBreakers.areaLogLoss ||
      left.tieBreakers.scopeLogLoss - right.tieBreakers.scopeLogLoss ||
      right.tieBreakers.exactSetAtPointFive -
        left.tieBreakers.exactSetAtPointFive ||
      left.armId.localeCompare(right.armId),
  );
  const selection = {
    schemaVersion: 1,
    selectedAt: new Date().toISOString(),
    dataRole: "burned_development_only_confirmation_not_read",
    developmentCases: development.size,
    objective:
      "area_brier + 0.35*scope_brier + 0.15*(1-area_hit_at_1) + 0.25*(1-all_gold_top_3)",
    winner: candidates[0],
    candidates,
    matrixHash: contentHash(matrix),
  };
  const output = path.resolve(required(args, "--selection-output"));
  if (await exists(output)) {
    throw new Error(`Selection output already exists: ${output}`);
  }
  await writeAtomic(output, selection);
  console.log(JSON.stringify(selection, null, 2));
};

const plan = async (
  args: ReturnType<typeof parseArguments>,
): Promise<void> => {
  const config = await readConfig(required(args, "--config"));
  const episodes = await readJsonl<TaskEpisode>(path.resolve(config.episodes));
  const matrixFile = args.values.get("--matrix");
  if (!matrixFile) {
    const estimatedTaskTokens = episodes.reduce(
      (sum, episode) => sum + estimateTokens(episode.currentRequest),
      0,
    );
    console.log(
      JSON.stringify({
        command: "retrieve",
        cases: episodes.length,
        retrievalVariants: LUNA_PERFORMANCE_RETRIEVAL_VARIANTS,
        lunaQueryCalls: episodes.length,
        estimatedTaskTokens,
        note: "Embedding volume depends on repository candidates and is measured during resumable materialization.",
      }, null, 2),
    );
    return;
  }
  const matrix = await readMatrix(matrixFile);
  const calls = matrix.arms.reduce(
    (sum, arm) => sum + arm.seeds.length * episodes.length,
    0,
  );
  console.log(
    JSON.stringify({
      command: "classify",
      cases: episodes.length,
      arms: matrix.arms,
      providerCalls: calls,
      note: "Every call uses the same 6,000-character repository-evidence budget and task-aware context; no latest-request-only arm exists.",
    }, null, 2),
  );
};

const main = async (): Promise<void> => {
  const args = parseArguments(process.argv.slice(2));
  if (args.command === "plan") return plan(args);
  if (args.command === "retrieve") return runRetrieval(args);
  if (args.command === "classify") return runClassification(args);
  if (args.command === "analyze-retrieval") return analyzeRetrieval(args);
  if (args.command === "analyze-classification") {
    return analyzeClassification(args);
  }
  if (args.command === "select-classification") {
    return selectClassificationWinner(args);
  }
  throw new Error(
    "Usage: luna-performance-experiment-cli <plan|retrieve|classify|select-classification|analyze-retrieval|analyze-classification> --config FILE ...; analyze-retrieval accepts optional paired --classification-directory and --classification-matrix",
  );
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
