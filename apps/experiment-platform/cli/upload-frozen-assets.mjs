#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { head, put } from "@vercel/blob";

const argv = process.argv.slice(2);
const inventoryFile = path.resolve(
  argv[0] ?? ".routekit-experiment-assets/coding-router-20260817/artifact-inventory.json"
);
const token = process.env.BLOB_READ_WRITE_TOKEN;
if (!token) throw new Error("BLOB_READ_WRITE_TOKEN is not configured");
const inventory = JSON.parse(await readFile(inventoryFile, "utf8"));
const uploaded = [];
for (const artifact of inventory.artifacts) {
  let existing;
  try {
    existing = await head(artifact.pathname, { token });
  } catch {}
  if (existing?.size === artifact.size) {
    uploaded.push({ pathname: artifact.pathname, size: artifact.size, reused: true });
    continue;
  }
  const result = await put(artifact.pathname, createReadStream(artifact.file), {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: false,
    multipart: true,
    contentType: "application/zstd",
    token
  });
  uploaded.push({ pathname: result.pathname, size: artifact.size, reused: false });
}
console.log(JSON.stringify({ ok: true, inventoryFile, uploaded }, null, 2));
