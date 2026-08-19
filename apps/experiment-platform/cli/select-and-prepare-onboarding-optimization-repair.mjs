#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";

import { extractCompositionPrediction } from "@velum-labs/routekit-eval-core/experiment";
import {
  readJsonArtifact,
  VercelBlobArtifactStore
} from "@velum-labs/routekit-eval-store/platform";

import {
  assetRoot,
  digest,
  freezeDataset,
  registrySchema,
  request,
  root,
  structuralAudit,
  writeJson
} from "./onboarding-optimization-common.mjs";

const validationExperimentId = "onboarding-optimization-validation-36x15-v1";
const datasetId = "onboarding-optimization-repair-3-v1";
const outputDirectory = path.join(assetRoot, "repair");
const validationAuditFile = path.join(assetRoot, "validation/validation-registry-audit.json");
const previousSourceFile = path.join(
  root,
  ".routekit-experiment-assets/onboarding-generalization-20260819/source/source-inventory.json"
);
const baseUrl = (
  process.env.EXPERIMENT_PLATFORM_URL ?? "https://routekit-experiments-development.vercel.app"
).replace(/\/$/u, "");
const token = process.env.EXPERIMENT_PLATFORM_API_TOKEN;
if (!token) throw new Error("EXPERIMENT_PLATFORM_API_TOKEN is required");
if (!process.env.BLOB_READ_WRITE_TOKEN && !process.env.VERCEL_OIDC_TOKEN) {
  throw new Error("Vercel Blob credentials are required");
}

const baselineGroups = new Set(["human", "previous_unconstrained"]);
const mean = (values) =>
  values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0) / values.length;
const round = (value, places = 6) =>
  value === undefined ? undefined : Number(value.toFixed(places));

function activeAreas(reference) {
  const active = Object.entries(reference.areaCompositionScores)
    .filter(([, score]) => score >= 0.25)
    .map(([area]) => area);
  return active.length > 0 ? active : Object.keys(reference.areaCompositionScores);
}

function activeMae(candidate, reference) {
  return mean(
    activeAreas(reference).map((area) =>
      Math.abs(
        (candidate.areaCompositionScores[area] ?? 0) - (reference.areaCompositionScores[area] ?? 0)
      )
    )
  );
}

function cosine(candidate, reference) {
  const areas = Object.keys(reference.areaCompositionScores);
  let dot = 0;
  let left = 0;
  let right = 0;
  for (const area of areas) {
    const a = candidate.areaCompositionScores[area] ?? 0;
    const b = reference.areaCompositionScores[area] ?? 0;
    dot += a * b;
    left += a * a;
    right += b * b;
  }
  return left === 0 || right === 0 ? 0 : dot / Math.sqrt(left * right);
}

function f1(candidate, reference) {
  const expected = new Set(
    Object.entries(reference.areaCompositionScores)
      .filter(([, score]) => score >= 0.25)
      .map(([area]) => area)
  );
  const predicted = new Set(
    Object.entries(candidate.areaCompositionScores)
      .filter(([, score]) => score >= 0.25)
      .map(([area]) => area)
  );
  const truePositive = [...predicted].filter((area) => expected.has(area)).length;
  const precision =
    predicted.size === 0 ? (expected.size === 0 ? 1 : 0) : truePositive / predicted.size;
  const recall =
    expected.size === 0 ? (predicted.size === 0 ? 1 : 0) : truePositive / expected.size;
  return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
}

function topArea(prediction) {
  return Object.entries(prediction.areaCompositionScores).sort(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0])
  )[0]?.[0];
}

function summarizePairs(pairs) {
  return {
    pairs: pairs.length,
    activeMae: round(mean(pairs.map((pair) => activeMae(pair.candidate, pair.reference)))),
    cosine: round(mean(pairs.map((pair) => cosine(pair.candidate, pair.reference)))),
    activeF1: round(mean(pairs.map((pair) => f1(pair.candidate, pair.reference)))),
    topAreaAgreement: round(
      mean(pairs.map((pair) => (topArea(pair.candidate) === topArea(pair.reference) ? 1 : 0)))
    ),
    unknownMae: round(
      mean(
        pairs.map((pair) =>
          Math.abs(pair.candidate.unknownProbability - pair.reference.unknownProbability)
        )
      )
    ),
    referenceUnknown: round(mean(pairs.map((pair) => pair.reference.unknownProbability)))
  };
}

function paretoFrontier(candidates) {
  return candidates.filter(
    (candidate) =>
      !candidates.some(
        (other) =>
          other.comparisonGroup !== candidate.comparisonGroup &&
          other.classifiability <= candidate.classifiability &&
          other.metrics.referenceUnknown <= candidate.metrics.referenceUnknown &&
          (other.classifiability < candidate.classifiability ||
            other.metrics.referenceUnknown < candidate.metrics.referenceUnknown)
      )
  );
}

const response = await fetch(`${baseUrl}/api/experiments/${validationExperimentId}`, {
  headers: { authorization: `Bearer ${token}` }
});
if (!response.ok) throw new Error(`failed to read validation experiment: ${response.status}`);
const snapshot = await response.json();
if (snapshot.experiment?.status !== "completed") {
  throw new Error(`${validationExperimentId} is ${snapshot.experiment?.status}, not completed`);
}
const unsuccessful = snapshot.jobs.filter((record) => record.status !== "succeeded");
if (unsuccessful.length > 0) throw new Error(`validation has ${unsuccessful.length} failed jobs`);

const [validationAuditBytes, previousSourceBytes] = await Promise.all([
  readFile(validationAuditFile),
  readFile(previousSourceFile)
]);
const validationAudit = JSON.parse(validationAuditBytes);
const previousSource = JSON.parse(previousSourceBytes);
const metadataByTask = new Map(
  snapshot.experiment.manifest.tasks.map((task) => [task.id, task.metadata])
);
const store = new VercelBlobArtifactStore();
const entries = await Promise.all(
  snapshot.jobs.map(async (record) => ({
    taskId: record.job.taskId,
    sourceTaskId: metadataByTask.get(record.job.taskId)?.sourceTaskId,
    repositoryId: metadataByTask.get(record.job.taskId)?.repositoryId,
    comparisonGroup: record.job.configuration.comparisonGroup,
    evaluationRole: record.job.configuration.evaluationRole,
    prediction: extractCompositionPrediction(await readJsonArtifact(store, record.outputArtifact))
  }))
);

const tasks = [];
const selection = [];
for (const repositoryAudit of validationAudit.repositories) {
  const repositoryId = repositoryAudit.repositoryId;
  const repositoryEntries = entries.filter((entry) => entry.repositoryId === repositoryId);
  const metrics = validationAudit.comparisonGroups.map((comparisonGroup) => {
    const group = repositoryEntries.filter((entry) => entry.comparisonGroup === comparisonGroup);
    const references = new Map(
      group
        .filter((entry) => entry.evaluationRole === "composition_reference")
        .map((entry) => [entry.taskId, entry.prediction])
    );
    const pairs = group
      .filter((entry) => entry.evaluationRole === "composition_candidate")
      .map((entry) => ({
        taskId: entry.taskId,
        sourceTaskId: entry.sourceTaskId,
        reference: references.get(entry.taskId),
        candidate: entry.prediction
      }))
      .filter((pair) => pair.reference && pair.candidate);
    const cards = repositoryAudit.registries[comparisonGroup];
    const diagnostics = structuralAudit(cards);
    const groupMetrics = summarizePairs(pairs);
    const classifiability = groupMetrics.activeMae + 0.5 * groupMetrics.unknownMae;
    const structuralPenalty = diagnostics.valid ? 0 : 10;
    return {
      comparisonGroup,
      metrics: groupMetrics,
      diagnostics,
      classifiability: round(classifiability),
      selectionScore: round(
        classifiability + 0.15 * groupMetrics.referenceUnknown + structuralPenalty
      ),
      pairs
    };
  });
  const candidates = metrics
    .filter((entry) => !baselineGroups.has(entry.comparisonGroup))
    .sort(
      (left, right) =>
        left.selectionScore - right.selectionScore ||
        left.comparisonGroup.localeCompare(right.comparisonGroup)
    );
  const winner = candidates[0];
  if (!winner || !winner.diagnostics.valid) {
    throw new Error(`${repositoryId} has no structurally valid candidate`);
  }
  const sourceRepository = previousSource.repositories.find(
    (entry) => entry.repositoryId === repositoryId
  );
  const sourceTasks = new Map(sourceRepository.evaluation.map((task) => [task.taskId, task]));
  const errorExamples = winner.pairs
    .map((pair) => {
      const sourceTask = sourceTasks.get(pair.sourceTaskId);
      return {
        sourceTaskId: pair.sourceTaskId,
        request: [sourceTask?.title, sourceTask?.body].filter(Boolean).join("\n\n").slice(0, 1800),
        solReference: pair.reference,
        lunaPrediction: pair.candidate,
        activeMae: round(activeMae(pair.candidate, pair.reference))
      };
    })
    .sort((left, right) => right.activeMae - left.activeMae);
  const repairSystem = [
    "Repair an Area Registry after a nested validation run.",
    "Keep exactly the same number of areas and preserve stable useful responsibilities when possible.",
    "Improve future coverage and Luna classifiability without fitting to individual validation requests.",
    "Use validation errors as boundary evidence, not as area names or temporary feature buckets.",
    "Avoid catch-alls, aliases, duplicate ownership, and parent-child pairs at the same runtime level.",
    "Write explicit exclusions and confusing-neighbor rules.",
    "Final-test requests are unavailable and must not be guessed.",
    "Return exactly one strict JSON object and no prose."
  ].join("\n");
  const repairUser = [
    "[REPOSITORY]",
    repositoryId,
    "",
    "[SELECTED REGISTRY]",
    JSON.stringify({ areas: repositoryAudit.registries[winner.comparisonGroup] }),
    "",
    "[VALIDATION SUMMARY]",
    JSON.stringify({
      metrics: winner.metrics,
      diagnostics: winner.diagnostics,
      selectionScore: winner.selectionScore
    }),
    "",
    "[VALIDATION ERROR EXAMPLES]",
    JSON.stringify(errorExamples)
  ].join("\n");
  const taskId = `repair-${repositoryId.replace("/", "-")}`;
  const input = {
    schemaVersion: 1,
    datasetId,
    taskId,
    repositoryId,
    requests: {
      repair_sol: request(
        repairSystem,
        repairUser,
        registrySchema(repositoryAudit.registries[winner.comparisonGroup].length),
        "routekit_onboarding_registry_repair"
      )
    }
  };
  const file = path.join(outputDirectory, datasetId, "inputs", `${taskId}.json`);
  const result = await writeJson(file, input);
  tasks.push({
    id: taskId,
    file,
    digest: result.digest,
    size: result.bytes.length,
    pathname: `inputs/${datasetId}/${taskId}/sha256/${result.digest.slice(0, 2)}/${
      result.digest
    }.json`,
    metadata: {
      repositoryId,
      selectedComparisonGroup: winner.comparisonGroup,
      selectedAreaCount: repositoryAudit.registries[winner.comparisonGroup].length,
      finalTaskTextExcluded: true
    }
  });
  selection.push({
    repositoryId,
    winner: {
      comparisonGroup: winner.comparisonGroup,
      metrics: winner.metrics,
      diagnostics: winner.diagnostics,
      selectionScore: winner.selectionScore
    },
    paretoFrontier: paretoFrontier(candidates).map((entry) => ({
      comparisonGroup: entry.comparisonGroup,
      metrics: entry.metrics,
      diagnostics: entry.diagnostics,
      selectionScore: entry.selectionScore
    })),
    allMetrics: metrics.map(({ pairs: _pairs, ...entry }) => entry),
    selectedRegistry: repositoryAudit.registries[winner.comparisonGroup]
  });
}

const selectionResult = await writeJson(path.join(outputDirectory, "validation-selection.json"), {
  schemaVersion: 1,
  experimentId: validationExperimentId,
  selectionObjective:
    "activeMae + 0.50 * unknownMae + 0.15 * referenceUnknown + structuralPenalties",
  repositories: selection
});
const { inventoryFile } = await freezeDataset({
  directory: outputDirectory,
  datasetId,
  role: "construction",
  tasks,
  sourceHash: digest(
    Buffer.concat([validationAuditBytes, previousSourceBytes, selectionResult.bytes])
  ),
  safeguards: {
    lockedTestIncluded: false,
    finalTaskTextExcludedFromSelection: true,
    finalTaskTextExcludedFromRepair: true,
    changedFilesExcludedFromModelPrompts: true,
    nestedValidationOnly: true
  },
  metadata: {
    selectionObjective:
      "activeMae + 0.50 * unknownMae + 0.15 * referenceUnknown + structuralPenalties"
  }
});

console.log(
  JSON.stringify(
    {
      ok: true,
      inventoryFile,
      selected: selection.map((entry) => ({
        repositoryId: entry.repositoryId,
        comparisonGroup: entry.winner.comparisonGroup,
        selectionScore: entry.winner.selectionScore
      }))
    },
    null,
    2
  )
);
