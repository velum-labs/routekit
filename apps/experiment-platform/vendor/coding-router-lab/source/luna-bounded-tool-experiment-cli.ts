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
  evaluateLunaDistributionalPredictions,
  type LunaDistributionalMetrics,
  type LunaDistributionalPrediction,
} from "./luna-distributional.ts";
import {
  runLunaBoundedRepositoryClassification,
  type LunaBoundedProviderCallTrace,
  type LunaBoundedToolHarnessTrace,
  type LunaRepositoryEvidenceArm,
} from "./luna-bounded-tool-harness.ts";
import { fetchModelPrices } from "./cost.ts";
import { contentHash } from "./hash.ts";
import { readJsonl } from "./jsonl.ts";
import {
  LUNA_ACCURACY_MODEL,
  LUNA_ACCURACY_PROVIDER,
  LUNA_ACCURACY_PROVIDER_SLUG,
} from "./luna-accuracy-openrouter.ts";
import { getOpenRouterKeyStatus } from "./openrouter.ts";
import type {
  AreaCardV1,
  RepositoryProfileV1,
  SilverLabelV1,
  TaskEpisode,
} from "./types.ts";
import {
  validateAreaCards,
  validateBenchmarkDataset,
  validateRepositoryProfile,
} from "./validation.ts";

const ALL_ARMS = [
  "no_repository",
  "static_snippets",
  "candidate_read",
  "search_and_read",
  "integrated_contrastive",
] as const satisfies readonly LunaRepositoryEvidenceArm[];

interface ExperimentRecord {
  schemaVersion: 1;
  arm: LunaRepositoryEvidenceArm;
  seed: number;
  prediction: LunaDistributionalPrediction;
  trace: LunaBoundedToolHarnessTrace;
}

interface ProviderCallState {
  schemaVersion: 1;
  arm: LunaRepositoryEvidenceArm;
  seed: number;
  taskEpisodeId: string;
  status: "running" | "completed" | "failed";
  providerCalls: LunaBoundedProviderCallTrace[];
  totalCostUsd: number;
  updatedAt: string;
  error?: {
    name: string;
    message: string;
  };
}

interface ParsedArguments {
  command: "plan" | "run" | "analyze";
  values: Map<string, string[]>;
  flags: Set<string>;
}

const parseArguments = (argv: readonly string[]): ParsedArguments => {
  const command = argv[0];
  if (command !== "plan" && command !== "run" && command !== "analyze") {
    throw new Error("First argument must be plan, run, or analyze");
  }
  const values = new Map<string, string[]>();
  const flags = new Set<string>();
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (!argument.startsWith("--")) {
      throw new Error(`Unexpected argument: ${argument}`);
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      flags.add(argument);
      continue;
    }
    values.set(argument, [...(values.get(argument) ?? []), next]);
    index += 1;
  }
  return { command, values, flags };
};

const value = (
  args: ParsedArguments,
  name: string,
): string | undefined => args.values.get(name)?.at(-1);

const required = (args: ParsedArguments, name: string): string => {
  const found = value(args, name);
  if (!found) throw new Error(`Missing ${name}`);
  return found;
};

const commaList = (raw: string | undefined): string[] =>
  raw
    ? raw
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];

const parseSeeds = (raw: string | undefined): number[] => {
  const values = commaList(raw ?? "181081").map(Number);
  if (
    values.length < 1 ||
    values.length > 20 ||
    values.some(
      (seed) =>
        !Number.isSafeInteger(seed) || seed < 0 || seed > 2_147_483_647,
    ) ||
    new Set(values).size !== values.length
  ) {
    throw new Error("--seeds must be 1..20 unique non-negative integers");
  }
  return values;
};

const parseArms = (
  raw: string | undefined,
): LunaRepositoryEvidenceArm[] => {
  const arms = (commaList(raw).length > 0
    ? commaList(raw)
    : [...ALL_ARMS]) as LunaRepositoryEvidenceArm[];
  if (
    arms.some(
      (arm) =>
        !(ALL_ARMS as readonly string[]).includes(arm),
    ) ||
    new Set(arms).size !== arms.length
  ) {
    throw new Error(`--arms must use: ${ALL_ARMS.join(",")}`);
  }
  return arms;
};

const writeAtomic = async (
  file: string,
  value: unknown,
): Promise<void> => {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, file);
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

const candidatePathsFromEpisode = (episode: TaskEpisode): string[] => {
  const diagnostic = episode.relevantDiagnostic ?? "";
  return [
    ...new Set(
      diagnostic
        .split(/\r?\n/u)
        .map((line) => {
          if (!line.startsWith("- ")) return undefined;
          const withoutMetadata = line.slice(2).split(" [", 1)[0]!;
          return withoutMetadata.replace(/:\d+-\d+$/u, "");
        })
        .filter((item): item is string => Boolean(item)),
    ),
  ];
};

const mapById = <T extends { id: string }>(
  values: readonly T[],
  label: string,
): Map<string, T> => {
  const result = new Map<string, T>();
  for (const item of values) {
    if (result.has(item.id)) throw new Error(`Duplicate ${label} ID ${item.id}`);
    result.set(item.id, item);
  }
  return result;
};

const sameIds = (
  expected: readonly TaskEpisode[],
  actual: ReadonlyMap<string, TaskEpisode>,
  label: string,
): void => {
  const expectedIds = new Set(expected.map((episode) => episode.id));
  if (
    expectedIds.size !== actual.size ||
    [...expectedIds].some((id) => !actual.has(id))
  ) {
    throw new Error(`${label} episode IDs differ from control episodes`);
  }
};

const recordFile = (
  outputDirectory: string,
  arm: LunaRepositoryEvidenceArm,
  seed: number,
  episodeId: string,
): string =>
  path.join(
    outputDirectory,
    "records",
    arm,
    String(seed),
    `${episodeId}.json`,
  );

const callStateFile = (
  outputDirectory: string,
  arm: LunaRepositoryEvidenceArm,
  seed: number,
  episodeId: string,
): string =>
  path.join(
    outputDirectory,
    "call-state",
    arm,
    String(seed),
    `${episodeId}.json`,
  );

const sumProviderCallCost = (
  calls: readonly LunaBoundedProviderCallTrace[],
): number => calls.reduce((sum, call) => sum + call.costUsd, 0);

const costForJobs = async (
  outputDirectory: string,
  jobs: ReadonlyArray<{
    arm: LunaRepositoryEvidenceArm;
    seed: number;
    episodeId: string;
  }>,
): Promise<number> => {
  let costUsd = 0;
  for (const job of jobs) {
    const completedFile = recordFile(
      outputDirectory,
      job.arm,
      job.seed,
      job.episodeId,
    );
    if (await exists(completedFile)) {
      const completed = JSON.parse(
        await readFile(completedFile, "utf8"),
      ) as ExperimentRecord;
      costUsd += completed.prediction.costUsd;
      continue;
    }
    const partialFile = callStateFile(
      outputDirectory,
      job.arm,
      job.seed,
      job.episodeId,
    );
    if (await exists(partialFile)) {
      const partial = JSON.parse(
        await readFile(partialFile, "utf8"),
      ) as ProviderCallState;
      if (
        partial.arm !== job.arm ||
        partial.seed !== job.seed ||
        partial.taskEpisodeId !== job.episodeId ||
        !Number.isFinite(partial.totalCostUsd) ||
        partial.totalCostUsd < 0
      ) {
        throw new Error(
          `Invalid provider call state for ${job.arm}/${job.seed}/${job.episodeId}`,
        );
      }
      costUsd += partial.totalCostUsd;
    }
  }
  return costUsd;
};

const readRecords = async (
  outputDirectory: string,
): Promise<ExperimentRecord[]> => {
  const root = path.join(outputDirectory, "records");
  if (!(await exists(root))) return [];
  const result: ExperimentRecord[] = [];
  for (const arm of await readdir(root)) {
    const armDirectory = path.join(root, arm);
    for (const seed of await readdir(armDirectory)) {
      const seedDirectory = path.join(armDirectory, seed);
      for (const file of await readdir(seedDirectory)) {
        if (!file.endsWith(".json")) continue;
        result.push(
          JSON.parse(
            await readFile(path.join(seedDirectory, file), "utf8"),
          ) as ExperimentRecord,
        );
      }
    }
  }
  return result;
};

const mean = (values: readonly number[]): number =>
  values.length === 0
    ? 0
    : values.reduce((sum, item) => sum + item, 0) / values.length;

const aggregateMetrics = (
  values: readonly LunaDistributionalMetrics[],
): Record<string, unknown> => ({
  seeds: values.length,
  scopeHitAt1: mean(values.map((item) => item.scope.hitAt1)),
  scopeBrier: mean(values.map((item) => item.scope.brier)),
  scopeLogLoss: mean(values.map((item) => item.scope.logLoss)),
  hitAt1: mean(values.map((item) => item.areaRanking.hitAt1)),
  hitAt2: mean(values.map((item) => item.areaRanking.hitAt2)),
  hitAt3: mean(values.map((item) => item.areaRanking.hitAt3)),
  allGoldAt3: mean(values.map((item) => item.areaRanking.allGoldAt3)),
  recallAt3: mean(values.map((item) => item.areaRanking.recallAt3)),
  meanReciprocalRank: mean(
    values.map((item) => item.areaRanking.meanReciprocalRank),
  ),
  conditionalBrier: mean(
    values.map((item) => item.areaProbability.conditionalBrier),
  ),
  conditionalLogLoss: mean(
    values.map((item) => item.areaProbability.conditionalLogLoss),
  ),
  calibrationError10Bins: mean(
    values.map(
      (item) => item.areaProbability.calibrationError10Bins,
    ),
  ),
  thresholdExactSet: mean(
    values.map((item) => item.thresholdPointFive.exactSetAccuracy),
  ),
  totalProviderCalls: values.reduce(
    (sum, item) => sum + item.usage.providerCalls,
    0,
  ),
  totalCostUsd: values.reduce(
    (sum, item) => sum + item.usage.costUsd,
    0,
  ),
  meanCostUsd: mean(values.map((item) => item.usage.meanCostUsd)),
  meanDurationMs: mean(values.map((item) => item.usage.meanDurationMs)),
});

const analyze = async (input: {
  outputDirectory: string;
  labels: SilverLabelV1[];
  cards: AreaCardV1[];
  arms: LunaRepositoryEvidenceArm[];
  seeds: number[];
}): Promise<Record<string, unknown>> => {
  const records = await readRecords(input.outputDirectory);
  const labelById = new Map(
    input.labels.map((label) => [label.taskEpisodeId, label]),
  );
  const perArm: Record<string, unknown> = {};
  for (const arm of input.arms) {
    const perSeed: Record<string, LunaDistributionalMetrics> = {};
    for (const seed of input.seeds) {
      const selected = records.filter(
        (record) => record.arm === arm && record.seed === seed,
      );
      if (selected.length !== input.labels.length) {
        throw new Error(
          `${arm}/${seed} has ${selected.length} records; expected ${input.labels.length}`,
        );
      }
      perSeed[String(seed)] = evaluateLunaDistributionalPredictions({
        labels: input.labels,
        predictions: selected.map((record) => record.prediction),
        areaIds: input.cards.map((card) => card.areaId),
      });
    }
    const toolRecords = records.filter(
      (record) => record.arm === arm && record.trace.toolSession,
    );
    let toolCases = 0;
    let oraclePathEligibleCases = 0;
    let casesWithAnyOracleExposedPath = 0;
    let totalOracleExposedPathRecall = 0;
    let casesWithAnyOracleReadPath = 0;
    let totalOracleReadPathRecall = 0;
    let toolSearchCalls = 0;
    let toolReadCalls = 0;
    for (const record of toolRecords) {
      const label = labelById.get(record.prediction.taskEpisodeId);
      if (!label) continue;
      const exposedPaths = new Set(
        record.trace.toolSession!.toolCallRecords.flatMap(
          (call) => call.resultPaths,
        ),
      );
      const readPaths = new Set(
        record.trace.toolSession!.toolCallRecords
          .filter(
            (call) =>
              call.name === "read_repository_excerpt" && call.ok,
          )
          .flatMap((call) => call.resultPaths),
      );
      const relevant = label.relevantPaths;
      toolCases += 1;
      if (relevant.length > 0) {
        const exposedMatches = relevant.filter((pathValue) =>
          exposedPaths.has(pathValue),
        ).length;
        const readMatches = relevant.filter((pathValue) =>
          readPaths.has(pathValue),
        ).length;
        oraclePathEligibleCases += 1;
        if (exposedMatches > 0) casesWithAnyOracleExposedPath += 1;
        if (readMatches > 0) casesWithAnyOracleReadPath += 1;
        totalOracleExposedPathRecall += exposedMatches / relevant.length;
        totalOracleReadPathRecall += readMatches / relevant.length;
      }
      toolSearchCalls += record.trace.toolSession!.searchCalls;
      toolReadCalls += record.trace.toolSession!.readCalls;
    }
    perArm[arm] = {
      perSeed,
      aggregate: aggregateMetrics(Object.values(perSeed)),
      toolUse:
        toolCases === 0
          ? null
          : {
              cases: toolCases,
              meanSearchCalls: toolSearchCalls / toolCases,
              meanReadCalls: toolReadCalls / toolCases,
              oraclePathEligibleCases,
              anyOracleRelevantPathRate:
                oraclePathEligibleCases === 0
                  ? 0
                  : casesWithAnyOracleExposedPath /
                    oraclePathEligibleCases,
              meanOracleRelevantPathRecall:
                oraclePathEligibleCases === 0
                  ? 0
                  : totalOracleExposedPathRecall /
                    oraclePathEligibleCases,
              anyOracleRelevantReadPathRate:
                oraclePathEligibleCases === 0
                  ? 0
                  : casesWithAnyOracleReadPath /
                    oraclePathEligibleCases,
              meanOracleRelevantReadPathRecall:
                oraclePathEligibleCases === 0
                  ? 0
                  : totalOracleReadPathRecall /
                    oraclePathEligibleCases,
            },
    };
  }
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    records: records.length,
    cases: input.labels.length,
    arms: input.arms,
    seeds: input.seeds,
    perArm,
  };
  await writeAtomic(
    path.join(input.outputDirectory, "analysis.json"),
    report,
  );
  return report;
};

const preflightTools = async (): Promise<Record<string, unknown>> => {
  const response = await fetch(
    `https://openrouter.ai/api/v1/models/${LUNA_ACCURACY_MODEL}/endpoints`,
  );
  if (!response.ok) {
    throw new Error(`OpenRouter endpoint preflight HTTP ${response.status}`);
  }
  const raw = JSON.parse(await response.text()) as unknown;
  if (
    typeof raw !== "object" ||
    raw === null ||
    !("data" in raw) ||
    typeof raw.data !== "object" ||
    raw.data === null ||
    !("endpoints" in raw.data) ||
    !Array.isArray(raw.data.endpoints)
  ) {
    throw new Error("Invalid OpenRouter endpoint preflight");
  }
  const endpoint = raw.data.endpoints.find(
    (candidate) =>
      typeof candidate === "object" &&
      candidate !== null &&
      "tag" in candidate &&
      candidate.tag === LUNA_ACCURACY_PROVIDER_SLUG,
  ) as Record<string, unknown> | undefined;
  if (
    !endpoint ||
    endpoint.provider_name !== LUNA_ACCURACY_PROVIDER ||
    endpoint.status !== 0 ||
    !Array.isArray(endpoint.supported_parameters) ||
    !endpoint.supported_parameters.includes("tools") ||
    !endpoint.supported_parameters.includes("tool_choice") ||
    !endpoint.supported_parameters.includes("response_format")
  ) {
    throw new Error("Pinned Luna endpoint lacks required tool parameters");
  }
  return {
    checkedAt: new Date().toISOString(),
    provider: endpoint.provider_name,
    status: endpoint.status,
    requiredParameters: ["tools", "tool_choice", "response_format"],
  };
};

const main = async (): Promise<void> => {
  const args = parseArguments(process.argv.slice(2));
  const outputDirectory = path.resolve(required(args, "--output-directory"));
  const profile = JSON.parse(
    await readFile(path.resolve(required(args, "--profile")), "utf8"),
  ) as RepositoryProfileV1;
  const cards = await readJsonl<AreaCardV1>(
    path.resolve(required(args, "--areas")),
  );
  const controlEpisodes = await readJsonl<TaskEpisode>(
    path.resolve(required(args, "--control-episodes")),
  );
  const labels = await readJsonl<SilverLabelV1>(
    path.resolve(required(args, "--labels")),
  );
  validateRepositoryProfile(profile);
  const allowEmptyPositiveExamples = args.flags.has(
    "--allow-empty-positive-examples",
  );
  validateAreaCards(cards, profile, {
    requirePositiveExamples: !allowEmptyPositiveExamples,
  });
  validateBenchmarkDataset(profile, cards, controlEpisodes, labels, {
    requirePositiveExamples: !allowEmptyPositiveExamples,
  });

  const selectedIds = new Set(commaList(value(args, "--only-ids")));
  const caseLimit = Number(value(args, "--case-limit") ?? "0");
  let selectedControl = controlEpisodes.filter(
    (episode) => selectedIds.size === 0 || selectedIds.has(episode.id),
  );
  if (caseLimit > 0) selectedControl = selectedControl.slice(0, caseLimit);
  if (selectedControl.length < 1) throw new Error("No cases selected");
  const selectedIdSet = new Set(selectedControl.map((episode) => episode.id));
  const selectedLabels = labels.filter((label) =>
    selectedIdSet.has(label.taskEpisodeId),
  );
  if (selectedLabels.length !== selectedControl.length) {
    throw new Error("Selected cases and labels differ");
  }
  const arms = parseArms(value(args, "--arms"));
  const seeds = parseSeeds(value(args, "--seeds"));
  const concurrency = Number(value(args, "--concurrency") ?? "1");
  if (
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 8
  ) {
    throw new Error("--concurrency must be an integer in 1..8");
  }

  if (args.command === "analyze") {
    console.log(
      JSON.stringify(
        await analyze({
          outputDirectory,
          labels: selectedLabels,
          cards,
          arms,
          seeds,
        }),
        null,
        2,
      ),
    );
    return;
  }

  const snippetEpisodes =
    arms.includes("static_snippets") ||
    arms.includes("integrated_contrastive")
    ? await readJsonl<TaskEpisode>(
        path.resolve(required(args, "--snippet-episodes")),
      )
    : [];
  const pathEpisodes = arms.includes("candidate_read")
    ? await readJsonl<TaskEpisode>(
        path.resolve(required(args, "--path-episodes")),
      )
    : [];
  const controlById = mapById(controlEpisodes, "control episode");
  const snippetsById = mapById(snippetEpisodes, "snippet episode");
  const pathsById = mapById(pathEpisodes, "path episode");
  if (
    arms.includes("static_snippets") ||
    arms.includes("integrated_contrastive")
  ) {
    sameIds(controlEpisodes, snippetsById, "Snippet");
  }
  if (arms.includes("candidate_read")) {
    sameIds(controlEpisodes, pathsById, "Path");
  }

  const price = (await fetchModelPrices()).get(LUNA_ACCURACY_MODEL);
  if (!price) throw new Error("Luna missing from OpenRouter model catalog");
  const preflight = await preflightTools();
  const scheduleVersion = "paired-hash-interleave-v1";
  const jobs = arms
    .flatMap((arm) =>
      seeds.flatMap((seed) =>
        selectedControl.map((episode) => ({
          arm,
          seed,
          episodeId: episode.id,
        })),
      ),
    )
    .sort((left, right) =>
      contentHash({ scheduleVersion, ...left }).localeCompare(
        contentHash({ scheduleVersion, ...right }),
      ),
    );
  const alreadyComplete = new Set<string>();
  for (const job of jobs) {
    if (
      await exists(
        recordFile(
          outputDirectory,
          job.arm,
          job.seed,
          job.episodeId,
        ),
      )
    ) {
      alreadyComplete.add(
        `${job.arm}:${job.seed}:${job.episodeId}`,
      );
    }
  }
  const pending = jobs.filter(
    (job) =>
      !alreadyComplete.has(`${job.arm}:${job.seed}:${job.episodeId}`),
  );
  const plan = {
    schemaVersion: 1,
    command: args.command,
    createdAt: new Date().toISOString(),
    model: LUNA_ACCURACY_MODEL,
    repository: path.resolve(required(args, "--repository")),
    cases: selectedControl.length,
    arms,
    seeds,
    totalJobs: jobs.length,
    alreadyCompleteJobs: alreadyComplete.size,
    pendingJobs: pending.length,
    scheduleVersion,
    scheduleHash: contentHash(jobs),
    maximumProviderCalls: pending.reduce(
      (sum, job) =>
        sum +
        (job.arm === "integrated_contrastive"
          ? 6
          : job.arm === "search_and_read"
          ? 4
          : job.arm === "candidate_read"
            ? 3
            : 1),
      0,
    ),
    concurrency,
    preflight,
    datasetHashes: {
      profile: contentHash(profile),
      cards: contentHash(cards),
      controlEpisodes: contentHash(selectedControl),
      labels: contentHash(selectedLabels),
      snippets: snippetEpisodes.length ? contentHash(snippetEpisodes) : null,
      paths: pathEpisodes.length ? contentHash(pathEpisodes) : null,
    },
  };
  console.log(JSON.stringify(plan, null, 2));
  if (args.command === "plan") return;
  if (!args.flags.has("--confirm-external-run")) {
    throw new Error("Refusing paid calls without --confirm-external-run");
  }
  const maximumCostUsd = Number(required(args, "--maximum-cost-usd"));
  if (
    !Number.isFinite(maximumCostUsd) ||
    maximumCostUsd <= 0 ||
    maximumCostUsd > 50
  ) {
    throw new Error("--maximum-cost-usd must be in (0, 50]");
  }
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const manifestPath = path.join(outputDirectory, "manifest.lock.json");
  if (!(await exists(manifestPath))) {
    await writeAtomic(manifestPath, {
      ...plan,
      command: "run",
      maximumCostUsd,
    });
  }
  const artifactsRoot = path.resolve(
    value(args, "--artifacts-root") ??
      path.join(process.cwd(), "artifacts"),
  );
  const ledger = new BudgetLedger(
    path.join(artifactsRoot, "global-budget.json"),
    200,
  );
  await ledger.reserve(maximumCostUsd);
  const beforeStatus = await getOpenRouterKeyStatus();
  let settled = false;
  try {
    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(concurrency, pending.length) },
      async () => {
        while (true) {
          const index = cursor;
          cursor += 1;
          const job = pending[index];
          if (!job) return;
          const control = controlById.get(job.episodeId)!;
          const episode =
            job.arm === "static_snippets" ||
              job.arm === "integrated_contrastive"
              ? snippetsById.get(job.episodeId)!
              : job.arm === "candidate_read"
                ? pathsById.get(job.episodeId)!
                : control;
          const providerCalls: LunaBoundedProviderCallTrace[] = [];
          const stateFile = callStateFile(
            outputDirectory,
            job.arm,
            job.seed,
            job.episodeId,
          );
          const writeCallState = async (
            status: ProviderCallState["status"],
            error?: unknown,
          ): Promise<void> => {
            const normalizedError =
              error === undefined
                ? undefined
                : error instanceof Error
                  ? {
                      name: error.name.slice(0, 200),
                      message: error.message.slice(0, 1_000),
                    }
                  : {
                      name: "Error",
                      message: String(error).slice(0, 1_000),
                    };
            await writeAtomic(stateFile, {
              schemaVersion: 1,
              arm: job.arm,
              seed: job.seed,
              taskEpisodeId: job.episodeId,
              status,
              providerCalls,
              totalCostUsd: sumProviderCallCost(providerCalls),
              updatedAt: new Date().toISOString(),
              ...(normalizedError ? { error: normalizedError } : {}),
            } satisfies ProviderCallState);
          };
          await writeCallState("running");
          let result;
          try {
            result = await runLunaBoundedRepositoryClassification({
              repository: path.resolve(required(args, "--repository")),
              episode,
              profile,
              cards,
              arm: job.arm,
              seed: job.seed,
              price,
              ...(job.arm === "candidate_read"
                ? { candidatePaths: candidatePathsFromEpisode(episode) }
                : job.arm === "integrated_contrastive"
                  ? { candidatePaths: candidatePathsFromEpisode(episode) }
                : {}),
              options: {
                onProviderCall: async (call) => {
                  providerCalls.push(call);
                  await writeCallState("running");
                },
              },
            });
          } catch (error) {
            await writeCallState("failed", error);
            throw error;
          }
          const record: ExperimentRecord = {
            schemaVersion: 1,
            arm: job.arm,
            seed: job.seed,
            prediction: result.prediction,
            trace: result.trace,
          };
          await writeAtomic(
            recordFile(
              outputDirectory,
              job.arm,
              job.seed,
              job.episodeId,
            ),
            record,
          );
          await writeCallState("completed");
          console.error(
            JSON.stringify({
              completed: index + 1,
              pending: pending.length,
              arm: job.arm,
              seed: job.seed,
              episodeId: job.episodeId,
              providerCalls: result.prediction.providerCalls,
              costUsd: result.prediction.costUsd,
            }),
          );
        }
      },
    );
    const workerResults = await Promise.allSettled(workers);
    const failedWorker = workerResults.find(
      (result): result is PromiseRejectedResult =>
        result.status === "rejected",
    );
    if (failedWorker) throw failedWorker.reason;
    const actualCostUsd = await costForJobs(outputDirectory, pending);
    await ledger.settle(maximumCostUsd, actualCostUsd);
    settled = true;
    const afterStatus = await getOpenRouterKeyStatus();
    const report = await analyze({
      outputDirectory,
      labels: selectedLabels,
      cards,
      arms,
      seeds,
    });
    await writeAtomic(path.join(outputDirectory, "cost.json"), {
      schemaVersion: 1,
      maximumCostUsd,
      actualCostUsd,
      keyStatusBefore: beforeStatus,
      keyStatusAfter: afterStatus,
      meteringPolicy:
        "Per-call OpenRouter usage cost when present, otherwise API-equivalent catalog cost",
    });
    console.log(JSON.stringify({ ok: true, report }, null, 2));
  } catch (error) {
    if (!settled) {
      const actualCostUsd = await costForJobs(outputDirectory, pending);
      await ledger.settle(maximumCostUsd, actualCostUsd);
    }
    throw error;
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
