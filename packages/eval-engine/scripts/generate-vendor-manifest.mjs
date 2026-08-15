import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { glob, readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import process from "node:process";

const packageRoot = resolve(import.meta.dirname, "..");
const sourceRoot = process.env.ROUTEKIT_EVAL_UPSTREAM_SOURCE;
const files = [];
if (!sourceRoot) {
  throw new Error(
    "ROUTEKIT_EVAL_UPSTREAM_SOURCE must point to the standalone source distribution"
  );
}

const upstreamPathFor = (destination) => {
  if (destination === "LICENSE") {
    return "LICENSE";
  }
  if (destination === "assets/sdk/eval.js") {
    return "src/vendor/framework/cli/src/commands/init/author-contracts-artifacts/eval.js.txt";
  }
  if (destination === "assets/sdk/eval.ts") {
    return "src/vendor/framework/cli/src/commands/init/author-contracts-artifacts/eval.ts.txt";
  }
  if (destination === "docs/upstream-adaptation/EXTRACTED_CLOSURE_PROVENANCE.json") {
    return "PROVENANCE.json";
  }
  if (destination.startsWith("src/vendor/eval-system/scripts/")) {
    return destination.replace(/^src\/vendor\/eval-system\//, "");
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
    "LICENSE",
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

const adaptedSourceFiles = [
  {
    destination: "package.json",
    reason:
      "Converted into the RouteKit pnpm workspace manifest; the standalone bin, npm scripts, literal dependency versions, and package boundary are intentionally not retained.",
    source: "package.json"
  },
  {
    destination: "tsconfig.json",
    reason:
      "Converted to RouteKit's shared TypeScript configuration and build conventions instead of retaining a nested standalone compiler boundary.",
    source: "tsconfig.json"
  }
];
const excludedSourceFiles = [
  {
    reason: "Repository-local ignore metadata is superseded by the RouteKit repository ignore policy.",
    source: ".gitignore"
  },
  {
    reason:
      "Package-manager artifact explicitly excluded; RouteKit uses its root pnpm lockfile and does not retain a nested package-lock-driven build.",
    source: "package-lock.json"
  }
];

const tracked = execFileSync("git", ["-C", sourceRoot, "ls-files"], {
  encoding: "utf8"
})
  .trim()
  .split("\n")
  .filter(Boolean)
  .sort();
const sourceTrackedFileCount = tracked.length;
const covered = new Set([
  ...files.map((entry) => entry.source),
  ...adaptedSourceFiles.map((entry) => entry.source),
  ...excludedSourceFiles.map((entry) => entry.source)
]);
const missing = tracked.filter((path) => !covered.has(path));
const unknown = [...covered].filter((path) => !tracked.includes(path));
if (missing.length > 0 || unknown.length > 0) {
  throw new Error(
    [
      missing.length > 0 ? `unclassified upstream files:\n${missing.join("\n")}` : "",
      unknown.length > 0 ? `classifications not present upstream:\n${unknown.join("\n")}` : ""
    ]
      .filter(Boolean)
      .join("\n")
  );
}
for (const entry of [...adaptedSourceFiles, ...excludedSourceFiles]) {
  const contents = await readFile(resolve(sourceRoot, entry.source));
  entry.sourceSha256 = createHash("sha256").update(contents).digest("hex");
}
for (const entry of adaptedSourceFiles) {
  const contents = await readFile(resolve(packageRoot, entry.destination));
  entry.sha256 = createHash("sha256").update(contents).digest("hex");
}

const manifest = {
  adaptation:
    "Complete standalone source distribution vendored into the RouteKit workspace, white-labeled, and integrated behind Effect-native library services.",
  sourceCommit: "45c1bb03b9d74b2d0d7a75fb1faf1a39e855c431",
  sourceDistributionCommit: "ad7923006050c01e180c18a3d05928dc56071b98",
  sourceTrackedFileCount,
  adaptedSourceFiles,
  excludedSourceFiles,
  files
};
await writeFile(
  resolve(packageRoot, "UPSTREAM_PROVENANCE.json"),
  `${JSON.stringify(manifest, null, 2)}\n`
);
console.log(
  `wrote ${relative(process.cwd(), resolve(packageRoot, "UPSTREAM_PROVENANCE.json"))} (${files.length} files)`
);
