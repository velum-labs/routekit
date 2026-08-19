#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  assetRoot,
  digest,
  freezeDataset,
  safeId,
  writeJson
} from "./onboarding-optimization-common.mjs";

const sourceDatasetId = "onboarding-optimization-final-84x4x3-v1";
const datasetId = "onboarding-optimization-final-retry-1-v1";
const originalTaskId = "final-kubernetes-kubernetes-heldout-pr-141296";
const originalTreatmentId = "human__luna";
const sourceFile = path.join(
  assetRoot,
  "final",
  sourceDatasetId,
  "inputs",
  `${originalTaskId}.json`
);
const outputDirectory = path.join(assetRoot, "final-retry");

const sourceBytes = await readFile(sourceFile);
const source = JSON.parse(sourceBytes);
const originalRequest = source.requests?.[originalTreatmentId];
if (!originalRequest) throw new Error(`missing ${originalTreatmentId} in ${originalTaskId}`);
const request = {
  ...originalRequest,
  max_completion_tokens: 16_384
};
const taskId = `retry-${safeId(originalTaskId)}-${safeId(originalTreatmentId)}`;
const input = {
  schemaVersion: 1,
  datasetId,
  taskId,
  repositoryId: source.repositoryId,
  sourceTaskId: source.sourceTaskId,
  requests: { final_retry: request }
};
const file = path.join(outputDirectory, datasetId, "inputs", `${taskId}.json`);
const result = await writeJson(file, input);
const tasks = [
  {
    id: taskId,
    file,
    digest: result.digest,
    size: result.bytes.length,
    pathname: `inputs/${datasetId}/${taskId}/sha256/${result.digest.slice(0, 2)}/${
      result.digest
    }.json`,
    metadata: {
      repositoryId: source.repositoryId,
      sourceTaskId: source.sourceTaskId,
      originalTaskId,
      originalTreatmentId,
      comparisonGroup: "human",
      evaluationRole: "composition_candidate",
      retryReason: "original Luna call spent its completion limit entirely on reasoning",
      originalCompletionLimit: 8192,
      retryCompletionLimit: 16_384
    }
  }
];

const { inventoryFile } = await freezeDataset({
  directory: outputDirectory,
  datasetId,
  role: "development",
  tasks,
  sourceHash: digest(sourceBytes),
  safeguards: {
    lockedTestIncluded: false,
    originalPromptPreserved: true,
    onlyMaximumCompletionTokensChanged: true,
    registrySelectionAlreadyFrozen: true
  },
  metadata: {
    sourceDatasetId,
    originalTaskId,
    originalTreatmentId
  }
});

console.log(JSON.stringify({ ok: true, inventoryFile, tasks: tasks.length }, null, 2));
