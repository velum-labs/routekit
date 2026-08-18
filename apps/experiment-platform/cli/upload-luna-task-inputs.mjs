#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";

const argv = process.argv.slice(2);
const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const inventoryFile = path.resolve(
  argv[0] ??
    path.join(
      repositoryRoot,
      ".routekit-experiment-assets/coding-router-20260817/inputs/input-inventory.json"
    )
);
const baseUrl = (
  process.env.EXPERIMENT_PLATFORM_URL ?? "https://routekit-experiments-development.vercel.app"
).replace(/\/$/, "");
const token = process.env.EXPERIMENT_PLATFORM_API_TOKEN;
if (!token) throw new Error("EXPERIMENT_PLATFORM_API_TOKEN is not configured");

const inventory = JSON.parse(await readFile(inventoryFile, "utf8"));
const uploaded = [];
for (const dataset of inventory.datasets) {
  for (const task of dataset.tasks) {
    const response = await fetch(`${baseUrl}/api/artifacts`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-artifact-kind": `inputs/${dataset.id}/${task.id}`,
        "x-artifact-extension": "json"
      },
      body: await readFile(task.file)
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Upload failed for ${task.id} (${response.status}): ${text.slice(0, 1000)}`);
    }
    const result = JSON.parse(text);
    if (result.artifact?.pathname !== task.pathname) {
      throw new Error(
        `Unexpected artifact path for ${task.id}: ${result.artifact?.pathname ?? "(missing)"}`
      );
    }
    uploaded.push({
      datasetId: dataset.id,
      taskId: task.id,
      pathname: task.pathname,
      size: task.size
    });
  }
}

console.log(
  JSON.stringify(
    {
      ok: true,
      inventoryFile,
      uploaded: uploaded.length,
      datasets: Object.fromEntries(
        inventory.datasets.map((dataset) => [
          dataset.id,
          uploaded.filter((item) => item.datasetId === dataset.id).length
        ])
      )
    },
    null,
    2
  )
);
