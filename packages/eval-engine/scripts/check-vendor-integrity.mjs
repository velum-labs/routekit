import { createHash } from "node:crypto";
import { glob, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(await readFile(resolve(root, "UPSTREAM_PROVENANCE.json"), "utf8"));
const expected = new Set();
for await (const path of glob(
  [
    "LICENSE",
    "src/vendor/eval-system/**/*",
    "assets/**/*",
    "test/standalone/**/*",
    "docs/upstream-adaptation/**/*"
  ],
  { cwd: root }
)) {
  try {
    await readFile(resolve(root, path));
    expected.add(path);
  } catch {}
}
const recorded = new Set();
for (const entry of manifest.files) {
  if (recorded.has(entry.destination)) {
    throw new Error(`${entry.destination}: duplicate provenance entry`);
  }
  recorded.add(entry.destination);
  if (!expected.has(entry.destination)) {
    throw new Error(`${entry.destination}: provenance records a missing or excluded file`);
  }
  const actual = createHash("sha256")
    .update(await readFile(resolve(root, entry.destination)))
    .digest("hex");
  if (actual !== entry.sha256)
    throw new Error(`${entry.destination}: expected ${entry.sha256}, got ${actual}`);
  if (typeof entry.source !== "string" || typeof entry.sourceSha256 !== "string") {
    throw new Error(`${entry.destination}: incomplete source mapping`);
  }
}
for (const path of expected) {
  if (!recorded.has(path)) {
    throw new Error(`${path}: vendored file is missing from provenance`);
  }
}
const coveredSources = new Set(manifest.files.map((entry) => entry.source));
for (const entry of manifest.adaptedSourceFiles ?? []) {
  if (
    typeof entry.source !== "string" ||
    typeof entry.sourceSha256 !== "string" ||
    typeof entry.destination !== "string" ||
    typeof entry.sha256 !== "string" ||
    typeof entry.reason !== "string"
  ) {
    throw new Error("incomplete adapted source-file classification");
  }
  const actual = createHash("sha256")
    .update(await readFile(resolve(root, entry.destination)))
    .digest("hex");
  if (actual !== entry.sha256) {
    throw new Error(`${entry.destination}: expected adapted hash ${entry.sha256}, got ${actual}`);
  }
  coveredSources.add(entry.source);
}
for (const entry of manifest.excludedSourceFiles ?? []) {
  if (
    typeof entry.source !== "string" ||
    typeof entry.sourceSha256 !== "string" ||
    typeof entry.reason !== "string"
  ) {
    throw new Error("incomplete excluded source-file classification");
  }
  coveredSources.add(entry.source);
}
if (coveredSources.size !== manifest.sourceTrackedFileCount) {
  throw new Error(
    `source distribution coverage mismatch: ${coveredSources.size}/${manifest.sourceTrackedFileCount}`
  );
}
console.log(
  `vendored source integrity verified (${manifest.files.length} adapted destinations; ${coveredSources.size} upstream files classified)`
);
