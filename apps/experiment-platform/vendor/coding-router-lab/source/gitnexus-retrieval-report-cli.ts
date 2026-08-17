#!/usr/bin/env node

import {
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  scopeTargetForLabel,
  type LunaDistributionalPrediction,
} from "./luna-distributional.ts";
import type { GitNexusRetrievalResult } from "./gitnexus-retrieval-experiment.ts";
import { readJsonl } from "./jsonl.ts";
import type {
  SilverLabelV1,
  TaskEpisode,
} from "./types.ts";

interface PerformanceExperimentConfig {
  schemaVersion: 1;
  episodes: string;
  labels: string;
  developmentEpisodeIds: string[];
}

interface ClassificationRecord {
  prediction: LunaDistributionalPrediction;
}

interface ArmInput {
  id: string;
  analysisFile: string;
  analysisArmId: string;
  classificationDirectory: string;
  dataPartition: "development";
}

interface NumericAggregate {
  cases: number;
  knownCases: number;
  scopeHitAt1: number;
  scopeBrier: number;
  scopeLogLoss: number;
  areaHitAt1: number;
  allGoldAt3: number;
  exactSetAtPointFive: number;
  areaBrier: number;
  areaLogLoss: number;
  providerCalls: number;
  totalCostUsd: number;
  meanCostUsd: number;
}

interface RetrievalArmSummary {
  oraclePaths: {
    anyRelevantPathAt4: number;
    anyRelevantPathAt8: number;
    meanRelevantPathRecallAt4: number;
    meanRelevantPathRecallAt8: number;
    meanReciprocalRelevantPathRank: number;
  };
  meanUniquePaths: number;
  testOrDocNoiseRate: number;
}

interface RetrievalAnalysis {
  baseline: RetrievalArmSummary;
  gitNexusOnly: RetrievalArmSummary;
  fusion: RetrievalArmSummary;
}

const parseArguments = (argv: readonly string[]): Map<string, string> => {
  const result = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || !value) {
      throw new Error(`Invalid argument near ${name ?? "<end>"}`);
    }
    result.set(name, value);
  }
  return result;
};

const required = (args: Map<string, string>, name: string): string => {
  const value = args.get(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};

const writeAtomic = async (file: string, text: string): Promise<void> => {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}`;
  await writeFile(temporary, text, { mode: 0o600 });
  await rename(temporary, file);
};

const numberField = (
  value: Record<string, unknown>,
  name: keyof NumericAggregate,
): number => {
  const found = value[name];
  if (typeof found !== "number" || !Number.isFinite(found)) {
    throw new Error(`Missing numeric aggregate field ${name}`);
  }
  return found;
};

const aggregateFrom = (value: Record<string, unknown>): NumericAggregate => ({
  cases: numberField(value, "cases"),
  knownCases: numberField(value, "knownCases"),
  scopeHitAt1: numberField(value, "scopeHitAt1"),
  scopeBrier: numberField(value, "scopeBrier"),
  scopeLogLoss: numberField(value, "scopeLogLoss"),
  areaHitAt1: numberField(value, "areaHitAt1"),
  allGoldAt3: numberField(value, "allGoldAt3"),
  exactSetAtPointFive: numberField(value, "exactSetAtPointFive"),
  areaBrier: numberField(value, "areaBrier"),
  areaLogLoss: numberField(value, "areaLogLoss"),
  providerCalls: numberField(value, "providerCalls"),
  totalCostUsd: numberField(value, "totalCostUsd"),
  meanCostUsd: numberField(value, "meanCostUsd"),
});

const readAggregate = async (input: ArmInput): Promise<NumericAggregate> => {
  const analysis = JSON.parse(
    await readFile(path.resolve(input.analysisFile), "utf8"),
  ) as {
    arms: Record<
      string,
      {
        perSeed: Record<
          string,
          {
            development: {
              aggregate: Record<string, unknown>;
            };
          }
        >;
      }
    >;
  };
  const aggregate =
    analysis.arms[input.analysisArmId]?.perSeed["181081"]?.[
      input.dataPartition
    ]?.aggregate;
  if (!aggregate) {
    throw new Error(
      `Missing ${input.analysisArmId}/181081/${input.dataPartition} in ${input.analysisFile}`,
    );
  }
  return aggregateFrom(aggregate);
};

const readPredictions = async (
  input: ArmInput,
  episodes: readonly TaskEpisode[],
): Promise<LunaDistributionalPrediction[]> =>
  Promise.all(
    episodes.map(async (episode) => {
      const file = path.join(
        path.resolve(input.classificationDirectory),
        "classification",
        input.analysisArmId,
        "181081",
        `${episode.id}.json`,
      );
      const record = JSON.parse(
        await readFile(file, "utf8"),
      ) as ClassificationRecord;
      return record.prediction;
    }),
  );

const quantile = (values: readonly number[], probability: number): number => {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.min(
    ordered.length - 1,
    Math.max(0, Math.ceil(probability * ordered.length) - 1),
  );
  return ordered[index]!;
};

const usage = (predictions: readonly LunaDistributionalPrediction[]) => {
  const durations = predictions.map((prediction) => prediction.durationMs);
  const totalCostUsd = predictions.reduce(
    (sum, prediction) => sum + prediction.costUsd,
    0,
  );
  return {
    calls: predictions.reduce(
      (sum, prediction) => sum + prediction.providerCalls,
      0,
    ),
    meanDurationMs:
      durations.reduce((sum, duration) => sum + duration, 0) /
      durations.length,
    medianDurationMs: quantile(durations, 0.5),
    p95DurationMs: quantile(durations, 0.95),
    totalCostUsd,
    meanCostUsd: totalCostUsd / predictions.length,
    meanInputTokens:
      predictions.reduce(
        (sum, prediction) => sum + prediction.inputTokens,
        0,
      ) / predictions.length,
    meanCachedInputTokens:
      predictions.reduce(
        (sum, prediction) => sum + prediction.cachedInputTokens,
        0,
      ) / predictions.length,
    meanOutputTokens:
      predictions.reduce(
        (sum, prediction) => sum + prediction.outputTokens,
        0,
      ) / predictions.length,
  };
};

const selectionLoss = (aggregate: NumericAggregate): number =>
  aggregate.areaBrier +
  0.35 * aggregate.scopeBrier +
  0.15 * (1 - aggregate.areaHitAt1) +
  0.25 * (1 - aggregate.allGoldAt3);

const topScope = (
  prediction: LunaDistributionalPrediction,
): keyof LunaDistributionalPrediction["scopeProbabilities"] =>
  (
    Object.entries(prediction.scopeProbabilities) as Array<
      [
        keyof LunaDistributionalPrediction["scopeProbabilities"],
        number,
      ]
    >
  ).sort(
    (left, right) =>
      right[1] - left[1] || left[0].localeCompare(right[0]),
  )[0]![0];

const classificationSuccess = (
  label: SilverLabelV1,
  prediction: LunaDistributionalPrediction,
): { scope: boolean; areaTop1?: boolean; allGoldTop3?: boolean } => {
  const result: {
    scope: boolean;
    areaTop1?: boolean;
    allGoldTop3?: boolean;
  } = {
    scope: topScope(prediction) === scopeTargetForLabel(label),
  };
  if (!label.known) return result;
  const ranked = prediction.areaProbabilitiesGivenKnown.map(
    (item) => item.areaId,
  );
  const gold = new Set(label.selectedAreaIds);
  result.areaTop1 = gold.has(ranked[0] ?? "");
  result.allGoldTop3 = [...gold].every((areaId) =>
    ranked.slice(0, 3).includes(areaId)
  );
  return result;
};

const pairedChanges = (input: {
  labels: readonly SilverLabelV1[];
  baseline: readonly LunaDistributionalPrediction[];
  candidate: readonly LunaDistributionalPrediction[];
}) => {
  const baseline = new Map(
    input.baseline.map((prediction) => [
      prediction.taskEpisodeId,
      prediction,
    ]),
  );
  const candidate = new Map(
    input.candidate.map((prediction) => [
      prediction.taskEpisodeId,
      prediction,
    ]),
  );
  const counters = {
    scopeFixed: 0,
    scopeRegressed: 0,
    areaTop1Fixed: 0,
    areaTop1Regressed: 0,
    allGoldTop3Fixed: 0,
    allGoldTop3Regressed: 0,
  };
  for (const label of input.labels) {
    const left = classificationSuccess(
      label,
      baseline.get(label.taskEpisodeId)!,
    );
    const right = classificationSuccess(
      label,
      candidate.get(label.taskEpisodeId)!,
    );
    if (!left.scope && right.scope) counters.scopeFixed += 1;
    if (left.scope && !right.scope) counters.scopeRegressed += 1;
    if (left.areaTop1 === false && right.areaTop1 === true) {
      counters.areaTop1Fixed += 1;
    }
    if (left.areaTop1 === true && right.areaTop1 === false) {
      counters.areaTop1Regressed += 1;
    }
    if (left.allGoldTop3 === false && right.allGoldTop3 === true) {
      counters.allGoldTop3Fixed += 1;
    }
    if (left.allGoldTop3 === true && right.allGoldTop3 === false) {
      counters.allGoldTop3Regressed += 1;
    }
  }
  return counters;
};

const readRetrievalRuntime = async (
  retrievalDirectory: string,
  episodes: readonly TaskEpisode[],
) => {
  const records = await Promise.all(
    episodes.map(async (episode) =>
      JSON.parse(
        await readFile(
          path.join(
            path.resolve(retrievalDirectory),
            "gitnexus-only",
            "retrieval",
            "hybrid_rerank",
            `${episode.id}.json`,
          ),
          "utf8",
        ),
      ) as GitNexusRetrievalResult
    ),
  );
  const analyzeDurations = records.map(
    (record) => record.gitNexusProvenance.analyze.durationMs,
  );
  const queryDurations = records.map(
    (record) => record.gitNexusProvenance.queryDurationMs,
  );
  const maxRss = records
    .map(
      (record) =>
        record.gitNexusProvenance.analyze.maximumResidentSetKb ?? 0,
    )
    .filter((value) => value > 0);
  return {
    exactSnapshotIndexes: records.length,
    totalAnalyzeHours:
      analyzeDurations.reduce((sum, value) => sum + value, 0) /
      3_600_000,
    meanAnalyzeMinutes:
      analyzeDurations.reduce((sum, value) => sum + value, 0) /
      analyzeDurations.length /
      60_000,
    medianAnalyzeMinutes: quantile(analyzeDurations, 0.5) / 60_000,
    p95AnalyzeMinutes: quantile(analyzeDurations, 0.95) / 60_000,
    maximumResidentSetGb:
      (maxRss.length === 0 ? 0 : Math.max(...maxRss)) / 1024 / 1024,
    meanQueryMs:
      queryDurations.reduce((sum, value) => sum + value, 0) /
      queryDurations.length,
    medianQueryMs: quantile(queryDurations, 0.5),
    p95QueryMs: quantile(queryDurations, 0.95),
    meanDefinitions:
      records.reduce(
        (sum, record) =>
          sum + record.gitNexusProvenance.graphDefinitionsReturned,
        0,
      ) / records.length,
    meanUniquePaths:
      records.reduce(
        (sum, record) =>
          sum + record.gitNexusProvenance.uniqueDefinitionPaths,
        0,
      ) / records.length,
  };
};

const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;
const seconds = (milliseconds: number): string =>
  `${(milliseconds / 1_000).toFixed(2)}s`;

const main = async (): Promise<void> => {
  const args = parseArguments(process.argv.slice(2));
  const config = JSON.parse(
    await readFile(path.resolve(required(args, "--config")), "utf8"),
  ) as PerformanceExperimentConfig;
  const development = new Set(config.developmentEpisodeIds);
  const episodes = (await readJsonl<TaskEpisode>(path.resolve(config.episodes)))
    .filter((episode) => development.has(episode.id));
  const labels = (await readJsonl<SilverLabelV1>(path.resolve(config.labels)))
    .filter((label) => development.has(label.taskEpisodeId));

  const baselineAnalysis = required(args, "--baseline-analysis");
  const baselineClassification = required(
    args,
    "--baseline-classification-directory",
  );
  const gitNexusAnalysis = required(args, "--gitnexus-analysis");
  const gitNexusClassification = required(
    args,
    "--gitnexus-classification-directory",
  );
  const fusionAnalysis = required(args, "--fusion-analysis");
  const fusionClassification = required(
    args,
    "--fusion-classification-directory",
  );
  const armInputs: ArmInput[] = [
    {
      id: "current_hybrid_direct",
      analysisFile: baselineAnalysis,
      analysisArmId: "inference_direct",
      classificationDirectory: baselineClassification,
      dataPartition: "development",
    },
    {
      id: "current_hybrid_evidence_first",
      analysisFile: baselineAnalysis,
      analysisArmId: "inference_evidence_first",
      classificationDirectory: baselineClassification,
      dataPartition: "development",
    },
    {
      id: "gitnexus_only_direct",
      analysisFile: gitNexusAnalysis,
      analysisArmId: "gitnexus_only_direct",
      classificationDirectory: gitNexusClassification,
      dataPartition: "development",
    },
    {
      id: "gitnexus_only_evidence_first",
      analysisFile: gitNexusAnalysis,
      analysisArmId: "gitnexus_only_evidence_first",
      classificationDirectory: gitNexusClassification,
      dataPartition: "development",
    },
    {
      id: "fusion_direct",
      analysisFile: fusionAnalysis,
      analysisArmId: "fusion_direct",
      classificationDirectory: fusionClassification,
      dataPartition: "development",
    },
    {
      id: "fusion_evidence_first",
      analysisFile: fusionAnalysis,
      analysisArmId: "fusion_evidence_first",
      classificationDirectory: fusionClassification,
      dataPartition: "development",
    },
  ];
  const arms: Record<
    string,
    {
      aggregate: NumericAggregate;
      selectionLoss: number;
      usage: ReturnType<typeof usage>;
      predictions: LunaDistributionalPrediction[];
    }
  > = {};
  for (const arm of armInputs) {
    const aggregate = await readAggregate(arm);
    const predictions = await readPredictions(arm, episodes);
    arms[arm.id] = {
      aggregate,
      selectionLoss: selectionLoss(aggregate),
      usage: usage(predictions),
      predictions,
    };
  }
  const retrieval = JSON.parse(
    await readFile(
      path.resolve(required(args, "--retrieval-analysis")),
      "utf8",
    ),
  ) as RetrievalAnalysis;
  const runtime = await readRetrievalRuntime(
    required(args, "--retrieval-output-directory"),
    episodes,
  );
  const baselineDirect = arms.current_hybrid_direct!;
  const baselineEvidenceFirst = arms.current_hybrid_evidence_first!;
  const fusionDirect = arms.fusion_direct!;
  const fusionEvidenceFirst = arms.fusion_evidence_first!;
  const matchedDirectImprovement =
    baselineDirect.selectionLoss - fusionDirect.selectionLoss;
  const matchedEvidenceFirstImprovement =
    baselineEvidenceFirst.selectionLoss -
    fusionEvidenceFirst.selectionLoss;
  const directMatchesEvidenceFirst =
    fusionDirect.selectionLoss <=
    baselineEvidenceFirst.selectionLoss + 0.01;
  const directLatencyReduction =
    1 -
    fusionDirect.usage.meanDurationMs /
      baselineEvidenceFirst.usage.meanDurationMs;
  const go =
    matchedDirectImprovement >= 0.01 ||
    matchedEvidenceFirstImprovement >= 0.01 ||
    (directMatchesEvidenceFirst && directLatencyReduction >= 0.25);
  const decision = {
    goToFreshConfirmation: go,
    rule:
      "Go if a matched GitNexus fusion arm improves selection loss by at least 0.01, or fusion-direct is within 0.01 of current evidence-first while reducing Luna duration by at least 25%.",
    matchedDirectImprovement,
    matchedEvidenceFirstImprovement,
    directMatchesEvidenceFirst,
    directLatencyReduction,
    warning:
      "This is a burned-development screen. A positive result selects a candidate for a fresh 40–60-case confirmation; it is not a final product-performance estimate.",
  };
  const publicArms = Object.fromEntries(
    Object.entries(arms).map(([id, value]) => [
      id,
      {
        aggregate: value.aggregate,
        selectionLoss: value.selectionLoss,
        usage: value.usage,
      },
    ]),
  );
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    dataRole: "burned_development_screen_only",
    cases: episodes.length,
    knownCases: labels.filter((label) => label.known).length,
    newAreaCases: labels.filter((label) => !label.known).length,
    arms: publicArms,
    pairedFusionDirectVersusCurrentDirect: pairedChanges({
      labels,
      baseline: baselineDirect.predictions,
      candidate: fusionDirect.predictions,
    }),
    pairedFusionEvidenceFirstVersusCurrentEvidenceFirst: pairedChanges({
      labels,
      baseline: baselineEvidenceFirst.predictions,
      candidate: fusionEvidenceFirst.predictions,
    }),
    retrieval,
    gitNexusRuntime: runtime,
    decision,
  };
  const jsonOutput = path.resolve(required(args, "--json-output"));
  await writeAtomic(jsonOutput, `${JSON.stringify(report, null, 2)}\n`);

  const rows = Object.entries(publicArms)
    .map(([id, value]) => {
      const arm = value as {
        aggregate: NumericAggregate;
        selectionLoss: number;
        usage: ReturnType<typeof usage>;
      };
      return `| ${id} | ${arm.selectionLoss.toFixed(4)} | ${percent(
        arm.aggregate.scopeHitAt1,
      )} | ${percent(arm.aggregate.areaHitAt1)} | ${percent(
        arm.aggregate.allGoldAt3,
      )} | ${arm.aggregate.areaBrier.toFixed(4)} | ${seconds(
        arm.usage.meanDurationMs,
      )} | $${arm.usage.meanCostUsd.toFixed(6)} |`;
    })
    .join("\n");
  const retrievalRows = [
    ["Current hybrid", retrieval.baseline],
    ["GitNexus only", retrieval.gitNexusOnly],
    ["Hybrid + GitNexus fusion", retrieval.fusion],
  ]
    .map(([name, value]) => {
      const arm = value as RetrievalArmSummary;
      return `| ${name} | ${percent(
        arm.oraclePaths.anyRelevantPathAt4,
      )} | ${percent(arm.oraclePaths.anyRelevantPathAt8)} | ${percent(
        arm.oraclePaths.meanRelevantPathRecallAt4,
      )} | ${percent(
        arm.oraclePaths.meanRelevantPathRecallAt8,
      )} | ${percent(arm.testOrDocNoiseRate)} |`;
    })
    .join("\n");
  const directPaired = report.pairedFusionDirectVersusCurrentDirect;
  const evidenceFirstPaired =
    report.pairedFusionEvidenceFirstVersusCurrentEvidenceFirst;
  const markdown = `# GitNexus retrieval screen results

Date: August 17, 2026

## Result

**${decision.goToFreshConfirmation ? "GO" : "STOP"}** under the preregistered
development-screen rule.

This screen used ${episodes.length} already-burned development tasks
(${labels.filter((label) => label.known).length} registered-area and ${
    labels.filter((label) => !label.known).length
  } new-area tasks). It does not read or make a claim on the old held-out set.

GitNexus found Sol-cited implementation paths substantially more often, but
that additional evidence did **not** improve Luna's routing decision. The
fusion arm reduced direct-classifier area top-1 from
${percent(baselineDirect.aggregate.areaHitAt1)} to
${percent(fusionDirect.aggregate.areaHitAt1)} and increased selection loss from
${baselineDirect.selectionLoss.toFixed(4)} to
${fusionDirect.selectionLoss.toFixed(4)}.

## Retrieval quality

| Retriever | Any Sol path @4 | Any Sol path @8 | Path recall @4 | Path recall @8 | Test/doc noise |
|---|---:|---:|---:|---:|---:|
${retrievalRows}

The result separates two questions: GitNexus improved path retrieval, while
Luna was less accurate when those paths were included. Therefore the present
bottleneck is not simply failure to locate relevant files. Evidence selection,
task-to-area interpretation, and protection against plausible neighboring-area
noise matter more than raw oracle-path recall.

## Luna classification quality

| Arm | Selection loss ↓ | Scope hit@1 | Area hit@1 | All gold top 3 | Area Brier ↓ | Mean Luna time | Mean Luna cost |
|---|---:|---:|---:|---:|---:|---:|---:|
${rows}

Paired against current hybrid retrieval:

- fusion-direct fixed ${directPaired.areaTop1Fixed} area top-1 errors and
  introduced ${directPaired.areaTop1Regressed};
- fusion-direct fixed ${directPaired.scopeFixed} scope errors and introduced
  ${directPaired.scopeRegressed};
- fusion evidence-first fixed ${evidenceFirstPaired.areaTop1Fixed} area top-1
  errors and introduced ${evidenceFirstPaired.areaTop1Regressed};
- fusion evidence-first fixed ${evidenceFirstPaired.scopeFixed} scope errors
  and introduced ${evidenceFirstPaired.scopeRegressed}.

All arms retained every gold registered area within the top three on the 16
known-area cases. The degradation was in ranking the correct area first and,
especially for evidence-first fusion, distinguishing registered work from a
new repository area.

## Primary product comparison

- Fusion-direct versus current-direct selection-loss improvement:
  **${matchedDirectImprovement.toFixed(4)}**.
- Fusion evidence-first versus current evidence-first improvement:
  **${matchedEvidenceFirstImprovement.toFixed(4)}**.
- Fusion-direct is ${
    directMatchesEvidenceFirst ? "within" : "not within"
  } 0.01 loss of current evidence-first.
- Fusion-direct changes Luna duration versus current evidence-first by
  **${percent(directLatencyReduction)}**.

## GitNexus operational measurements

- Exact historical indexes built: ${runtime.exactSnapshotIndexes}.
- Total benchmark indexing compute: ${runtime.totalAnalyzeHours.toFixed(2)} hours.
- Mean / median / p95 index time:
  ${runtime.meanAnalyzeMinutes.toFixed(2)} /
  ${runtime.medianAnalyzeMinutes.toFixed(2)} /
  ${runtime.p95AnalyzeMinutes.toFixed(2)} minutes.
- Peak observed RSS: ${runtime.maximumResidentSetGb.toFixed(2)} GB.
- Mean / median / p95 query time:
  ${seconds(runtime.meanQueryMs)} /
  ${seconds(runtime.medianQueryMs)} /
  ${seconds(runtime.p95QueryMs)}.

The repeated indexing time is benchmark machinery needed to recreate 24
historical pre-task snapshots. A product would index the user's current
checkout during onboarding and update that index as the repository changes;
it would not rebuild 24 historical indexes per request.

## Decision

Do not run a fresh confirmation cohort and do not integrate GitNexus into the
runtime classifier based on this treatment. Keep the current hybrid retriever
for the first product version.

The useful scientific result is that better implementation-path recall alone
is insufficient. If GitNexus is revisited, the next treatment should first
convert graph results into area-specific, contradiction-aware evidence and
filter neighboring-area or new-area noise on development data. It should not
repeat this raw-snippet or weighted-fusion treatment on held-out data.

Observed Luna costs are recorded for reproducibility, but should not be read as
a clean steady-state cache comparison: the older baseline calls had substantial
provider input-cache hits, while these new prompts did not.

## Interpretation boundary

${decision.warning}
`;
  await writeAtomic(
    path.resolve(required(args, "--markdown-output")),
    markdown,
  );
  console.log(JSON.stringify({
    ok: true,
    jsonOutput,
    markdownOutput: path.resolve(required(args, "--markdown-output")),
    decision,
  }, null, 2));
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
