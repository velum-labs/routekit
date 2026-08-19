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

const datasetId = "onboarding-optimization-final-84x4x3-v1";
const outputDirectory = path.join(assetRoot, "final");
const selectionFile = path.join(assetRoot, "repair/validation-selection.json");
const validationAuditFile = path.join(assetRoot, "validation/validation-registry-audit.json");
const previousSourceFile = path.join(
  root,
  ".routekit-experiment-assets/onboarding-generalization-20260819/source/source-inventory.json"
);
const repairExperimentId = "onboarding-optimization-repair-3-v1";
const baseUrl = (
  process.env.EXPERIMENT_PLATFORM_URL ?? "https://routekit-experiments-development.vercel.app"
).replace(/\/$/u, "");
const token = process.env.EXPERIMENT_PLATFORM_API_TOKEN;
if (!token) throw new Error("EXPERIMENT_PLATFORM_API_TOKEN is required");
if (!process.env.BLOB_READ_WRITE_TOKEN && !process.env.VERCEL_OIDC_TOKEN) {
  throw new Error("Vercel Blob credentials are required");
}

async function snapshot(experimentId, allowFailed = false) {
  const response = await fetch(`${baseUrl}/api/experiments/${experimentId}`, {
    headers: { authorization: `Bearer ${token}` }
  });
  if (!response.ok) throw new Error(`failed to read ${experimentId}: ${response.status}`);
  const value = await response.json();
  if (
    value.experiment?.status !== "completed" &&
    !(allowFailed && value.experiment?.status === "failed")
  ) {
    throw new Error(`${experimentId} is ${value.experiment?.status}, not terminal`);
  }
  if (value.jobs.some((record) => record.status !== "succeeded")) {
    throw new Error(`${experimentId} has unsuccessful jobs`);
  }
  return value;
}

async function outputMap(value, ignoreInvalid = false) {
  const store = new VercelBlobArtifactStore();
  const pairs = (
    await Promise.all(
      value.jobs.map(async (record) => {
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
  return new Map(pairs);
}

const [
  selectionBytes,
  validationAuditBytes,
  previousSourceBytes,
  repairSnapshot,
  neutralSnapshot,
  neutralRetrySnapshot
] = await Promise.all([
  readFile(selectionFile),
  readFile(validationAuditFile),
  readFile(previousSourceFile),
  snapshot(repairExperimentId),
  snapshot("onboarding-generalization-neutral-120-v1", true),
  snapshot("onboarding-generalization-neutral-retry-1-v1")
]);
const [repairOutputs, neutralOutputs, neutralRetryOutputs] = await Promise.all([
  outputMap(repairSnapshot),
  outputMap(neutralSnapshot, true),
  outputMap(neutralRetrySnapshot)
]);
const selection = JSON.parse(selectionBytes);
const validationAudit = JSON.parse(validationAuditBytes);
const previousSource = JSON.parse(previousSourceBytes);
const comparisonGroups = ["human", "previous_unconstrained", "selected", "repaired"];

function neutralOutput(taskId) {
  const value =
    neutralOutputs.get(`${taskId}:neutral_sol`) ??
    neutralRetryOutputs.get(`${taskId}:neutral_sol_retry`);
  if (!value) throw new Error(`missing neutral output for ${taskId}`);
  return value;
}

const treatmentDefinitions = comparisonGroups.flatMap((comparisonGroup) => [
  {
    id: `${comparisonGroup}__sol`,
    model: "openai/gpt-5.6-sol",
    evaluationRole: "composition_reference",
    comparisonGroup
  },
  {
    id: `${comparisonGroup}__claude`,
    model: "anthropic/claude-sonnet-5",
    evaluationRole: "composition_independent_reference",
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
const finalAudit = [];
for (const repositoryAudit of validationAudit.repositories) {
  const repositoryId = repositoryAudit.repositoryId;
  const selected = selection.repositories.find((entry) => entry.repositoryId === repositoryId);
  const sourceRepository = previousSource.repositories.find(
    (entry) => entry.repositoryId === repositoryId
  );
  if (!selected || !sourceRepository) throw new Error(`missing final inputs for ${repositoryId}`);
  const repairTaskId = `repair-${repositoryId.replace("/", "-")}`;
  const repairedOutput = repairOutputs.get(`${repairTaskId}:repair_sol`);
  if (!repairedOutput?.areas) throw new Error(`missing repaired registry for ${repositoryId}`);
  const registries = {
    human: normalizeCards(repositoryAudit.registries.human),
    previous_unconstrained: normalizeCards(repositoryAudit.registries.previous_unconstrained),
    selected: normalizeCards(selected.selectedRegistry),
    repaired: normalizeCards(repairedOutput.areas)
  };
  const sourceTasks = new Map(sourceRepository.evaluation.map((task) => [task.taskId, task]));
  finalAudit.push({
    repositoryId,
    selectedSource: selected.winner.comparisonGroup,
    finalTaskIds: repositoryAudit.finalTaskIds,
    registries
  });
  for (const sourceTaskId of repositoryAudit.finalTaskIds) {
    const sourceTask = sourceTasks.get(sourceTaskId);
    if (!sourceTask) throw new Error(`missing source task ${sourceTaskId}`);
    const tail = taskAwareTail(sourceRepository.profile, sourceTask);
    const neutral = neutralOutput(sourceTaskId);
    const requests = {};
    for (const comparisonGroup of comparisonGroups) {
      const cards = registries[comparisonGroup];
      requests[`${comparisonGroup}__sol`] = compositionRequest({
        cards,
        tail,
        neutral,
        name: `${comparisonGroup}_sol_reference`
      });
      requests[`${comparisonGroup}__claude`] = compositionRequest({
        cards,
        tail,
        neutral,
        name: `${comparisonGroup}_independent_reference`
      });
      requests[`${comparisonGroup}__luna`] = compositionRequest({
        cards,
        tail,
        name: `${comparisonGroup}_luna_candidate`,
        direct: true
      });
    }
    const taskId = `final-${safeId(sourceTaskId)}`;
    const input = {
      schemaVersion: 1,
      datasetId,
      taskId,
      sourceTaskId,
      repositoryId,
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
        sourceTaskId,
        repositoryId,
        mergedAt: sourceTask.mergedAt,
        split: "nested-final-test",
        registrySelectionFrozenBeforeTaskExposure: true
      }
    });
  }
}
if (tasks.length !== 84) throw new Error(`expected 84 final tasks, found ${tasks.length}`);

const auditResult = await writeJson(path.join(outputDirectory, "final-registry-audit.json"), {
  schemaVersion: 1,
  comparisonGroups,
  treatmentDefinitions,
  repositories: finalAudit
});
const { inventoryFile } = await freezeDataset({
  directory: outputDirectory,
  datasetId,
  role: "development",
  tasks,
  sourceHash: digest(
    Buffer.concat([selectionBytes, validationAuditBytes, previousSourceBytes, auditResult.bytes])
  ),
  safeguards: {
    lockedTestIncluded: false,
    registrySelectionFrozenBeforeFinalTaskExposure: true,
    repairFrozenBeforeFinalTaskExposure: true,
    changedFilesExcludedFromModelPrompts: true,
    neutralDecompositionFrozenBeforeRegistryMapping: true,
    independentJudgeBlindedToRegistrySource: true
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
