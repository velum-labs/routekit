#!/usr/bin/env node
/**
 * Run publint and/or @arethetypeswrong/cli over every publishable workspace package.
 * Usage: node scripts/check-publishable-packages.mjs [--publint] [--attw]
 * Default: both.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = new Set(process.argv.slice(2));
const runPublint = args.size === 0 || args.has("--publint");
const runAttw = args.size === 0 || args.has("--attw");

const publintBin = join(root, "node_modules", "publint", "src", "cli.js");
const attwBin = join(root, "node_modules", "@arethetypeswrong", "cli", "dist", "index.js");

function fail(message) {
  console.error(`check-publishable-packages: ${message}`);
  process.exit(1);
}

const packages = [];
for (const dir of readdirSync(join(root, "packages"))) {
  const packageJsonPath = join(root, "packages", dir, "package.json");
  if (!existsSync(packageJsonPath)) continue;
  const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  if (manifest.private === true) continue;
  packages.push({ dir: join(root, "packages", dir), name: manifest.name });
}

if (packages.length === 0) fail("no publishable packages found");

let failed = 0;
for (const { dir, name } of packages) {
  if (runPublint) {
    const result = spawnSync(process.execPath, [publintBin], {
      cwd: dir,
      encoding: "utf8"
    });
    if (result.stdout?.trim()) console.log(`[publint ${name}]\n${result.stdout.trim()}`);
    if (result.stderr?.trim()) console.error(`[publint ${name}]\n${result.stderr.trim()}`);
    if (result.status !== 0) {
      console.error(`publint failed for ${name}`);
      failed += 1;
    }
  }
  if (runAttw) {
    const result = spawnSync(process.execPath, [attwBin, "--pack", ".", "--profile", "esm-only"], {
      cwd: dir,
      encoding: "utf8"
    });
    if (result.stdout?.trim()) console.log(`[attw ${name}]\n${result.stdout.trim()}`);
    if (result.stderr?.trim()) console.error(`[attw ${name}]\n${result.stderr.trim()}`);
    if (result.status !== 0) {
      console.error(`attw failed for ${name}`);
      failed += 1;
    }
  }
}

if (failed > 0) fail(`${failed} package check(s) failed`);
console.log(
  `publishable package checks passed (${packages.length} packages; publint=${runPublint} attw=${runAttw})`
);
