#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { extractCompositionPrediction } from "@velum-labs/routekit-eval-core/experiment";
import {
  readJsonArtifact,
  VercelBlobArtifactStore
} from "@velum-labs/routekit-eval-store/platform";

import { assetRoot, root } from "./onboarding-optimization-common.mjs";

const baseUrl = (
  process.env.EXPERIMENT_PLATFORM_URL ?? "https://routekit-experiments-development.vercel.app"
).replace(/\/$/u, "");
const token = process.env.EXPERIMENT_PLATFORM_API_TOKEN;
if (!token) throw new Error("EXPERIMENT_PLATFORM_API_TOKEN is required");
if (!process.env.BLOB_READ_WRITE_TOKEN && !process.env.VERCEL_OIDC_TOKEN) {
  throw new Error("Vercel Blob credentials are required");
}

const resultsDirectory = path.join(assetRoot, "results");
const metricsFile = path.join(resultsDirectory, "combined-metrics.json");
const reviewPacketFile = path.join(resultsDirectory, "routekit-blinded-review-packet.md");
const reportFile = path.join(
  root,
  "apps/experiment-platform/ONBOARDING_OPTIMIZATION_RESULTS_2026-08-19.md"
);
const selectionFile = path.join(assetRoot, "repair/validation-selection.json");
const cohortAuditFile = path.join(assetRoot, "cohorts/cohort-registry-audit.json");
const routekitFinalAuditFile = path.join(
  assetRoot,
  "routekit-assistance/routekit-assistance-final-audit.json"
);

const experimentIds = {
  constructionCanary: "onboarding-optimization-construction-canary-v1",
  privateConstruction: "onboarding-optimization-private-registries-4-v1",
  neutralCanary: "onboarding-optimization-neutral-canary-6-v1",
  publicConstruction: "onboarding-optimization-public-registries-3x13-v1",
  neutral: "onboarding-optimization-neutral-93-v1",
  constructionRetry: "onboarding-optimization-construction-retry-3-v1",
  validationCanary: "onboarding-optimization-validation-canary-3x15-v1",
  neutralRetry: "onboarding-optimization-neutral-retry-2-v1",
  neutralInsufficientRetry: "onboarding-optimization-neutral-insufficient-retry-1-v1",
  validation: "onboarding-optimization-validation-36x15-v1",
  repair: "onboarding-optimization-repair-3-v1",
  finalCanary: "onboarding-optimization-final-canary-3x4x3-v1",
  naturalCanary: "onboarding-optimization-natural-hard-canary-2x3-v1",
  realCanary: "onboarding-optimization-real-auto-canary-4-v1",
  routekitValidation: "onboarding-optimization-routekit-assistance-validation-3x2-v1",
  routekitRepair: "onboarding-optimization-routekit-assistance-repair-1-v1",
  final: "onboarding-optimization-final-84x4x3-v1",
  natural: "onboarding-optimization-natural-hard-48x3-v1",
  real: "onboarding-optimization-real-auto-45-v1",
  routekitFinal: "onboarding-optimization-routekit-assistance-final-5x3-v1",
  finalRetry: "onboarding-optimization-final-retry-1-v1"
};

const mean = (values) =>
  values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0) / values.length;
const round = (value, places = 6) =>
  value === undefined ? undefined : Number(value.toFixed(places));
const median = (values) => {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
};

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
  if (!response.ok) throw new Error(`failed to read ${experimentId}: ${response.status}`);
  const snapshot = await response.json();
  if (!["completed", "failed"].includes(snapshot.experiment?.status)) {
    throw new Error(`${experimentId} is ${snapshot.experiment?.status}, not terminal`);
  }
  if (snapshot.jobs.some((record) => record.status !== "succeeded")) {
    throw new Error(`${experimentId} contains unsuccessful jobs`);
  }
  return snapshot;
}

function activeAreas(prediction) {
  return Object.entries(prediction.areaCompositionScores)
    .filter(([, score]) => score >= 0.25)
    .map(([area]) => area);
}

function topAreas(prediction, count = 3) {
  return Object.entries(prediction.areaCompositionScores)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, count)
    .map(([area]) => area);
}

function pairMetrics(candidate, reference) {
  const areas = Object.keys(reference.areaCompositionScores);
  const active = activeAreas(reference);
  const activeForMae = active.length > 0 ? active : areas;
  const expected = new Set(active);
  const predicted = new Set(activeAreas(candidate));
  const truePositive = [...predicted].filter((area) => expected.has(area)).length;
  const precision =
    predicted.size === 0 ? (expected.size === 0 ? 1 : 0) : truePositive / predicted.size;
  const recall =
    expected.size === 0 ? (predicted.size === 0 ? 1 : 0) : truePositive / expected.size;
  const activeF1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  let dot = 0;
  let candidateNorm = 0;
  let referenceNorm = 0;
  for (const area of areas) {
    const candidateScore = candidate.areaCompositionScores[area] ?? 0;
    const referenceScore = reference.areaCompositionScores[area] ?? 0;
    dot += candidateScore * referenceScore;
    candidateNorm += candidateScore * candidateScore;
    referenceNorm += referenceScore * referenceScore;
  }
  const cosine =
    candidateNorm === 0 || referenceNorm === 0
      ? candidateNorm === referenceNorm
        ? 1
        : 0
      : dot / Math.sqrt(candidateNorm * referenceNorm);
  const topThree = new Set(topAreas(candidate));
  const allActiveAt3 = active.length === 0 || active.every((area) => topThree.has(area)) ? 1 : 0;
  const unknownDifference = candidate.unknownProbability - reference.unknownProbability;
  return {
    activeMae: mean(
      activeForMae.map((area) =>
        Math.abs(
          (candidate.areaCompositionScores[area] ?? 0) -
            (reference.areaCompositionScores[area] ?? 0)
        )
      )
    ),
    allAreaMae: mean(
      areas.map((area) =>
        Math.abs(
          (candidate.areaCompositionScores[area] ?? 0) -
            (reference.areaCompositionScores[area] ?? 0)
        )
      )
    ),
    cosine,
    activePrecision: precision,
    activeRecall: recall,
    activeF1,
    topAreaAgreement: topAreas(candidate, 1)[0] === topAreas(reference, 1)[0] ? 1 : 0,
    allActiveAt3,
    unknownMae: Math.abs(unknownDifference),
    unknownBrier: unknownDifference * unknownDifference,
    referenceUnknown: reference.unknownProbability,
    referenceActiveAreas: active.length,
    referenceKnownMass: Object.values(reference.areaCompositionScores).reduce(
      (sum, score) => sum + score,
      0
    )
  };
}

function thresholdSummary(perTask, threshold) {
  let falseUnknown = 0;
  let missedUnknown = 0;
  let correct = 0;
  for (const entry of perTask) {
    const expected = entry.reference.unknownProbability >= threshold;
    const predicted = entry.candidate.unknownProbability >= threshold;
    if (predicted && !expected) falseUnknown += 1;
    if (!predicted && expected) missedUnknown += 1;
    if (predicted === expected) correct += 1;
  }
  return {
    threshold,
    accuracy: round(correct / perTask.length),
    falseUnknownRate: round(falseUnknown / perTask.length),
    missedUnknownRate: round(missedUnknown / perTask.length)
  };
}

function summarizePairs(candidates, references) {
  const referencesByKey = new Map(references.map((entry) => [entry.key, entry]));
  const perTask = candidates.flatMap((candidate) => {
    const reference = referencesByKey.get(candidate.key);
    if (!candidate.prediction || !reference?.prediction) return [];
    return [
      {
        key: candidate.key,
        taskId: candidate.taskId,
        repositoryId: candidate.repositoryId,
        metadata: candidate.metadata,
        candidate: candidate.prediction,
        reference: reference.prediction,
        metrics: pairMetrics(candidate.prediction, reference.prediction)
      }
    ];
  });
  const metric = (name) => round(mean(perTask.map((entry) => entry.metrics[name])));
  return {
    pairs: perTask.length,
    activeMae: metric("activeMae"),
    allAreaMae: metric("allAreaMae"),
    cosine: metric("cosine"),
    activePrecision: metric("activePrecision"),
    activeRecall: metric("activeRecall"),
    activeF1: metric("activeF1"),
    topAreaAgreement: metric("topAreaAgreement"),
    allActiveAt3: metric("allActiveAt3"),
    unknownMae: metric("unknownMae"),
    unknownBrier: metric("unknownBrier"),
    referenceUnknown: metric("referenceUnknown"),
    referenceActiveAreas: metric("referenceActiveAreas"),
    referenceKnownMass: metric("referenceKnownMass"),
    candidateMedianLatencyMs: round(median(candidates.map((entry) => entry.latencyMs))),
    candidateCostUsd: round(candidates.reduce((sum, entry) => sum + entry.providerCostUsd, 0)),
    unknownAtPointThree: thresholdSummary(perTask, 0.3),
    unknownAtPointFive: thresholdSummary(perTask, 0.5),
    perTask
  };
}

function analyzeEntries(entries) {
  const comparisonGroups = [...new Set(entries.map((entry) => entry.comparisonGroup))].sort();
  return comparisonGroups.map((comparisonGroup) => {
    const group = entries.filter((entry) => entry.comparisonGroup === comparisonGroup);
    const luna = group.filter((entry) => entry.evaluationRole === "composition_candidate");
    const sol = group.filter((entry) => entry.evaluationRole === "composition_reference");
    const claude = group.filter(
      (entry) => entry.evaluationRole === "composition_independent_reference"
    );
    return {
      comparisonGroup,
      lunaVsSol: summarizePairs(luna, sol),
      ...(claude.length > 0
        ? {
            lunaVsClaude: summarizePairs(luna, claude),
            claudeVsSol: summarizePairs(claude, sol)
          }
        : {})
    };
  });
}

function analysisByRepository(entries) {
  return Object.fromEntries(
    [...new Set(entries.map((entry) => entry.repositoryId))]
      .sort()
      .map((repositoryId) => [
        repositoryId,
        analyzeEntries(entries.filter((entry) => entry.repositoryId === repositoryId))
      ])
  );
}

async function entriesFor(snapshot) {
  const metadataByTask = new Map(
    snapshot.experiment.manifest.tasks.map((task) => [task.id, task.metadata])
  );
  const store = new VercelBlobArtifactStore();
  const entries = await mapWithConcurrency(snapshot.jobs, 24, async (record) => {
    const evaluationRole = record.job.configuration.evaluationRole;
    if (!evaluationRole?.startsWith("composition_")) return undefined;
    const metadata = metadataByTask.get(record.job.taskId) ?? {};
    const raw = await readJsonArtifact(store, record.outputArtifact);
    return {
      key: `${record.job.taskId}\u0000${record.job.seed}`,
      taskId: record.job.taskId,
      repositoryId: metadata.repositoryId ?? "unknown",
      metadata,
      comparisonGroup: record.job.configuration.comparisonGroup,
      evaluationRole,
      prediction: extractCompositionPrediction(raw),
      latencyMs: record.latencyMs ?? 0,
      providerCostUsd: record.providerCostUsd,
      infrastructureCostUsd: record.infrastructureCostUsd
    };
  });
  return entries.filter(Boolean);
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
  const rightByTask = new Map(right.map((entry) => [entry.taskId, entry.metrics.activeMae]));
  const differences = left.flatMap((entry) => {
    const other = rightByTask.get(entry.taskId);
    return other === undefined ? [] : [entry.metrics.activeMae - other];
  });
  if (differences.length === 0) return undefined;
  const sample = random(181081);
  const sampledMeans = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let total = 0;
    for (let index = 0; index < differences.length; index += 1) {
      total += differences[Math.floor(sample() * differences.length)];
    }
    sampledMeans.push(total / differences.length);
  }
  sampledMeans.sort((leftValue, rightValue) => leftValue - rightValue);
  return {
    pairs: differences.length,
    meanDelta: round(mean(differences)),
    confidenceInterval95: [
      round(sampledMeans[Math.floor(0.025 * iterations)]),
      round(sampledMeans[Math.floor(0.975 * iterations)])
    ],
    interpretation: "negative favors the first registry"
  };
}

function pairwiseRegistryDeltas(analysis, comparisons) {
  const byGroup = new Map(
    analysis.map((entry) => [entry.comparisonGroup, entry.lunaVsSol.perTask])
  );
  return Object.fromEntries(
    comparisons.map(([left, right]) => [
      `${left}Minus${right}`,
      bootstrapDelta(byGroup.get(left) ?? [], byGroup.get(right) ?? [])
    ])
  );
}

const snapshots = Object.fromEntries(
  await Promise.all(
    Object.entries(experimentIds).map(async ([name, experimentId]) => [
      name,
      await fetchExperiment(experimentId)
    ])
  )
);
const [selection, cohortAudit, routekitFinalAudit] = await Promise.all([
  readFile(selectionFile, "utf8").then(JSON.parse),
  readFile(cohortAuditFile, "utf8").then(JSON.parse),
  readFile(routekitFinalAuditFile, "utf8").then(JSON.parse)
]);

const [
  finalEntriesRaw,
  naturalEntries,
  realEntries,
  routekitValidationEntries,
  routekitFinalEntries
] = await Promise.all([
  entriesFor(snapshots.final),
  entriesFor(snapshots.natural),
  entriesFor(snapshots.real),
  entriesFor(snapshots.routekitValidation),
  entriesFor(snapshots.routekitFinal)
]);
const finalRetryEntries = await entriesFor(snapshots.finalRetry);
const retryMetadata = snapshots.finalRetry.experiment.manifest.tasks[0].metadata;
const finalEntries = finalEntriesRaw.filter(
  (entry) =>
    !(
      entry.taskId === retryMetadata.originalTaskId &&
      entry.comparisonGroup === retryMetadata.comparisonGroup &&
      entry.evaluationRole === retryMetadata.evaluationRole
    )
);
const retryEntry = finalRetryEntries[0];
finalEntries.push({
  ...retryEntry,
  key: `${retryMetadata.originalTaskId}\u0000${snapshots.finalRetry.jobs[0].job.seed}`,
  taskId: retryMetadata.originalTaskId,
  repositoryId: retryMetadata.repositoryId,
  comparisonGroup: retryMetadata.comparisonGroup,
  evaluationRole: retryMetadata.evaluationRole,
  metadata: {
    ...retryEntry.metadata,
    retryExperimentId: experimentIds.finalRetry
  }
});

const finalAnalysis = analyzeEntries(finalEntries);
const naturalAnalysis = analyzeEntries(naturalEntries);
const realAnalysis = analyzeEntries(realEntries);
const routekitValidationAnalysis = analyzeEntries(routekitValidationEntries);
const routekitFinalAnalysis = analyzeEntries(routekitFinalEntries);
const validationAggregate = Object.values(
  selection.repositories
    .flatMap((repository) =>
      repository.allMetrics.map((entry) => ({
        repositoryId: repository.repositoryId,
        comparisonGroup: entry.comparisonGroup,
        selectionScore: entry.selectionScore,
        unpenalizedObjective:
          entry.metrics.activeMae +
          0.5 * entry.metrics.unknownMae +
          0.15 * entry.metrics.referenceUnknown,
        structuralValid: entry.diagnostics.valid,
        ...entry.metrics
      }))
    )
    .reduce((groups, entry) => {
      const group = groups[entry.comparisonGroup] ?? {
        comparisonGroup: entry.comparisonGroup,
        repositories: 0,
        selectionScores: [],
        activeMae: [],
        unknownMae: [],
        activeF1: [],
        topAreaAgreement: [],
        referenceUnknown: [],
        unpenalizedObjectives: [],
        structuralValid: []
      };
      group.repositories += 1;
      for (const key of [
        "selectionScore",
        "activeMae",
        "unknownMae",
        "activeF1",
        "topAreaAgreement",
        "referenceUnknown",
        "unpenalizedObjective",
        "structuralValid"
      ]) {
        const destination =
          key === "selectionScore"
            ? "selectionScores"
            : key === "unpenalizedObjective"
              ? "unpenalizedObjectives"
              : key;
        group[destination].push(entry[key]);
      }
      groups[entry.comparisonGroup] = group;
      return groups;
    }, {})
).map((group) => ({
  comparisonGroup: group.comparisonGroup,
  repositories: group.repositories,
  selectionScore: round(mean(group.selectionScores)),
  activeMae: round(mean(group.activeMae)),
  unknownMae: round(mean(group.unknownMae)),
  activeF1: round(mean(group.activeF1)),
  topAreaAgreement: round(mean(group.topAreaAgreement)),
  referenceUnknown: round(mean(group.referenceUnknown)),
  unpenalizedObjective: round(mean(group.unpenalizedObjectives)),
  structurallyValidRepositories: group.structuralValid.filter(Boolean).length
}));

const experimentCosts = Object.entries(snapshots).map(([stage, snapshot]) => ({
  stage,
  experimentId: snapshot.experiment.experimentId,
  status: snapshot.experiment.status,
  jobs: snapshot.jobs.length,
  providerCostUsd: round(snapshot.experiment.providerSpentUsd),
  infrastructureCostUsd: round(snapshot.experiment.infrastructureSpentUsd),
  providerBudgetUsd: snapshot.experiment.manifest.budget.providerMaximumUsd,
  providerBudgetExceeded:
    snapshot.experiment.providerSpentUsd > snapshot.experiment.manifest.budget.providerMaximumUsd
}));
const totalProviderCostUsd = round(
  experimentCosts.reduce((sum, entry) => sum + entry.providerCostUsd, 0)
);
const totalInfrastructureCostUsd = round(
  experimentCosts.reduce((sum, entry) => sum + entry.infrastructureCostUsd, 0)
);

const results = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  campaign: {
    providerCostUsd: totalProviderCostUsd,
    infrastructureCostUsd: totalInfrastructureCostUsd,
    experimentRuns: experimentCosts.length,
    jobs: experimentCosts.reduce((sum, entry) => sum + entry.jobs, 0),
    budgetOnlyFailures: experimentCosts
      .filter((entry) => entry.status === "failed" && entry.providerBudgetExceeded)
      .map((entry) => entry.experimentId)
  },
  selection: {
    repositories: selection.repositories.map((repository) => ({
      repositoryId: repository.repositoryId,
      winner: repository.winner,
      paretoFrontier: repository.paretoFrontier
    })),
    aggregate: validationAggregate.sort((left, right) => left.selectionScore - right.selectionScore)
  },
  final: {
    tasks: snapshots.final.experiment.manifest.tasks.length,
    analysis: finalAnalysis,
    byRepository: analysisByRepository(finalEntries),
    pairedDeltas: pairwiseRegistryDeltas(finalAnalysis, [
      ["selected", "human"],
      ["repaired", "selected"],
      ["repaired", "human"],
      ["selected", "previous_unconstrained"]
    ]),
    retryApplied: {
      experimentId: experimentIds.finalRetry,
      originalTaskId: retryMetadata.originalTaskId,
      originalTreatmentId: retryMetadata.originalTreatmentId
    }
  },
  naturalHard: {
    tasks: snapshots.natural.experiment.manifest.tasks.length,
    analysis: naturalAnalysis,
    byRepository: analysisByRepository(naturalEntries),
    pairedDeltas: pairwiseRegistryDeltas(naturalAnalysis, [
      ["selected", "human"],
      ["repaired", "selected"],
      ["repaired", "human"]
    ])
  },
  realConversation: {
    tasks: snapshots.real.experiment.manifest.tasks.length,
    analysis: realAnalysis,
    byRepository: analysisByRepository(realEntries),
    contextual: analyzeEntries(realEntries.filter((entry) => entry.metadata.contextual)),
    diagnostic: analyzeEntries(realEntries.filter((entry) => entry.metadata.diagnostic)),
    nonDiagnostic: analyzeEntries(realEntries.filter((entry) => !entry.metadata.diagnostic))
  },
  routekitAssistance: {
    validationTasks: snapshots.routekitValidation.experiment.manifest.tasks.length,
    finalTasks: snapshots.routekitFinal.experiment.manifest.tasks.length,
    validation: routekitValidationAnalysis,
    final: routekitFinalAnalysis,
    pairedDeltas: pairwiseRegistryDeltas(routekitFinalAnalysis, [
      ["auto", "human"],
      ["repaired", "auto"],
      ["repaired", "human"]
    ])
  },
  experimentCosts
};

function decimal(value) {
  return value === undefined ? "n/a" : Number(value).toFixed(4);
}

function percent(value) {
  return value === undefined ? "n/a" : `${(100 * value).toFixed(1)}%`;
}

function metricRows(analysis) {
  return analysis.map((entry) => {
    const sol = entry.lunaVsSol;
    const claude = entry.lunaVsClaude;
    const judge = entry.claudeVsSol;
    return `| ${entry.comparisonGroup} | ${sol.pairs} | ${decimal(sol.activeMae)} | ${decimal(
      sol.cosine
    )} | ${decimal(sol.activeF1)} | ${percent(sol.topAreaAgreement)} | ${percent(
      sol.allActiveAt3
    )} | ${decimal(sol.unknownMae)} | ${decimal(claude?.activeMae)} | ${decimal(
      judge?.activeMae
    )} |`;
  });
}

function metricTable(analysis) {
  return [
    "| Registry | Pairs | Active MAE vs Sol ↓ | Cosine vs Sol ↑ | Active F1 ↑ | Top area ↑ | All active @3 ↑ | Unknown MAE ↓ | Active MAE vs Claude ↓ | Sol–Claude active MAE ↓ |",
    "| -- | --: | --: | --: | --: | --: | --: | --: | --: | --: |",
    ...metricRows(analysis)
  ];
}

function deltaRows(deltas) {
  return Object.entries(deltas).map(
    ([name, value]) =>
      `| ${name.replace("Minus", " − ").replaceAll("_", " ")} | ${decimal(value?.meanDelta)} | ${
        value
          ? `[${decimal(value.confidenceInterval95[0])}, ${decimal(value.confidenceInterval95[1])}]`
          : "n/a"
      } |`
  );
}

const selectedRows = selection.repositories.map(
  (repository) =>
    `| ${repository.repositoryId} | ${repository.winner.comparisonGroup} | ${decimal(
      repository.winner.selectionScore
    )} | ${decimal(repository.winner.metrics.activeMae)} | ${decimal(
      repository.winner.metrics.unknownMae
    )} | ${decimal(repository.winner.metrics.activeF1)} |`
);
const learningRows = validationAggregate
  .sort((left, right) => left.unpenalizedObjective - right.unpenalizedObjective)
  .map(
    (entry) =>
      `| ${entry.comparisonGroup} | ${entry.structurallyValidRepositories}/3 | ${decimal(
        entry.unpenalizedObjective
      )} | ${decimal(entry.activeMae)} | ${decimal(entry.unknownMae)} | ${decimal(
        entry.activeF1
      )} | ${percent(entry.topAreaAgreement)} | ${decimal(entry.referenceUnknown)} |`
  );
const costRows = experimentCosts.map(
  (entry) =>
    `| ${entry.experimentId} | ${entry.status} | ${entry.jobs} | $${entry.providerCostUsd.toFixed(
      4
    )} | $${entry.providerBudgetUsd.toFixed(2)} | ${entry.providerBudgetExceeded ? "yes" : "no"} |`
);
const finalRepositoryRows = Object.entries(results.final.byRepository).flatMap(
  ([repositoryId, groups]) =>
    groups.map((entry) => {
      const metrics = entry.lunaVsSol;
      return `| ${repositoryId} | ${entry.comparisonGroup} | ${decimal(
        metrics.activeMae
      )} | ${decimal(metrics.activeF1)} | ${percent(metrics.topAreaAgreement)} | ${decimal(
        metrics.unknownMae
      )} | ${decimal(entry.lunaVsClaude?.activeMae)} |`;
    })
);
const naturalUnknownRows = naturalAnalysis.map((entry) => {
  const metrics = entry.lunaVsSol;
  return `| ${entry.comparisonGroup} | ${decimal(metrics.unknownMae)} | ${decimal(
    metrics.unknownBrier
  )} | ${percent(metrics.unknownAtPointThree.accuracy)} | ${percent(
    metrics.unknownAtPointThree.falseUnknownRate
  )} | ${percent(metrics.unknownAtPointThree.missedUnknownRate)} |`;
});
const operationalRows = [
  ["Final", ...finalAnalysis.map((entry) => entry)],
  ["Natural hard", ...naturalAnalysis.map((entry) => entry)],
  ["Real conversation", ...realAnalysis.map((entry) => entry)]
].flatMap(([cohort, ...groups]) =>
  groups.map((entry) => {
    const metrics = entry.lunaVsSol;
    return `| ${cohort} | ${entry.comparisonGroup} | ${Math.round(
      metrics.candidateMedianLatencyMs
    )} ms | $${decimal(metrics.candidateCostUsd / metrics.pairs)} |`;
  })
);

const report = [
  "# Onboarding area-registry optimization results",
  "",
  `Date: 2026-08-19`,
  "",
  "## Executive summary",
  "",
  `This campaign completed ${results.campaign.experimentRuns} Vercel experiment runs and ${results.campaign.jobs} jobs for $${results.campaign.providerCostUsd.toFixed(
    4
  )} in model inference and $${results.campaign.infrastructureCostUsd.toFixed(
    4
  )} in measured infrastructure cost.`,
  "",
  "The runtime classifier was fixed throughout the evaluation: direct Luna classification, task-aware context, independent known-area composition scores, and a separate unknown probability. Only the onboarding registry changed.",
  "",
  "The central result is that there was no universal best construction recipe. Backstage preferred a hybrid task-plus-structure registry, Grafana preferred the same hybrid with changed-path statistics, and Kubernetes benefited from the largest diverse history. Registry repair remained structurally valid, but its classification effect must be judged repository by repository rather than assumed positive.",
  "",
  "On the untouched public final test, repaired registries had the best aggregate Luna-versus-Sol active MAE (0.0835), while selected registries had the lowest unknown error (0.0106) and best Luna-versus-Claude active MAE (0.1248). Those improvements were not statistically decisive over the human baselines on all 84 tasks because the repositories behaved differently. On the deliberately hard 48-task cohort, however, both selected and repaired registries clearly outperformed human registries.",
  "",
  "The weakest result was the 45-task real conversational cohort: active MAE was 0.1758 and unknown MAE was 0.2462. Non-diagnostic conversational tasks were harder than diagnostic tasks. The first product should therefore use candidate generation plus nested validation, and should not assume that an automatically generated registry is ready without repository-specific checks.",
  "",
  "Two canaries ended in a failed state only because measured provider cost exceeded an overly tight budget by less than one cent. Every job and every composition contract in those canaries succeeded; full-run budgets were corrected before execution.",
  "",
  "## Validation-selected onboarding recipes",
  "",
  "| Repository | Selected recipe | Selection score ↓ | Active MAE ↓ | Unknown MAE ↓ | Active F1 ↑ |",
  "| -- | -- | --: | --: | --: | --: |",
  ...selectedRows,
  "",
  "The selection score was fixed before final-test exposure: active MAE + 0.50 × unknown MAE + 0.15 × reference unknown, plus structural penalties. Human and previous-unconstrained registries were retained as baselines but were not eligible to win.",
  "",
  "## Untouched 84-task final test",
  "",
  ...metricTable(finalAnalysis),
  "",
  "Luna-versus-Sol measures runtime classifiability. Luna-versus-Claude checks whether the conclusion is robust to an independent judge. Sol–Claude disagreement is label ambiguity, not a Luna error.",
  "",
  "### Paired active-MAE differences",
  "",
  "Negative favors the first registry. Intervals are deterministic task-level bootstrap intervals.",
  "",
  "| Comparison | Mean delta | 95% interval |",
  "| -- | --: | --: |",
  ...deltaRows(results.final.pairedDeltas),
  "",
  "### Final results by repository",
  "",
  "| Repository | Registry | Active MAE vs Sol ↓ | Active F1 ↑ | Top area ↑ | Unknown MAE ↓ | Active MAE vs Claude ↓ |",
  "| -- | -- | --: | --: | --: | --: | --: |",
  ...finalRepositoryRows,
  "",
  "Backstage's human registry was easiest for Luna on active-area scores, while repaired registries were strongest on Grafana and Kubernetes. This heterogeneity is why onboarding should select per repository rather than hard-code one generation recipe.",
  "",
  "## Natural hard and open-set cohort",
  "",
  ...metricTable(naturalAnalysis),
  "",
  "This 48-task cohort contains requests without exact paths or area names, multi-area tasks, open-set work, and cases requiring repository interpretation.",
  "",
  "| Comparison | Mean active-MAE delta | 95% interval |",
  "| -- | --: | --: |",
  ...deltaRows(results.naturalHard.pairedDeltas),
  "",
  "### Unknown detection on natural hard cases",
  "",
  "| Registry | Unknown MAE ↓ | Unknown Brier ↓ | Accuracy @0.3 ↑ | False unknown @0.3 ↓ | Missed unknown @0.3 ↓ |",
  "| -- | --: | --: | --: | --: | --: |",
  ...naturalUnknownRows,
  "",
  "## Real conversational coding prompts",
  "",
  ...metricTable(realAnalysis),
  "",
  "These 45 tasks preserve task-aware conversational context from separate Codex accounts. They include short continuation requests, debugging follow-ups, incomplete specifications, and repository-specific language.",
  "",
  `Diagnostic conversational tasks had active MAE ${decimal(
    results.realConversation.diagnostic[0]?.lunaVsSol.activeMae
  )}; non-diagnostic tasks had active MAE ${decimal(
    results.realConversation.nonDiagnostic[0]?.lunaVsSol.activeMae
  )}. Their unknown MAEs were ${decimal(
    results.realConversation.diagnostic[0]?.lunaVsSol.unknownMae
  )} and ${decimal(
    results.realConversation.nonDiagnostic[0]?.lunaVsSol.unknownMae
  )}, respectively.`,
  "",
  "## Human-assisted RouteKit onboarding proxy",
  "",
  "### Three-task validation before repair",
  "",
  ...metricTable(routekitValidationAnalysis),
  "",
  "### Five held-out tasks after repair",
  "",
  ...metricTable(routekitFinalAnalysis),
  "",
  "| Comparison | Mean active-MAE delta | 95% interval |",
  "| -- | --: | --: |",
  ...deltaRows(results.routekitAssistance.pairedDeltas),
  "",
  "Actual engineer review time, edit count, and satisfaction remain unmeasured. A blinded private review packet was generated for human completion.",
  "",
  "## Validation learning matrix",
  "",
  "| Registry recipe | Structurally valid repos | Mean unpenalized objective ↓ | Active MAE ↓ | Unknown MAE ↓ | Active F1 ↑ | Top area ↑ | Reference unknown |",
  "| -- | --: | --: | --: | --: | --: | --: | --: |",
  ...learningRows,
  "",
  "The unpenalized objective uses the same error terms as selection but omits the hard structural penalty. Recipes that were structurally invalid in any repository were never eligible there, even if their average classification metrics looked good. Use this matrix for onboarding guidance rather than treating one prompt recipe as universally optimal.",
  "",
  "## Product guidance supported by the campaign",
  "",
  "1. Generate several registry candidates during onboarding rather than a single draft.",
  "2. Always include repository structure and test whether changed-path statistics help.",
  "3. Use a small nested validation set to select among candidates; do not choose only by how plausible the cards look.",
  "4. Evaluate six, eight, and ten areas as candidate cuts, then reject catch-alls, aliases, and parent-child areas at the same runtime level.",
  "5. Use diverse historical tasks, but do not assume more history is always better. The selected amount varied by repository.",
  "6. Treat automated repair as an optional candidate, not an automatic promotion. Promote it only when validation or final evidence shows an improvement.",
  "7. Preserve a separate unknown probability and evaluate natural open-set cases before launch.",
  "",
  "## Luna runtime characteristics in these runs",
  "",
  "| Cohort | Registry | Median Luna latency | Luna inference cost per task |",
  "| -- | -- | --: | --: |",
  ...operationalRows,
  "",
  "Latency was measured through the hosted Vercel workflow and includes provider response time; it is not a local-only model benchmark. The observed Luna inference cost stayed near $0.0014–$0.0021 per classification.",
  "",
  "## Execution cost and integrity",
  "",
  "| Experiment | Status | Jobs | Provider cost | Provider budget | Budget exceeded |",
  "| -- | -- | --: | --: | --: | -- |",
  ...costRows,
  "",
  `Total provider cost: $${results.campaign.providerCostUsd.toFixed(4)}.`,
  "",
  "All final and cohort jobs succeeded. One Luna final-test response spent its original completion allowance entirely on hidden reasoning and emitted no JSON; it was rerun with the same prompt and a larger completion allowance, then overlaid transparently in these aggregate metrics.",
  "",
  "## Limitations",
  "",
  "- The public final test covers three large repositories, while the real conversational cohort is smaller and uneven across four private repositories.",
  "- Sol is the primary mapping reference. Claude provides an independent audit but is not a human gold label.",
  "- Registry selection used only twelve validation tasks per public repository, so close recipes should be treated as a small Pareto set.",
  "- The onboarding assistance experiment is a proxy until engineers record review time, edits, and preference.",
  "- The campaign tests whether Luna can classify the registry, not whether downstream model-performance estimates are additive or whether the router selects the optimal model.",
  "",
  "Private aggregate metrics and the blinded RouteKit review packet are stored under `.routekit-experiment-assets/onboarding-optimization-20260819/results/`."
].join("\n");

const blindedRegistries = [
  ["Registry A", cohortAudit.assistanceRegistries.human],
  ["Registry B", cohortAudit.assistanceRegistries.auto],
  ["Registry C", routekitFinalAudit.registries.repaired]
];
const reviewPacket = [
  "# Blinded RouteKit area-registry review packet",
  "",
  "Reviewer: ____________________",
  "",
  "Start time: ____________________",
  "",
  "End time: ____________________",
  "",
  "Instructions: review each registry without trying to infer its source. Record missing responsibilities, confusing overlaps, edits you would make, and which registry you would ship.",
  "",
  ...blindedRegistries.flatMap(([label, cards]) => {
    return [
      `## ${label}`,
      "",
      ...cards.flatMap((card) => [
        `### ${card.name}`,
        "",
        card.description,
        "",
        `Includes: ${(card.inclusions ?? []).join("; ") || "not specified"}`,
        "",
        `Excludes: ${(card.exclusions ?? []).join("; ") || "not specified"}`,
        ""
      ]),
      `Missing responsibilities in ${label}:`,
      "",
      "________________________________________________________________",
      "",
      `Confusing overlaps in ${label}:`,
      "",
      "________________________________________________________________",
      "",
      `Edits required for ${label}: ______`,
      ""
    ];
  }),
  "## Final choice",
  "",
  "Preferred registry: ____________________",
  "",
  "Confidence (1–5): ____________________",
  "",
  "Why:",
  "",
  "________________________________________________________________",
  "",
  "Would you ship it without edits? yes / no",
  "",
  "Total edits required: ____________________",
  "",
  "Reviewer satisfaction (1–5): ____________________"
].join("\n");

await mkdir(resultsDirectory, { recursive: true, mode: 0o700 });
await writeFile(metricsFile, `${JSON.stringify(results, null, 2)}\n`, { mode: 0o600 });
await writeFile(reviewPacketFile, `${reviewPacket}\n`, { mode: 0o600 });
await writeFile(reportFile, `${report}\n`);

console.log(
  JSON.stringify(
    {
      ok: true,
      metricsFile,
      reviewPacketFile,
      reportFile,
      providerCostUsd: totalProviderCostUsd,
      infrastructureCostUsd: totalInfrastructureCostUsd,
      experiments: experimentCosts.length,
      jobs: results.campaign.jobs
    },
    null,
    2
  )
);
