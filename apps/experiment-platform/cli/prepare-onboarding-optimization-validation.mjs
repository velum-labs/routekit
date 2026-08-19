#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  readJsonArtifact,
  VercelBlobArtifactStore
} from "@velum-labs/routekit-eval-store/platform";

import {
  assetRoot,
  compositionRequest,
  digest,
  freezeDataset,
  normalizeCards,
  responseObject,
  root,
  safeId,
  taskAwareTail,
  writeJson
} from "./onboarding-optimization-common.mjs";

const datasetId = "onboarding-optimization-validation-36x15-v1";
const outputDirectory = path.join(assetRoot, "validation");
const previousSourceFile = path.join(
  root,
  ".routekit-experiment-assets/onboarding-generalization-20260819/source/source-inventory.json"
);
const previousRegistryAuditFile = path.join(
  root,
  ".routekit-experiment-assets/onboarding-generalization-20260819/evaluation/registry-audit.json"
);
const constructionExperimentId = "onboarding-optimization-public-registries-3x13-v1";
const baseUrl = (
  process.env.EXPERIMENT_PLATFORM_URL ?? "https://routekit-experiments-development.vercel.app"
).replace(/\/$/u, "");
const token = process.env.EXPERIMENT_PLATFORM_API_TOKEN;
if (!token) throw new Error("EXPERIMENT_PLATFORM_API_TOKEN is required");
if (!process.env.BLOB_READ_WRITE_TOKEN && !process.env.VERCEL_OIDC_TOKEN) {
  throw new Error("Vercel Blob credentials are required");
}

const newRegistryIds = [
  "tasks_only_40_recent",
  "structure_only",
  "hybrid_40_recent",
  "hybrid_paths_40_recent",
  "hybrid_paths_5_diverse",
  "hybrid_paths_10_diverse",
  "hybrid_paths_20_diverse",
  "hybrid_paths_40_diverse_a",
  "hybrid_paths_40_diverse_b",
  "hybrid_paths_80_diverse",
  "hybrid_paths_40_diverse_6areas",
  "hybrid_paths_40_diverse_10areas",
  "hybrid_paths_40_diverse_rules"
];
const comparisonGroups = ["human", "previous_unconstrained", ...newRegistryIds];

async function completedExperiment(experimentId, ignoreInvalidOutputs = false) {
  const response = await fetch(`${baseUrl}/api/experiments/${experimentId}`, {
    headers: { authorization: `Bearer ${token}` }
  });
  if (!response.ok) throw new Error(`failed to read ${experimentId}: ${response.status}`);
  const snapshot = await response.json();
  const unsuccessful = snapshot.jobs.filter((job) => job.status !== "succeeded");
  if (unsuccessful.length > 0) {
    throw new Error(`${experimentId} has ${unsuccessful.length} unsuccessful jobs`);
  }
  if (
    !["completed", ...(ignoreInvalidOutputs ? ["failed"] : [])].includes(snapshot.experiment.status)
  ) {
    throw new Error(`${experimentId} is ${snapshot.experiment.status}, not completed`);
  }
  return snapshot;
}

async function outputsByTask(snapshot, ignoreInvalid = false) {
  const store = new VercelBlobArtifactStore();
  const entries = (
    await Promise.all(
      snapshot.jobs.map(async (record) => {
        try {
          return [
            `${record.job.taskId}:${record.job.treatmentId}`,
            responseObject(await readJsonArtifact(store, record.outputArtifact))
          ];
        } catch (error) {
          if (!ignoreInvalid) throw error;
          return undefined;
        }
      })
    )
  ).filter(Boolean);
  return new Map(entries);
}

const [sourceBytes, registryAuditBytes, construction, neutral, neutralRetry] = await Promise.all([
  readFile(previousSourceFile),
  readFile(previousRegistryAuditFile),
  completedExperiment(constructionExperimentId),
  completedExperiment("onboarding-generalization-neutral-120-v1", true),
  completedExperiment("onboarding-generalization-neutral-retry-1-v1")
]);
const [constructionOutputs, neutralOutputs, neutralRetryOutputs] = await Promise.all([
  outputsByTask(construction),
  outputsByTask(neutral, true),
  outputsByTask(neutralRetry)
]);
const source = JSON.parse(sourceBytes);
const previousRegistryAudit = JSON.parse(registryAuditBytes);

function neutralOutput(taskId) {
  const value =
    neutralOutputs.get(`${taskId}:neutral_sol`) ??
    neutralRetryOutputs.get(`${taskId}:neutral_sol_retry`);
  if (!value) throw new Error(`missing neutral output for ${taskId}`);
  return value;
}

const registries = new Map();
for (const repository of source.repositories) {
  const previous = previousRegistryAudit.repositories.find(
    (entry) => entry.repositoryId === repository.repositoryId
  );
  if (!previous) throw new Error(`missing previous registry for ${repository.repositoryId}`);
  const generated = {};
  const taskId = `generate-${safeId(repository.repositoryId)}`;
  for (const registryId of newRegistryIds) {
    const output = constructionOutputs.get(`${taskId}:${registryId}`);
    if (!output?.areas) {
      throw new Error(`missing ${registryId} construction output for ${repository.repositoryId}`);
    }
    generated[registryId] = normalizeCards(output.areas);
  }
  registries.set(repository.repositoryId, {
    human: normalizeCards(previous.registries.human),
    previous_unconstrained: normalizeCards(previous.registries.auto_unconstrained),
    ...generated
  });
}

const treatmentDefinitions = comparisonGroups.flatMap((comparisonGroup) => [
  {
    id: `${comparisonGroup}__sol`,
    model: "openai/gpt-5.6-sol",
    evaluationRole: "composition_reference",
    comparisonGroup
  },
  {
    id: `${comparisonGroup}__luna`,
    model: "openai/gpt-5.6-luna",
    evaluationRole: "composition_candidate",
    comparisonGroup
  }
]);
const tasks = [];
const registryAudit = [];
for (const repository of source.repositories) {
  const repositoryRegistries = registries.get(repository.repositoryId);
  const chronological = [...repository.evaluation].sort((left, right) =>
    left.mergedAt.localeCompare(right.mergedAt)
  );
  const validationTasks = chronological.slice(0, 12);
  const finalTasks = chronological.slice(12);
  if (validationTasks.length !== 12 || finalTasks.length !== 28) {
    throw new Error(`${repository.repositoryId} does not have a 12/28 nested split`);
  }
  registryAudit.push({
    repositoryId: repository.repositoryId,
    validationTaskIds: validationTasks.map((task) => task.taskId),
    finalTaskIds: finalTasks.map((task) => task.taskId),
    registries: repositoryRegistries
  });
  for (const task of validationTasks) {
    const tail = taskAwareTail(repository.profile, task);
    const neutralReference = neutralOutput(task.taskId);
    const requests = {};
    for (const comparisonGroup of comparisonGroups) {
      const cards = repositoryRegistries[comparisonGroup];
      requests[`${comparisonGroup}__sol`] = compositionRequest({
        cards,
        tail,
        neutral: neutralReference,
        name: `${comparisonGroup}_sol_reference`
      });
      requests[`${comparisonGroup}__luna`] = compositionRequest({
        cards,
        tail,
        name: `${comparisonGroup}_luna_candidate`,
        direct: true
      });
    }
    const taskId = `validation-${safeId(task.taskId)}`;
    const input = {
      schemaVersion: 1,
      datasetId,
      taskId,
      sourceTaskId: task.taskId,
      repositoryId: repository.repositoryId,
      requests
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
        sourceTaskId: task.taskId,
        repositoryId: repository.repositoryId,
        mergedAt: task.mergedAt,
        split: "nested-validation",
        finalTaskTextExcludedFromSelection: true
      }
    });
  }
}
if (tasks.length !== 36) throw new Error(`expected 36 validation tasks, found ${tasks.length}`);

const registryAuditResult = await writeJson(
  path.join(outputDirectory, "validation-registry-audit.json"),
  {
    schemaVersion: 1,
    comparisonGroups,
    treatmentDefinitions,
    repositories: registryAudit
  }
);
const sourceHash = digest(
  Buffer.concat([sourceBytes, registryAuditBytes, registryAuditResult.bytes])
);
const { inventoryFile } = await freezeDataset({
  directory: outputDirectory,
  datasetId,
  role: "development",
  tasks,
  sourceHash,
  safeguards: {
    lockedTestIncluded: false,
    nestedChronologicalSplit: true,
    validationTasksPerRepository: 12,
    finalTasksPerRepository: 28,
    finalTaskTextExcludedFromSelection: true,
    changedFilesExcludedFromModelPrompts: true,
    neutralDecompositionFrozenBeforeRegistryMapping: true
  },
  metadata: { comparisonGroups, treatmentDefinitions }
});

console.log(
  JSON.stringify(
    {
      ok: true,
      inventoryFile,
      tasks: tasks.length,
      comparisonGroups: comparisonGroups.length,
      treatments: treatmentDefinitions.length
    },
    null,
    2
  )
);
