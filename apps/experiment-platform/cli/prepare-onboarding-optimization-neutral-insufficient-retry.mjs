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
const datasetId = "onboarding-optimization-neutral-insufficient-retry-1-v1";
const originalTaskId = "real-conversation-codex-9b802e3b4677781fe77c";
const originalTreatmentId = "neutral_sol";
const sourceFile = path.join(
  assetRoot,
  "neutral",
  sourceDatasetId,
  "inputs",
  `${originalTaskId}.json`
);
const outputDirectory = path.join(assetRoot, "neutral-retry");

const sourceBytes = await readFile(sourceFile);
const source = JSON.parse(sourceBytes);
const originalRequest = source.requests?.[originalTreatmentId];
if (!originalRequest) throw new Error(`missing ${originalTreatmentId} in ${originalTaskId}`);

const schema = neutralSchema();
schema.properties.responsibilities.minItems = 0;
schema.properties.responsibilities.maxItems = 4;
const messages = structuredClone(originalRequest.messages);
messages[0].content = [
  messages[0].content,
  "A purely referential continuation with no recoverable underlying task has zero responsibilities.",
  "For insufficient context, return an empty responsibilities array, repository_scope",
  '"insufficient_information", and a high insufficient_information_probability.',
  "Never invent work merely to satisfy the schema."
].join("\n");
const request = {
  ...originalRequest,
  messages,
  max_completion_tokens: 2048,
  response_format: {
    ...originalRequest.response_format,
    json_schema: {
      ...originalRequest.response_format.json_schema,
      name: "routekit_onboarding_optimization_neutral_insufficient_retry",
      schema
    }
  }
};
const taskId = `retry-insufficient-${safeId(originalTaskId)}`;
const input = {
  schemaVersion: 1,
  datasetId,
  taskId,
  repositoryId: source.repositoryId,
  sourceEpisodeId: source.sourceEpisodeId,
  requests: { neutral_insufficient_retry: request }
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
      sourceEpisodeId: source.sourceEpisodeId,
      originalTaskId,
      originalTreatmentId,
      retryReason: "the source task has no recoverable coding responsibility",
      emptyResponsibilitiesAllowed: true
    }
  }
];

const { inventoryFile } = await freezeDataset({
  directory: outputDirectory,
  datasetId,
  role: "construction",
  tasks,
  sourceHash: digest(sourceBytes),
  safeguards: {
    lockedTestIncluded: false,
    areaRegistryExcluded: true,
    labelsExcluded: true,
    changedFilesExcluded: true,
    originalTaskContextPreserved: true,
    insufficientInformationRepresentable: true
  },
  metadata: {
    sourceDatasetId,
    originalTaskId
  }
});

console.log(JSON.stringify({ ok: true, inventoryFile, tasks: tasks.length }, null, 2));
