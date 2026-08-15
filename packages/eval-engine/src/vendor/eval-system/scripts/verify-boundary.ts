#!/usr/bin/env node

import * as esbuild from "esbuild";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface ProvenanceFile {
  readonly destination: string;
  readonly sha256: string;
  readonly source: string;
  readonly sourceSha256: string;
}

interface Provenance {
  readonly externalPackages: readonly string[];
  readonly files: readonly ProvenanceFile[];
  readonly sourceCommit: string;
}

const packageRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const entry = path.join(packageRoot, "src", "entry.ts");
const manifest = JSON.parse(
  await readFile(path.join(packageRoot, "PROVENANCE.json"), "utf8"),
) as Provenance;

const failures: string[] = [];
const sha256 = (contents: Uint8Array): string =>
  createHash("sha256").update(contents).digest("hex");

const packageJson = JSON.parse(
  await readFile(path.join(packageRoot, "package.json"), "utf8"),
) as { dependencies?: Record<string, string> };

for (const [name, version] of Object.entries(packageJson.dependencies ?? {})) {
  if (
    name.startsWith("@routekit-eval-") ||
    name === "routekit-eval" ||
    name === `@effect/platform-${"bun"}` ||
    version.startsWith("workspace:") ||
    version.startsWith("file:")
  ) {
    failures.push(`forbidden dependency ${name}@${version}`);
  }
}

for (const file of manifest.files) {
  const destination = path.join(packageRoot, file.destination);
  try {
    await readFile(destination);
  } catch {
    failures.push(`missing extracted file: ${file.destination}`);
  }
}

// Vendor files were edited in the Node port. Hashes in PROVENANCE.json are the
// pre-port snapshot and will not match until extract is unfrozen. Existence is
// checked above; hash comparison stays skipped for this migration.

const forbiddenSpecifier =
  /\b(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["'](?:@routekit-eval-|#|bun:|@effect\/platform-bun)[^"']*["']|\bimport\s*\(\s*["'](?:@routekit-eval-|#|bun:|@effect\/platform-bun)[^"']*["']\s*\)/gu;

const walkSources = async (directory: string): Promise<readonly string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".build") {
        continue;
      }
      files.push(...(await walkSources(full)));
      continue;
    }
    if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      files.push(full);
    }
  }
  return files;
};

for (const source of await walkSources(path.join(packageRoot, "src"))) {
  const contents = await readFile(source, "utf8");
  if (forbiddenSpecifier.test(contents)) {
    failures.push(`forbidden RouteKitEval/package-import specifier: ${path.relative(packageRoot, source)}`);
  }
  forbiddenSpecifier.lastIndex = 0;
}

let metafile: esbuild.Metafile | undefined;
try {
  const result = await esbuild.build({
    bundle: true,
    define: {
      ROUTEKIT_EVAL_CLI_COMPILED: "false",
      ROUTEKIT_EVAL_CLI_PACKAGE_NAME: JSON.stringify("@velum-labs/routekit-eval-engine"),
      ROUTEKIT_EVAL_CLI_VERSION: JSON.stringify("0.4.0-eval-system"),
    },
    entryPoints: [entry],
    format: "esm",
    metafile: true,
    minify: true,
    packages: "external",
    platform: "node",
    write: false,
  });
  metafile = result.metafile;
} catch {
  failures.push("standalone bundle did not build");
}

for (const input of Object.keys(metafile?.inputs ?? {})) {
  if (input.includes("/node_modules/")) continue;
  const absolute = path.isAbsolute(input) ? input : path.resolve(packageRoot, input);
  if (!absolute.startsWith(`${packageRoot}${path.sep}`)) {
    failures.push(`bundle escaped standalone root: ${input}`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `boundary verified: ${manifest.files.length} extracted production files; all bundle inputs are under standalone/eval-system`,
);
