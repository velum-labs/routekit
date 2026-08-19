#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { head, put } from "@vercel/blob";

const inventoryFiles = process.argv.slice(2).map((file) => path.resolve(file));
if (inventoryFiles.length === 0) throw new Error("at least one inventory file is required");
const token = process.env.BLOB_READ_WRITE_TOKEN;
if (!token) throw new Error("BLOB_READ_WRITE_TOKEN is not configured");

async function upload(artifact) {
  let existing;
  try {
    existing = await head(artifact.pathname, { token });
  } catch {}
  if (existing?.size === artifact.size) return { ...artifact, reused: true };
  const result = await put(artifact.pathname, createReadStream(artifact.file), {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: false,
    multipart: artifact.size >= 4 * 1024 * 1024,
    contentType: "application/json",
    token
  });
  if (result.pathname !== artifact.pathname) {
    throw new Error(`unexpected Blob pathname ${result.pathname}`);
  }
  return { ...artifact, reused: false };
}

const artifacts = [];
for (const inventoryFile of inventoryFiles) {
  const inventory = JSON.parse(await readFile(inventoryFile, "utf8"));
  artifacts.push({
    file: inventory.datasetManifestFile,
    pathname: inventory.datasetManifestPathname,
    size: inventory.datasetManifestSize
  });
  artifacts.push(
    ...inventory.tasks.map((task) => ({
      file: task.file,
      pathname: task.pathname,
      size: task.size
    }))
  );
}

let next = 0;
const results = Array.from({ length: artifacts.length });
const workers = Array.from({ length: Math.min(8, artifacts.length) }, async () => {
  while (next < artifacts.length) {
    const index = next++;
    results[index] = await upload(artifacts[index]);
  }
});
await Promise.all(workers);

console.log(
  JSON.stringify(
    {
      ok: true,
      artifacts: results.length,
      uploaded: results.filter((entry) => !entry.reused).length,
      reused: results.filter((entry) => entry.reused).length,
      bytes: results.reduce((sum, entry) => sum + entry.size, 0)
    },
    null,
    2
  )
);
