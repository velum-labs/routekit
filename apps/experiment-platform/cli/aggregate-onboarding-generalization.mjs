#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
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
  ".routekit-experiment-assets/onboarding-generalization-20260819/results"
);
const registryAuditFile = path.join(
  root,
  ".routekit-experiment-assets/onboarding-generalization-20260819/evaluation/registry-audit.json"
);
const baseUrl = (
  process.env.EXPERIMENT_PLATFORM_URL ?? "https://routekit-experiments-development.vercel.app"
).replace(/\/$/u, "");
const token = process.env.EXPERIMENT_PLATFORM_API_TOKEN;
if (!token) throw new Error("EXPERIMENT_PLATFORM_API_TOKEN is required");
if (!process.env.BLOB_READ_WRITE_TOKEN && !process.env.VERCEL_OIDC_TOKEN) {
  throw new Error("Vercel Blob credentials are required");
}

const evaluationExperimentId = process.argv[2] ?? "onboarding-generalization-heldout-120-v1";
const constructionExperimentIds = [
  "onboarding-generalization-neutral-120-v1",
  "onboarding-generalization-registries-3-v1"
];
const mean = (values) =>
  values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0) / values.length;
const round = (value, places = 6) =>
  value === undefined ? undefined : Number(value.toFixed(places));

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

async function fetchExperiment(experimentId, requireJobs = true) {
  const response = await fetch(`${baseUrl}/api/experiments/${experimentId}`, {
    headers: { authorization: `Bearer ${token}` }
  });
  if (!response.ok) throw new Error(`failed to read ${experimentId}: ${response.status}`);
  const snapshot = await response.json();
  if (!["completed", "failed"].includes(snapshot.experiment?.status)) {
    throw new Error(`${experimentId} is ${snapshot.experiment?.status}, not terminal`);
  }
  if (requireJobs) {
    const unsuccessful = snapshot.jobs.filter((record) => record.status !== "succeeded");
    if (unsuccessful.length > 0) {
      throw new Error(`${experimentId} has ${unsuccessful.length} unsuccessful jobs`);
    }
  }
  return snapshot;
}

function predictionKey(entry) {
  return `${entry.comparisonGroup}\u0000${entry.taskId}\u0000${entry.seed}`;
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
    activeAreaPrecision: round(treatment.activeAreaPrecision),
    activeAreaRecall: round(treatment.activeAreaRecall),
    activeAreaF1: round(treatment.activeAreaF1),
    topAreaAgreement: round(treatment.topAreaAgreement?.rate),
    allActiveAreasAt3: round(treatment.allActiveAreasAt3?.rate),
    meanUnknownAbsoluteError: round(treatment.meanUnknownAbsoluteError),
    medianLatencyMs: treatment.medianLatencyMs,
    providerCostUsd: round(treatment.providerCostUsd)
  }));
}

function analyze(entries) {
  return evaluateGroupedCompositionPredictions(entries).map((group) => {
    const groupEntries = entries.filter((entry) => entry.comparisonGroup === group.comparisonGroup);
    return {
      comparisonGroup: group.comparisonGroup,
      reference: referenceSummary(groupEntries),
      treatments: treatmentSummary(group)
    };
  });
}

function activeAreaMae(candidate, reference) {
  const active = Object.entries(reference.areaCompositionScores)
    .filter(([, score]) => score >= 0.25)
    .map(([area]) => area);
  const areas = active.length > 0 ? active : Object.keys(reference.areaCompositionScores);
  return mean(
    areas.map((area) =>
      Math.abs(
        (candidate.areaCompositionScores[area] ?? 0) - (reference.areaCompositionScores[area] ?? 0)
      )
    )
  );
}

function pairedTaskErrors(entries) {
  const references = new Map(
    entries
      .filter(
        (entry) =>
          entry.evaluationRole === "composition_reference" && entry.prediction !== undefined
      )
      .map((entry) => [predictionKey(entry), entry.prediction])
  );
  return entries.flatMap((entry) => {
    if (entry.evaluationRole !== "composition_candidate" || entry.prediction === undefined) {
      return [];
    }
    const reference = references.get(predictionKey(entry));
    if (!reference) return [];
    return [
      {
        taskId: entry.taskId,
        repositoryId: entry.repositoryId,
        comparisonGroup: entry.comparisonGroup,
        activeAreaMae: activeAreaMae(entry.prediction, reference)
      }
    ];
  });
}

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

function bootstrapDelta(left, right, iterations = 2000) {
  const pairs = left
    .map((entry) => {
      const match = right.find((candidate) => candidate.taskId === entry.taskId);
      return match ? entry.activeAreaMae - match.activeAreaMae : undefined;
    })
    .filter((value) => value !== undefined);
  if (pairs.length === 0) return undefined;
  const sample = random(181081);
  const means = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let total = 0;
    for (let index = 0; index < pairs.length; index += 1) {
      total += pairs[Math.floor(sample() * pairs.length)];
    }
    means.push(total / pairs.length);
  }
  means.sort((a, b) => a - b);
  return {
    pairs: pairs.length,
    meanDelta: round(mean(pairs)),
    confidenceInterval95: [
      round(means[Math.floor(0.025 * iterations)]),
      round(means[Math.floor(0.975 * iterations)])
    ],
    interpretation: "negative favors the first registry"
  };
}

const stopwords = new Set([
  "and",
  "area",
  "for",
  "from",
  "into",
  "repository",
  "the",
  "this",
  "with",
  "work"
]);
function semanticTokens(card) {
  return new Set(
    [card.name, card.description, ...(card.inclusions ?? [])]
      .join(" ")
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .filter((token) => token.length >= 4 && !stopwords.has(token))
  );
}

function jaccard(left, right) {
  const intersection = [...left].filter((value) => right.has(value)).length;
  const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : intersection / union;
}

function structuralAudit(cards) {
  const catchAllAreas = cards
    .filter((card) =>
      /(?:^|\b)(?:other|miscellaneous|general repository|all repository|everything else)(?:\b|$)/iu.test(
        `${card.area_id} ${card.name} ${card.description}`
      )
    )
    .map((card) => card.area_id);
  const aliasPairs = [];
  const parentChildPairs = [];
  for (let leftIndex = 0; leftIndex < cards.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < cards.length; rightIndex += 1) {
      const left = cards[leftIndex];
      const right = cards[rightIndex];
      const overlap = jaccard(semanticTokens(left), semanticTokens(right));
      if (overlap >= 0.58) {
        aliasPairs.push({ areas: [left.area_id, right.area_id], semanticJaccard: round(overlap) });
      }
      const leftName = left.name.toLowerCase();
      const rightName = right.name.toLowerCase();
      if (
        left.area_id.startsWith(`${right.area_id}-`) ||
        right.area_id.startsWith(`${left.area_id}-`) ||
        (leftName.length >= 8 && rightName.includes(leftName)) ||
        (rightName.length >= 8 && leftName.includes(rightName))
      ) {
        parentChildPairs.push([left.area_id, right.area_id]);
      }
    }
  }
  return { areas: cards.length, catchAllAreas, aliasPairs, parentChildPairs };
}

const snapshot = await fetchExperiment(evaluationExperimentId);
const metadataByTask = new Map(
  snapshot.experiment.manifest.tasks.map((task) => [task.id, task.metadata])
);
const store = new VercelBlobArtifactStore();
const rawEntries = await mapWithConcurrency(snapshot.jobs, 24, async (record) => {
  const raw = await readJsonArtifact(store, record.outputArtifact);
  const role = record.job.configuration.evaluationRole;
  if (!["composition_reference", "composition_candidate"].includes(role)) return undefined;
  const metadata = metadataByTask.get(record.job.taskId);
  return {
    treatmentId: record.job.treatmentId,
    comparisonGroup: record.job.configuration.comparisonGroup,
    taskId: record.job.taskId,
    repositoryId: metadata?.repositoryId ?? "unknown",
    seed: record.job.seed,
    evaluationRole: role,
    prediction: extractCompositionPrediction(raw),
    latencyMs: record.latencyMs ?? 0,
    providerCostUsd: record.providerCostUsd,
    infrastructureCostUsd: record.infrastructureCostUsd
  };
});
const entries = rawEntries.filter(Boolean);
const perRepository = Object.fromEntries(
  [...new Set(entries.map((entry) => entry.repositoryId))]
    .sort()
    .map((repositoryId) => [
      repositoryId,
      analyze(entries.filter((entry) => entry.repositoryId === repositoryId))
    ])
);
const errors = pairedTaskErrors(entries);

function comparisonsFor(values) {
  const byGroup = Object.fromEntries(
    ["human", "auto_rules", "auto_unconstrained"].map((group) => [
      group,
      values.filter((entry) => entry.comparisonGroup === group)
    ])
  );
  return {
    autoRulesMinusHuman: bootstrapDelta(byGroup.auto_rules, byGroup.human),
    autoUnconstrainedMinusHuman: bootstrapDelta(byGroup.auto_unconstrained, byGroup.human),
    autoRulesMinusAutoUnconstrained: bootstrapDelta(byGroup.auto_rules, byGroup.auto_unconstrained)
  };
}

const pairedComparisons = {
  all: comparisonsFor(errors),
  byRepository: Object.fromEntries(
    [...new Set(errors.map((entry) => entry.repositoryId))]
      .sort()
      .map((repositoryId) => [
        repositoryId,
        comparisonsFor(errors.filter((entry) => entry.repositoryId === repositoryId))
      ])
  )
};

const registryAudit = JSON.parse(await readFile(registryAuditFile, "utf8"));
const registryDiagnostics = registryAudit.repositories.map((repository) => ({
  repositoryId: repository.repositoryId,
  temporalSplit: repository.temporalSplit,
  registries: Object.fromEntries(
    Object.entries(repository.registries).map(([name, cards]) => [name, structuralAudit(cards)])
  )
}));
const constructionSnapshots = await Promise.all(
  constructionExperimentIds.map((experimentId) => fetchExperiment(experimentId))
);
const result = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  experimentId: evaluationExperimentId,
  status: snapshot.experiment.status,
  tasks: snapshot.experiment.manifest.tasks.length,
  jobs: snapshot.jobs.length,
  validPredictions: entries.filter((entry) => entry.prediction !== undefined).length,
  providerCostUsd: round(snapshot.experiment.providerSpentUsd),
  infrastructureCostUsd: round(snapshot.experiment.infrastructureSpentUsd),
  constructionProviderCostUsd: round(
    constructionSnapshots.reduce(
      (sum, construction) => sum + construction.experiment.providerSpentUsd,
      0
    )
  ),
  groups: analyze(entries),
  perRepository,
  pairedComparisons,
  registryDiagnostics
};

const groupRows = result.groups.flatMap((group) =>
  group.treatments.map((treatment) => ({
    group: group.comparisonGroup,
    reference: group.reference,
    ...treatment
  }))
);
const decimal = (value) => (value === undefined ? "n/a" : Number(value).toFixed(4));
const percent = (value) => (value === undefined ? "n/a" : `${(100 * value).toFixed(1)}%`);
const report = [
  "# Held-out onboarding generalization experiment",
  "",
  `- Held-out tasks: ${result.tasks} across ${Object.keys(perRepository).length} repositories`,
  `- Successful jobs: ${result.jobs}/${result.jobs}`,
  `- Valid composition predictions: ${result.validPredictions}/${entries.length}`,
  `- Evaluation provider cost: $${result.providerCostUsd.toFixed(4)}`,
  `- Construction provider cost: $${result.constructionProviderCostUsd.toFixed(4)}`,
  "- Temporal leakage controls: strict chronological split, fourteen-day embargo, zero task-text overlap, and no changed-file evidence in model prompts.",
  "",
  "## Aggregate classification results",
  "",
  "| Registry | Pairs | Active MAE ↓ | Cosine ↑ | Active F1 ↑ | Top-area agreement ↑ | Unknown MAE ↓ | Reference unknown | Reference active areas | Luna cost |",
  "| -- | --: | --: | --: | --: | --: | --: | --: | --: | --: |",
  ...groupRows.map(
    (row) =>
      `| ${row.group} | ${row.pairedPredictions} | ${decimal(
        row.meanActiveAreaAbsoluteError
      )} | ${decimal(row.meanCosineSimilarity)} | ${decimal(row.activeAreaF1)} | ${percent(
        row.topAreaAgreement
      )} | ${decimal(row.meanUnknownAbsoluteError)} | ${decimal(
        row.reference.meanUnknownProbability
      )} | ${decimal(row.reference.meanActiveAreaCount)} | $${decimal(row.providerCostUsd)} |`
  ),
  "",
  "## Paired active-MAE deltas",
  "",
  "Negative values favor the first registry. Confidence intervals are a deterministic task-level bootstrap.",
  "",
  "| Comparison | Mean delta | 95% interval |",
  "| -- | --: | --: |",
  ...Object.entries(pairedComparisons.all).map(
    ([name, comparison]) =>
      `| ${name} | ${decimal(comparison?.meanDelta)} | ${
        comparison
          ? `[${decimal(comparison.confidenceInterval95[0])}, ${decimal(
              comparison.confidenceInterval95[1]
            )}]`
          : "n/a"
      } |`
  ),
  "",
  "## Per-repository results",
  "",
  ...Object.entries(perRepository).flatMap(([repositoryId, groups]) => [
    `### ${repositoryId}`,
    "",
    "| Registry | Active MAE ↓ | Cosine ↑ | Active F1 ↑ | Top area ↑ | Unknown MAE ↓ | Reference unknown |",
    "| -- | --: | --: | --: | --: | --: | --: |",
    ...groups.flatMap((group) =>
      group.treatments.map(
        (row) =>
          `| ${group.comparisonGroup} | ${decimal(
            row.meanActiveAreaAbsoluteError
          )} | ${decimal(row.meanCosineSimilarity)} | ${decimal(row.activeAreaF1)} | ${percent(
            row.topAreaAgreement
          )} | ${decimal(row.meanUnknownAbsoluteError)} | ${decimal(
            group.reference.meanUnknownProbability
          )} |`
      )
    ),
    ""
  ]),
  "## Registry structural diagnostics",
  "",
  "| Repository | Registry | Catch-alls | Alias pairs | Parent-child pairs |",
  "| -- | -- | --: | --: | --: |",
  ...registryDiagnostics.flatMap((repository) =>
    Object.entries(repository.registries).map(
      ([name, audit]) =>
        `| ${repository.repositoryId} | ${name} | ${audit.catchAllAreas.length} | ${audit.aliasPairs.length} | ${audit.parentChildPairs.length} |`
    )
  ),
  "",
  "The Sol reference for each registry was mapped from the same frozen taxonomy-neutral decomposition. Luna never received changed files, final implementation details, or held-out task text during registry construction."
].join("\n");

await mkdir(outputRoot, { recursive: true, mode: 0o700 });
const metricsFile = path.join(outputRoot, "combined-metrics.json");
const reportFile = path.join(outputRoot, "combined-report.md");
await writeFile(metricsFile, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
await writeFile(reportFile, `${report}\n`, { mode: 0o600 });
console.log(
  JSON.stringify(
    {
      ok: true,
      metricsFile,
      reportFile,
      tasks: result.tasks,
      jobs: result.jobs,
      providerCostUsd: result.providerCostUsd,
      constructionProviderCostUsd: result.constructionProviderCostUsd
    },
    null,
    2
  )
);
