#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../../..");
const sourceInventoryFile = path.join(
  root,
  ".routekit-experiment-assets/onboarding-generalization-20260819/construction/onboarding-generalization-neutral-120-v1/input-inventory.json"
);
const outputRoot = path.join(
  root,
  ".routekit-experiment-assets/onboarding-generalization-20260819/construction"
);
const datasetId = "onboarding-generalization-neutral-retry-1-v1";
const taskId = "grafana-grafana-heldout-pr-130858";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const safeId = (value) => value.toLowerCase().replaceAll(/[^a-z0-9._-]+/g, "-");

async function writeJson(file, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, bytes, { mode: 0o600 });
  return { bytes, digest: digest(bytes) };
}

const sourceInventory = JSON.parse(await readFile(sourceInventoryFile, "utf8"));
const sourceTask = sourceInventory.tasks.find((task) => task.id === taskId);
if (!sourceTask) throw new Error(`missing source task ${taskId}`);
const sourceInput = JSON.parse(await readFile(sourceTask.file, "utf8"));
const retryRequest = structuredClone(sourceInput.requests.neutral_sol);
retryRequest.max_completion_tokens = 16_384;
const input = {
  ...sourceInput,
  datasetId,
  requests: { neutral_sol_retry: retryRequest }
};
const file = path.join(outputRoot, datasetId, "inputs", `${safeId(taskId)}.json`);
const inputResult = await writeJson(file, input);
const task = {
  id: taskId,
  file,
  digest: inputResult.digest,
  size: inputResult.bytes.length,
  pathname: `inputs/${datasetId}/${safeId(taskId)}/sha256/${inputResult.digest.slice(
    0,
    2
  )}/${inputResult.digest}.json`,
  metadata: {
    ...sourceTask.metadata,
    retryReason: "original strict JSON response reached the 8192-token completion limit",
    originalExperimentId: "onboarding-generalization-neutral-120-v1"
  }
};
const manifestFile = path.join(outputRoot, datasetId, "dataset-manifest.json");
const manifestResult = await writeJson(manifestFile, {
  schemaVersion: 1,
  datasetId,
  generatedAt: "2026-08-19T00:00:00.000Z",
  role: "construction",
  counts: { tasks: 1 },
  safeguards: {
    strictTemporalSplit: true,
    heldoutTaskTextExcludedFromRegistryGeneration: true,
    changedFilesExcludedFromModelPrompts: true,
    lockedTestIncluded: false
  },
  tasks: [{ ...task, file: undefined }]
});
const inventory = {
  schemaVersion: 1,
  datasetId,
  datasetHash: manifestResult.digest,
  datasetManifestFile: manifestFile,
  datasetManifestPathname: `datasets/${datasetId}/sha256/${manifestResult.digest.slice(
    0,
    2
  )}/${manifestResult.digest}.json`,
  datasetManifestSize: manifestResult.bytes.length,
  tasks: [task]
};
const inventoryFile = path.join(outputRoot, datasetId, "input-inventory.json");
await writeJson(inventoryFile, inventory);
console.log(
  JSON.stringify(
    {
      ok: true,
      inventoryFile,
      datasetHash: inventory.datasetHash,
      taskId,
      maxCompletionTokens: retryRequest.max_completion_tokens
    },
    null,
    2
  )
);
