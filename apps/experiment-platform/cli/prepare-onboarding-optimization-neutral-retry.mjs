#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  assetRoot,
  digest,
  freezeDataset,
  neutralSchema,
  safeId,
  writeJson
} from "./onboarding-optimization-common.mjs";

const sourceDatasetId = "onboarding-optimization-neutral-93-v1";
const datasetId = "onboarding-optimization-neutral-retry-2-v1";
const sourceDirectory = path.join(assetRoot, "neutral", sourceDatasetId);
const outputDirectory = path.join(assetRoot, "neutral-retry");
const originalTreatmentId = "neutral_sol";
const retryTargets = [
  "real-conversation-codex-9b802e3b4677781fe77c",
  "real-conversation-codex-58d36071fee6d9bc6661"
];

function conciseNeutralSchema() {
  const schema = neutralSchema();
  schema.properties.responsibilities.maxItems = 6;
  const responsibility = schema.properties.responsibilities.items.properties;
  responsibility.summary.maxLength = 240;
  for (const key of ["affected_components", "evidence_refs"]) {
    responsibility[key].maxItems = 4;
    responsibility[key].items.maxLength = 160;
  }
  return schema;
}

const tasks = [];
const sourceDigests = [];
for (const originalTaskId of retryTargets) {
  const sourceFile = path.join(sourceDirectory, "inputs", `${originalTaskId}.json`);
  const sourceBytes = await readFile(sourceFile);
  const source = JSON.parse(sourceBytes);
  const originalRequest = source.requests?.[originalTreatmentId];
  if (!originalRequest) throw new Error(`missing ${originalTreatmentId} in ${originalTaskId}`);
  const messages = structuredClone(originalRequest.messages);
  messages[0].content = [
    messages[0].content,
    "Be concise: return at most six responsibilities.",
    "Keep each summary under 40 words and each component or evidence reference brief.",
    "Never repeat a responsibility, component, phrase, or evidence reference."
  ].join("\n");
  const request = {
    ...originalRequest,
    messages,
    max_completion_tokens: 6144,
    response_format: {
      ...originalRequest.response_format,
      json_schema: {
        ...originalRequest.response_format.json_schema,
        name: "routekit_onboarding_optimization_neutral_retry",
        schema: conciseNeutralSchema()
      }
    }
  };
  const taskId = `retry-${safeId(originalTaskId)}`;
  const input = {
    schemaVersion: 1,
    datasetId,
    taskId,
    repositoryId: source.repositoryId,
    sourceEpisodeId: source.sourceEpisodeId,
    requests: { neutral_retry: request }
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
      sourceEpisodeId: source.sourceEpisodeId,
      originalTaskId,
      originalTreatmentId,
      retryReason: "original response repeated fields until the completion limit",
      retryCompletionLimit: 6144,
      maximumResponsibilities: 6
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
    areaRegistryExcluded: true,
    labelsExcluded: true,
    changedFilesExcluded: true,
    originalTaskContextPreserved: true,
    retryAddsOnlyConcisenessConstraints: true
  },
  metadata: {
    sourceDatasetId,
    retryTargets
  }
});

console.log(JSON.stringify({ ok: true, inventoryFile, tasks: tasks.length }, null, 2));
