#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { head, put } from "@vercel/blob";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const inventoryFile = path.resolve(
  process.argv[2] ??
    path.join(
      repositoryRoot,
      ".routekit-experiment-assets/area-taxonomy-20260818/input-inventory.json"
    )
);
const token = process.env.BLOB_READ_WRITE_TOKEN;
if (!token) throw new Error("BLOB_READ_WRITE_TOKEN is not configured");
const inventory = JSON.parse(await readFile(inventoryFile, "utf8"));

async function upload(artifact, contentType, multipart = false) {
  let existing;
  try {
    existing = await head(artifact.pathname, { token });
  } catch {}
  if (existing?.size === artifact.size) {
    return { pathname: artifact.pathname, size: artifact.size, reused: true };
  }
  const result = await put(artifact.pathname, createReadStream(artifact.file), {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: false,
    multipart,
    contentType,
    token
  });
  if (result.pathname !== artifact.pathname) {
    throw new Error(`unexpected Blob pathname ${result.pathname}`);
  }
  return { pathname: result.pathname, size: artifact.size, reused: false };
}

const artifacts = [
  {
    file: inventory.datasetManifestFile,
    pathname: inventory.datasetManifestPathname,
    size: inventory.datasetManifestSize,
    contentType: "application/json"
  },
  {
    file: inventory.validationBundleFile,
    pathname: inventory.validationBundlePathname,
    size: inventory.validationBundleSize,
    contentType: "application/json",
    multipart: true
  },
  {
    file: inventory.validatorFile,
    pathname: inventory.validatorPathname,
    size: inventory.validatorSize,
    contentType: "text/javascript"
  },
  ...inventory.tasks.map((task) => ({
    file: task.file,
    pathname: task.pathname,
    size: task.size,
    contentType: "application/json",
    multipart: task.size >= 4 * 1024 * 1024
  }))
];

let next = 0;
const uploaded = [];
const workers = Array.from({ length: 4 }, async () => {
  while (next < artifacts.length) {
    const index = next;
    next += 1;
    const artifact = artifacts[index];
    if (!artifact) return;
    uploaded[index] = await upload(artifact, artifact.contentType, artifact.multipart);
  }
});
await Promise.all(workers);

console.log(
  JSON.stringify(
    {
      ok: true,
      inventoryFile,
      artifacts: uploaded.length,
      uploaded: uploaded.filter((entry) => !entry.reused).length,
      reused: uploaded.filter((entry) => entry.reused).length,
      bytes: uploaded.reduce((sum, entry) => sum + entry.size, 0)
    },
    null,
    2
  )
);
