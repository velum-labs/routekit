#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const packagesDirectory = new URL("../packages/", import.meta.url);
const reportsDirectory = new URL("../api-reports/", import.meta.url);
const check = process.argv.includes("--check");

function declarationFor(directory, target) {
  const typesTarget =
    typeof target === "object" &&
    target !== null &&
    !Array.isArray(target) &&
    typeof target.types === "string"
      ? target.types
      : undefined;
  if (typesTarget === undefined) {
    throw new Error(`${directory} export must declare a types target`);
  }
  return new URL(`../packages/${directory}/${typesTarget.replace(/^\.\//, "")}`, import.meta.url);
}

const packages = readdirSync(packagesDirectory)
  .flatMap((directory) => {
    const packagePath = new URL(`../packages/${directory}/package.json`, import.meta.url);
    if (!existsSync(packagePath)) return [];
    const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
    if (manifest.private !== false) return [];
    return Object.entries(manifest.exports ?? {}).map(([subpath, target]) => ({
      directory,
      name: manifest.name,
      subpath,
      declaration: declarationFor(directory, target)
    }));
  })
  .sort(
    (left, right) =>
      left.name.localeCompare(right.name) || left.subpath.localeCompare(right.subpath)
  );

function reportPath({ directory, subpath }) {
  if (subpath === ".") return `${directory}.api.md`;
  const normalized = subpath.replace(/^\.\//, "").replaceAll("/", "-");
  return `${directory}.${normalized}.api.md`;
}

function reportFor({ name, subpath, declaration }) {
  if (!existsSync(declaration)) {
    throw new Error(`missing built declaration for ${name}; run pnpm build first`);
  }
  const source = readFileSync(declaration, "utf8");
  const declarations = source
    .split("\n")
    .filter((line) => /^(?:export|declare)\s/.test(line))
    .map((line) => line.trim())
    .sort();
  const digest = createHash("sha256").update(source).digest("hex");
  return [
    `# ${name}${subpath === "." ? "" : `/${subpath.replace(/^\.\//, "")}`}`,
    "",
    "> Intentional public surface snapshot. This is a review guard, not a stability promise.",
    "",
    `Declaration SHA-256: \`${digest}\``,
    "",
    "## Root declarations",
    "",
    "```ts",
    ...declarations,
    "```",
    ""
  ].join("\n");
}

mkdirSync(reportsDirectory, { recursive: true });
let failed = false;
const expectedReports = new Set(packages.map(reportPath));
for (const entry of packages) {
  const relativePath = reportPath(entry);
  const path = new URL(`../api-reports/${relativePath}`, import.meta.url);
  const expected = reportFor(entry);
  if (check) {
    const actual = existsSync(path) ? readFileSync(path, "utf8") : undefined;
    if (actual !== expected) {
      console.error(`public API report is stale: api-reports/${relativePath}`);
      failed = true;
    }
  } else {
    writeFileSync(path, expected);
  }
}
for (const entry of readdirSync(reportsDirectory)) {
  if (!entry.endsWith(".api.md") || expectedReports.has(entry)) continue;
  if (check) {
    console.error(`public API report is obsolete: api-reports/${entry}`);
    failed = true;
  } else {
    rmSync(new URL(entry, reportsDirectory));
  }
}

if (failed) process.exit(1);
console.log(
  `public API reports ${check ? "verified" : "updated"} (${packages.length} export surfaces)`
);
