#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  assetRoot,
  digest,
  freezeDataset,
  root,
  safeId,
  writeJson
} from "./onboarding-optimization-common.mjs";

const sourceDatasetId = "onboarding-optimization-public-registries-3x13-v1";
const datasetId = "onboarding-optimization-construction-retry-3-v1";
const sourceDirectory = path.join(assetRoot, "construction", sourceDatasetId);
const outputDirectory = path.join(assetRoot, "construction-retry");

const retryTargets = [
  {
    originalTaskId: "generate-kubernetes-kubernetes",
    originalTreatmentId: "hybrid_paths_40_diverse_10areas"
  },
  {
    originalTaskId: "generate-grafana-grafana",
    originalTreatmentId: "hybrid_paths_40_diverse_rules"
  },
  {
    originalTaskId: "generate-grafana-grafana",
    originalTreatmentId: "hybrid_paths_40_diverse_b"
  }
];

const tasks = [];
const sourceDigests = [];
for (const target of retryTargets) {
  const sourceFile = path.join(sourceDirectory, "inputs", `${target.originalTaskId}.json`);
  const sourceBytes = await readFile(sourceFile);
  const source = JSON.parse(sourceBytes);
  const originalRequest = source.requests?.[target.originalTreatmentId];
  if (!originalRequest) {
    throw new Error(`missing ${target.originalTreatmentId} request in ${target.originalTaskId}`);
  }
  const request = {
    ...originalRequest,
    max_completion_tokens: 16_384
  };
  const taskId = `retry-${safeId(target.originalTaskId)}-${safeId(target.originalTreatmentId)}`;
  const input = {
    schemaVersion: 1,
    datasetId,
    taskId,
    repositoryId: source.repositoryId,
    requests: { registry_retry: request }
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
      repositoryId: source.repositoryId,
      originalTaskId: target.originalTaskId,
      originalTreatmentId: target.originalTreatmentId,
      retryReason: "original response reached max_completion_tokens before valid JSON closed",
      originalCompletionLimit: 8192,
      retryCompletionLimit: 16_384
    }
  });
  sourceDigests.push(digest(sourceBytes));
}

const { inventoryFile } = await freezeDataset({
  directory: outputDirectory,
  datasetId,
  role: "construction",
  tasks,
  sourceHash: digest(Buffer.from(sourceDigests.join("\n"))),
  safeguards: {
    lockedTestIncluded: false,
    originalPromptsPreserved: true,
    onlyMaximumCompletionTokensChanged: true,
    heldoutTaskTextExcludedFromGeneration: true
  },
  metadata: {
    sourceDatasetId,
    retryTargets
  }
});

console.log(JSON.stringify({ ok: true, inventoryFile, tasks: tasks.length }, null, 2));
