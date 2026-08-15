import { createHash } from "node:crypto";
import { glob, readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import process from "node:process";

const packageRoot = resolve(import.meta.dirname, "..");
const sourceRoot = process.env.ROUTEKIT_EVAL_UPSTREAM_SOURCE;
const files = [];

const upstreamPathFor = (destination) => {
  if (destination === "assets/sdk/eval.js") {
    return "src/vendor/framework/cli/src/commands/init/author-contracts-artifacts/eval.js.txt";
  }
  if (destination === "assets/sdk/eval.ts") {
    return "src/vendor/framework/cli/src/commands/init/author-contracts-artifacts/eval.ts.txt";
  }
  return destination
    .replace(/^src\/vendor\/eval-system\//, "src/")
    .replace(/^assets\/skills\//, "skills/")
    .replace(/^test\/standalone\//, "test/")
    .replace(/^docs\/upstream-adaptation\/EXTRACTION\.md$/, "EXTRACTION.md")
    .replace(/^docs\/upstream-adaptation\/FEATURE_COMPLETENESS\.md$/, "FEATURE_COMPLETENESS.md")
    .replace(/^docs\/upstream-adaptation\/HOST\.md$/, "HOST.md")
    .replace(/^docs\/upstream-adaptation\/STANDALONE_README\.md$/, "README.md")
    .replaceAll("spawn-routekit-eval", "spawn-ori-eval")
    .replaceAll("routekit-eval", "ori")
    .replaceAll("gateway", "openrouter");
};

for await (const path of glob(
  [
    "src/vendor/eval-system/**/*",
    "assets/**/*",
    "test/standalone/**/*",
    "docs/upstream-adaptation/**/*"
  ],
  { cwd: packageRoot }
)) {
  const full = resolve(packageRoot, path);
  let contents;
  try {
    contents = await readFile(full);
  } catch {
    continue;
  }
  const entry = { destination: path, sha256: createHash("sha256").update(contents).digest("hex") };
  if (sourceRoot) {
    const source = upstreamPathFor(path);
    entry.source = source;
    try {
      const sourceContents = await readFile(resolve(sourceRoot, source));
      entry.sourceSha256 = createHash("sha256").update(sourceContents).digest("hex");
    } catch {
      throw new Error(`${path}: could not map vendored file to upstream source ${source}`);
    }
  }
  files.push(entry);
}
files.sort((a, b) => a.destination.localeCompare(b.destination));
const manifest = {
  adaptation:
    "Complete standalone source distribution vendored into the RouteKit workspace, white-labeled, and integrated behind Effect-native library services.",
  sourceCommit: "45c1bb03b9d74b2d0d7a75fb1faf1a39e855c431",
  sourceDistributionCommit: "ad7923006050c01e180c18a3d05928dc56071b98",
  files
};
await writeFile(
  resolve(packageRoot, "UPSTREAM_PROVENANCE.json"),
  `${JSON.stringify(manifest, null, 2)}\n`
);
console.log(
  `wrote ${relative(process.cwd(), resolve(packageRoot, "UPSTREAM_PROVENANCE.json"))} (${files.length} files)`
);
