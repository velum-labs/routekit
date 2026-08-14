#!/usr/bin/env node
/**
 * Run Effect diagnostics from the isolated TypeScript 7 tooling workspace.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const tooling = join(root, "tooling", "tsgo");
const bin = join(tooling, "node_modules", "@effect", "tsgo", "dist", "effect-tsgo.cjs");
if (!existsSync(bin)) {
  console.error("check failed: tooling/tsgo dependencies are not installed");
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  [bin, "diagnostics", "--project", join(root, "tsconfig.json")],
  {
    cwd: tooling,
    encoding: "utf8"
  }
);
if (result.stdout?.trim()) console.log(result.stdout.trim());
if (result.stderr?.trim()) console.error(result.stderr.trim());
if (result.status !== 0) {
  console.error("check failed: Effect tsgo diagnostics");
  process.exit(result.status === null ? 1 : result.status);
}
