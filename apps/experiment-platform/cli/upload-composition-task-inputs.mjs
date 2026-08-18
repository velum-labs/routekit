#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const inventoryFile = path.resolve(
  process.argv[2] ??
    path.join(
      repositoryRoot,
      ".routekit-experiment-assets/composition-20260818/input-inventory.json"
    )
);
const baseUrl = (
  process.env.EXPERIMENT_PLATFORM_URL ?? "https://routekit-experiments-development.vercel.app"
).replace(/\/$/, "");
const token = process.env.EXPERIMENT_PLATFORM_API_TOKEN;
if (!token) throw new Error("EXPERIMENT_PLATFORM_API_TOKEN is not configured");

const inventory = JSON.parse(await readFile(inventoryFile, "utf8"));

async function upload({ file, kind, expectedPathname }) {
  const response = await fetch(`${baseUrl}/api/artifacts`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-artifact-kind": kind,
      "x-artifact-extension": "json"
    },
    body: await readFile(file)
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Upload failed for ${kind} (${response.status}): ${text.slice(0, 1000)}`);
  }
  const result = JSON.parse(text);
  if (result.artifact?.pathname !== expectedPathname) {
    throw new Error(
      `Unexpected artifact path for ${kind}: ${result.artifact?.pathname ?? "(missing)"}`
    );
  }
}

await upload({
  file: inventory.datasetManifestFile,
  kind: `datasets/${inventory.datasetId}`,
  expectedPathname: inventory.datasetManifestPathname
});

for (const task of inventory.tasks) {
  await upload({
    file: task.file,
    kind: `inputs/${inventory.datasetId}/${task.id}`,
    expectedPathname: task.pathname
  });
}

console.log(
  JSON.stringify(
    {
      ok: true,
      inventoryFile,
      datasetId: inventory.datasetId,
      datasetManifest: inventory.datasetManifestPathname,
      uploadedTaskInputs: inventory.tasks.length
    },
    null,
    2
  )
);
