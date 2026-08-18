#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  VercelBlobArtifactStore,
  readJsonArtifact
} from "@velum-labs/routekit-eval-store/platform";
import {
  evaluateGroupedCompositionPredictions,
  extractCompositionPrediction,
  renderGroupedCompositionMetrics
} from "@velum-labs/routekit-eval-core/experiment";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const baseUrl = (
  process.env.EXPERIMENT_PLATFORM_URL ??
  "https://routekit-experiments-development.vercel.app"
).replace(/\/$/u, "");
const token = process.env.EXPERIMENT_PLATFORM_API_TOKEN;
if (!token) throw new Error("EXPERIMENT_PLATFORM_API_TOKEN is required");
if (!process.env.BLOB_READ_WRITE_TOKEN && !process.env.VERCEL_OIDC_TOKEN) {
  throw new Error("Vercel Blob credentials are required");
}

const experimentIds =
  process.argv.slice(2).length > 0
    ? process.argv.slice(2)
    : [
        "area-taxonomy-backstage-canary-10-v1",
        "area-taxonomy-backstage-screening-remainder-14-v1"
      ];
const outputRoot = path.join(
  repositoryRoot,
  ".routekit-experiment-assets/area-taxonomy-20260818/results"
);

async function fetchExperiment(experimentId) {
  const response = await fetch(
    `${baseUrl}/api/experiments/${encodeURIComponent(experimentId)}`,
    { headers: { authorization: `Bearer ${token}` } }
  );
  if (!response.ok) {
    throw new Error(
      `failed to read ${experimentId}: ${response.status} ${(await response.text()).slice(0, 1000)}`
    );
  }
  const snapshot = await response.json();
  if (snapshot.experiment?.status !== "completed") {
    throw new Error(`${experimentId} is ${snapshot.experiment?.status ?? "unknown"}, not completed`);
  }
  return snapshot;
}

async function mapWithConcurrency(values, concurrency, operation) {
  let next = 0;
  const outputs = Array.from({ length: values.length });
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (next < values.length) {
        const index = next;
        next += 1;
        outputs[index] = await operation(values[index], index);
      }
    }
  );
  await Promise.all(workers);
  return outputs;
}

function segmentForMetadata(metadata) {
  if (metadata?.cohort !== "synthetic_composite") return "real";
  const kind = metadata.syntheticKind;
  return typeof kind === "string" && kind.length > 0 ? `synthetic_${kind}` : "synthetic";
}

function compactTreatmentMetrics(groups) {
  return groups.flatMap((group) =>
    group.metrics.treatments.map((treatment) => ({
      comparisonGroup: group.comparisonGroup,
      treatmentId: treatment.treatmentId,
      pairedPredictions: treatment.pairedPredictions,
      contractValidity: treatment.contractValidity.rate,
      meanCosineSimilarity: treatment.meanCosineSimilarity,
      meanAllAreaAbsoluteError: treatment.meanAllAreaAbsoluteError,
      meanActiveAreaAbsoluteError: treatment.meanActiveAreaAbsoluteError,
      activeAreaF1: treatment.activeAreaF1,
      topAreaAgreement: treatment.topAreaAgreement?.rate,
      meanTopTwoOverlap: treatment.meanTopTwoOverlap,
      allActiveAreasAt3: treatment.allActiveAreasAt3?.rate,
      meanUnknownAbsoluteError: treatment.meanUnknownAbsoluteError,
      unknownAgreementAtPointFive: treatment.unknownAgreementAtPointFive?.rate,
      medianLatencyMs: treatment.medianLatencyMs,
      providerCostUsd: treatment.providerCostUsd
    }))
  );
}

const snapshots = await Promise.all(experimentIds.map(fetchExperiment));
const datasetHashes = new Set(
  snapshots.map((snapshot) => snapshot.experiment.manifest.dataset.hash)
);
if (datasetHashes.size !== 1) throw new Error("experiment dataset hashes differ");

const metadataByTask = new Map();
for (const snapshot of snapshots) {
  for (const task of snapshot.experiment.manifest.tasks) {
    if (metadataByTask.has(task.id)) throw new Error(`task ${task.id} appears in multiple runs`);
    metadataByTask.set(task.id, task.metadata);
  }
}

const records = snapshots.flatMap((snapshot) => snapshot.jobs);
const failed = records.filter((record) => record.status !== "succeeded");
if (failed.length > 0) {
  throw new Error(`${failed.length} jobs were not successful`);
}
const withOutputs = records.filter((record) => record.outputArtifact !== undefined);
if (withOutputs.length !== records.length) throw new Error("one or more jobs has no output artifact");

const store = new VercelBlobArtifactStore();
const decoded = await mapWithConcurrency(withOutputs, 24, async (record) => ({
  record,
  raw: await readJsonArtifact(store, record.outputArtifact)
}));

const compositionEntries = [];
let neutralReferences = 0;
for (const { record, raw } of decoded) {
  const evaluationRole = record.job.configuration.evaluationRole;
  if (evaluationRole === "neutral_reference") {
    neutralReferences += 1;
    continue;
  }
  if (
    evaluationRole !== "composition_reference" &&
    evaluationRole !== "composition_candidate"
  ) {
    continue;
  }
  compositionEntries.push({
    comparisonGroup:
      typeof record.job.configuration.comparisonGroup === "string"
        ? record.job.configuration.comparisonGroup
        : "default",
    treatmentId: record.job.treatmentId,
    taskId: record.job.taskId,
    seed: record.job.seed,
    evaluationRole,
    prediction: extractCompositionPrediction(raw),
    latencyMs: record.latencyMs ?? 0,
    providerCostUsd: record.providerCostUsd,
    infrastructureCostUsd: record.infrastructureCostUsd
  });
}

const segments = new Map([["all", compositionEntries]]);
for (const entry of compositionEntries) {
  const segment = segmentForMetadata(metadataByTask.get(entry.taskId));
  const current = segments.get(segment) ?? [];
  current.push(entry);
  segments.set(segment, current);
  const broad = segment.startsWith("synthetic_") ? "synthetic_all" : undefined;
  if (broad) {
    const broadEntries = segments.get(broad) ?? [];
    broadEntries.push(entry);
    segments.set(broad, broadEntries);
  }
}

const segmentMetrics = Object.fromEntries(
  [...segments.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([segment, entries]) => [
      segment,
      {
        taskCount: new Set(entries.map((entry) => entry.taskId)).size,
        compositionAttempts: entries.length,
        groups: evaluateGroupedCompositionPredictions(entries)
      }
    ])
);
const allGroups = segmentMetrics.all.groups;
const providerCostUsd = snapshots.reduce(
  (sum, snapshot) => sum + snapshot.experiment.providerSpentUsd,
  0
);
const infrastructureCostUsd = snapshots.reduce(
  (sum, snapshot) => sum + snapshot.experiment.infrastructureSpentUsd,
  0
);

const result = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  experimentIds,
  datasetHash: [...datasetHashes][0],
  tasks: metadataByTask.size,
  jobs: records.length,
  neutralReferences,
  compositionAttempts: compositionEntries.length,
  providerCostUsd,
  infrastructureCostUsd,
  treatments: compactTreatmentMetrics(allGroups),
  segments: segmentMetrics
};

const report = [
  "# Combined area-taxonomy pilot",
  "",
  `- Experiments: ${experimentIds.map((id) => `\`${id}\``).join(", ")}`,
  `- Unique tasks: ${metadataByTask.size}`,
  `- Successful jobs: ${records.length}/${records.length}`,
  `- Neutral Sol references: ${neutralReferences}`,
  `- Composition attempts: ${compositionEntries.length}`,
  `- Provider cost: $${providerCostUsd.toFixed(4)}`,
  `- Infrastructure cost: $${infrastructureCostUsd.toFixed(4)}`,
  `- Dataset hash: \`${[...datasetHashes][0]}\``,
  "",
  "## All 24 tasks",
  "",
  renderGroupedCompositionMetrics(allGroups).trim(),
  "",
  ...[...segments.entries()]
    .filter(([segment]) => segment !== "all")
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([segment, entries]) => [
      `## Segment: ${segment}`,
      "",
      `Tasks: ${new Set(entries.map((entry) => entry.taskId)).size}`,
      "",
      renderGroupedCompositionMetrics(segmentMetrics[segment].groups).trim(),
      ""
    ])
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
      tasks: result.tasks,
      jobs: result.jobs,
      neutralReferences,
      compositionAttempts: result.compositionAttempts,
      providerCostUsd,
      infrastructureCostUsd
    },
    null,
    2
  )
);
