#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  evaluateGroupedCompositionPredictions,
  extractCompositionPrediction
} from "@velum-labs/routekit-eval-core/experiment";
import {
  readJsonArtifact,
  VercelBlobArtifactStore
} from "@velum-labs/routekit-eval-store/platform";

const root = path.resolve(import.meta.dirname, "../../..");
const outputRoot = path.join(
  root,
  ".routekit-experiment-assets/onboarding-followups-20260819/results"
);
const baseUrl = (
  process.env.EXPERIMENT_PLATFORM_URL ?? "https://routekit-experiments-development.vercel.app"
).replace(/\/$/u, "");
const token = process.env.EXPERIMENT_PLATFORM_API_TOKEN;
if (!token) throw new Error("EXPERIMENT_PLATFORM_API_TOKEN is required");
if (!process.env.BLOB_READ_WRITE_TOKEN && !process.env.VERCEL_OIDC_TOKEN) {
  throw new Error("Vercel Blob credentials are required");
}

const defaultExperimentIds = [
  "onboarding-common-reference-backstage-60-v1",
  "onboarding-unknown-benchmark-60-v1",
  "onboarding-structure-matrix-100-v1",
  "onboarding-area-card-ablation-100-v1",
  "onboarding-generation-comparison-real-58-v1"
];
const experimentIds =
  process.argv.slice(2).length > 0 ? process.argv.slice(2) : defaultExperimentIds;

const mean = (values) =>
  values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0) / values.length;

function round(value, places = 6) {
  return value === undefined ? undefined : Number(value.toFixed(places));
}

function predictionKey(entry) {
  return `${entry.comparisonGroup}\u0000${entry.taskId}\u0000${entry.seed}`;
}

async function mapWithConcurrency(values, concurrency, operation) {
  const results = Array.from({ length: values.length });
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await operation(values[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function fetchExperiment(experimentId) {
  const response = await fetch(`${baseUrl}/api/experiments/${experimentId}`, {
    headers: { authorization: `Bearer ${token}` }
  });
  if (!response.ok) {
    throw new Error(`failed to read ${experimentId}: ${response.status}`);
  }
  const snapshot = await response.json();
  if (!["completed", "failed"].includes(snapshot.experiment?.status)) {
    throw new Error(`${experimentId} is ${snapshot.experiment?.status}, not terminal`);
  }
  const unsuccessful = snapshot.jobs.filter((record) => record.status !== "succeeded");
  if (unsuccessful.length > 0) {
    throw new Error(`${experimentId} has ${unsuccessful.length} unsuccessful jobs`);
  }
  return snapshot;
}

function segmentNames(metadata) {
  return [
    "all",
    `repository:${metadata?.repositoryId ?? "unknown"}`,
    `cohort:${metadata?.cohort ?? "unknown"}`,
    ...(metadata?.syntheticKind ? [`synthetic-kind:${metadata.syntheticKind}`] : [])
  ];
}

function referenceSummary(entries) {
  const predictions = entries
    .filter(
      (entry) => entry.evaluationRole === "composition_reference" && entry.prediction !== undefined
    )
    .map((entry) => entry.prediction);
  return {
    predictions: predictions.length,
    meanUnknownProbability: round(
      mean(predictions.map((prediction) => prediction.unknownProbability))
    ),
    meanActiveAreaCount: round(
      mean(
        predictions.map(
          (prediction) =>
            Object.values(prediction.areaCompositionScores).filter((score) => score >= 0.25).length
        )
      )
    ),
    meanKnownScoreMass: round(
      mean(
        predictions.map((prediction) =>
          Object.values(prediction.areaCompositionScores).reduce((sum, score) => sum + score, 0)
        )
      )
    ),
    meanTopAreaScore: round(
      mean(
        predictions.map((prediction) =>
          Math.max(...Object.values(prediction.areaCompositionScores))
        )
      )
    )
  };
}

function thresholdMetric(pairs, threshold) {
  let correct = 0;
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  for (const { candidate, reference } of pairs) {
    const predicted = candidate >= threshold;
    const expected = reference >= threshold;
    if (predicted === expected) correct += 1;
    if (predicted && expected) truePositive += 1;
    else if (predicted) falsePositive += 1;
    else if (expected) falseNegative += 1;
  }
  const precision =
    truePositive + falsePositive === 0 ? 0 : truePositive / (truePositive + falsePositive);
  const recall =
    truePositive + falseNegative === 0 ? 0 : truePositive / (truePositive + falseNegative);
  return {
    accuracy: round(pairs.length === 0 ? 0 : correct / pairs.length),
    precision: round(precision),
    recall: round(recall),
    f1: round(precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall))
  };
}

function unknownCalibration(entries) {
  const references = new Map(
    entries
      .filter(
        (entry) =>
          entry.evaluationRole === "composition_reference" && entry.prediction !== undefined
      )
      .map((entry) => [predictionKey(entry), entry.prediction])
  );
  const pairs = entries.flatMap((entry) => {
    if (entry.evaluationRole !== "composition_candidate" || entry.prediction === undefined) {
      return [];
    }
    const reference = references.get(predictionKey(entry));
    return reference === undefined
      ? []
      : [
          {
            candidate: entry.prediction.unknownProbability,
            reference: reference.unknownProbability
          }
        ];
  });
  return {
    pairs: pairs.length,
    softBrier: round(mean(pairs.map((pair) => (pair.candidate - pair.reference) ** 2))),
    meanAbsoluteError: round(mean(pairs.map((pair) => Math.abs(pair.candidate - pair.reference)))),
    thresholds: Object.fromEntries(
      [0.3, 0.5, 0.7].map((threshold) => [threshold.toFixed(1), thresholdMetric(pairs, threshold)])
    )
  };
}

function treatmentSummary(group) {
  return group.metrics.treatments.map((treatment) => ({
    treatmentId: treatment.treatmentId,
    attempts: treatment.attempts,
    validPredictions: treatment.validPredictions,
    pairedPredictions: treatment.pairedPredictions,
    meanCosineSimilarity: round(treatment.meanCosineSimilarity),
    meanAllAreaAbsoluteError: round(treatment.meanAllAreaAbsoluteError),
    meanActiveAreaAbsoluteError: round(treatment.meanActiveAreaAbsoluteError),
    meanInactiveAreaAbsoluteError: round(treatment.meanInactiveAreaAbsoluteError),
    activeAreaPrecision: round(treatment.activeAreaPrecision),
    activeAreaRecall: round(treatment.activeAreaRecall),
    activeAreaF1: round(treatment.activeAreaF1),
    topAreaAgreement: round(treatment.topAreaAgreement?.rate),
    meanTopTwoOverlap: round(treatment.meanTopTwoOverlap),
    allActiveAreasAt3: round(treatment.allActiveAreasAt3?.rate),
    meanUnknownAbsoluteError: round(treatment.meanUnknownAbsoluteError),
    unknownAgreementAtPointFive: round(treatment.unknownAgreementAtPointFive?.rate),
    medianLatencyMs: treatment.medianLatencyMs,
    providerCostUsd: round(treatment.providerCostUsd)
  }));
}

function analyzeEntries(entries) {
  return evaluateGroupedCompositionPredictions(entries).map((group) => {
    const groupEntries = entries.filter((entry) => entry.comparisonGroup === group.comparisonGroup);
    return {
      comparisonGroup: group.comparisonGroup,
      reference: referenceSummary(groupEntries),
      treatments: treatmentSummary(group),
      unknownCalibration: unknownCalibration(groupEntries)
    };
  });
}

const snapshots = await Promise.all(experimentIds.map(fetchExperiment));
const store = new VercelBlobArtifactStore();
const experiments = [];

for (const snapshot of snapshots) {
  const metadataByTask = new Map(
    snapshot.experiment.manifest.tasks.map((task) => [task.id, task.metadata])
  );
  const records = await mapWithConcurrency(snapshot.jobs, 24, async (record) => {
    const raw = await readJsonArtifact(store, record.outputArtifact);
    const role = record.job.configuration.evaluationRole;
    if (!["composition_reference", "composition_candidate"].includes(role)) {
      return undefined;
    }
    return {
      treatmentId: record.job.treatmentId,
      comparisonGroup:
        typeof record.job.configuration.comparisonGroup === "string"
          ? record.job.configuration.comparisonGroup
          : "default",
      taskId: record.job.taskId,
      seed: record.job.seed,
      evaluationRole: role,
      prediction: extractCompositionPrediction(raw),
      latencyMs: record.latencyMs ?? 0,
      providerCostUsd: record.providerCostUsd,
      infrastructureCostUsd: record.infrastructureCostUsd
    };
  });
  const entries = records.filter(Boolean);
  const segments = new Map();
  for (const entry of entries) {
    for (const segment of segmentNames(metadataByTask.get(entry.taskId))) {
      const current = segments.get(segment) ?? [];
      current.push(entry);
      segments.set(segment, current);
    }
  }
  experiments.push({
    experimentId: snapshot.experiment.experimentId,
    status: snapshot.experiment.status,
    tasks: snapshot.experiment.manifest.tasks.length,
    jobs: snapshot.jobs.length,
    providerCostUsd: round(snapshot.experiment.providerSpentUsd),
    infrastructureCostUsd: round(snapshot.experiment.infrastructureSpentUsd),
    groups: analyzeEntries(entries),
    segments: Object.fromEntries(
      [...segments.entries()]
        .filter(([segment]) => segment !== "all")
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([segment, segmentEntries]) => [
          segment,
          {
            tasks: new Set(segmentEntries.map((entry) => entry.taskId)).size,
            groups: analyzeEntries(segmentEntries)
          }
        ])
    )
  });
}

const totalProviderCostUsd = round(
  experiments.reduce((sum, experiment) => sum + experiment.providerCostUsd, 0)
);
const totalInfrastructureCostUsd = round(
  experiments.reduce((sum, experiment) => sum + experiment.infrastructureCostUsd, 0)
);
const result = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  experiments,
  totalProviderCostUsd,
  totalInfrastructureCostUsd
};

const rows = experiments.flatMap((experiment) =>
  experiment.groups.flatMap((group) =>
    group.treatments.map((treatment) => ({
      experimentId: experiment.experimentId,
      comparisonGroup: group.comparisonGroup,
      reference: group.reference,
      ...treatment
    }))
  )
);
const decimal = (value) => (value === undefined ? "n/a" : Number(value).toFixed(4));
const report = [
  "# Onboarding follow-up experiments",
  "",
  `- Experiments: ${experiments.length}`,
  `- Successful jobs: ${experiments.reduce((sum, experiment) => sum + experiment.jobs, 0)}`,
  `- Provider cost: $${totalProviderCostUsd.toFixed(4)}`,
  `- Infrastructure cost: $${totalInfrastructureCostUsd.toFixed(4)}`,
  "",
  "Luna candidates are compared with a Sol reference produced from the frozen taxonomy-neutral responsibility decomposition. Lower MAE is better; higher cosine, F1, and agreement are better.",
  "",
  "| Experiment | Registry/treatment | Pairs | Active MAE | Cosine | Active F1 | Top area | Unknown MAE | Reference unknown | Reference active areas | Luna cost |",
  "| -- | -- | --: | --: | --: | --: | --: | --: | --: | --: | --: |",
  ...rows.map(
    (row) =>
      `| ${row.experimentId} | ${row.comparisonGroup} / ${row.treatmentId} | ${row.pairedPredictions} | ${decimal(
        row.meanActiveAreaAbsoluteError
      )} | ${decimal(row.meanCosineSimilarity)} | ${decimal(
        row.activeAreaF1
      )} | ${decimal(row.topAreaAgreement)} | ${decimal(
        row.meanUnknownAbsoluteError
      )} | ${decimal(row.reference.meanUnknownProbability)} | ${decimal(
        row.reference.meanActiveAreaCount
      )} | $${decimal(row.providerCostUsd)} |`
  ),
  "",
  "## Interpretation guardrails",
  "",
  "- Low Luna-versus-Sol error measures runtime classifiability, not whether the taxonomy is useful for downstream routing.",
  "- Reference unknown probability estimates coverage. Lower is not automatically better because a vague catch-all area can hide genuine out-of-distribution work.",
  "- Reference active-area count measures fragmentation at the 0.25 threshold. Very high values can indicate excessive overlap; very low values can indicate overly coarse areas.",
  "- Repository, cohort, and synthetic-kind breakdowns are preserved in the JSON artifact.",
  ""
].join("\n");

await mkdir(outputRoot, { recursive: true, mode: 0o700 });
const metricsFile = path.join(outputRoot, "combined-metrics.json");
const reportFile = path.join(outputRoot, "combined-report.md");
await Promise.all([
  writeFile(metricsFile, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 }),
  writeFile(reportFile, `${report}\n`, { mode: 0o600 })
]);

console.log(
  JSON.stringify(
    {
      ok: true,
      metricsFile,
      reportFile,
      experiments: experiments.length,
      jobs: experiments.reduce((sum, experiment) => sum + experiment.jobs, 0),
      totalProviderCostUsd,
      totalInfrastructureCostUsd
    },
    null,
    2
  )
);
