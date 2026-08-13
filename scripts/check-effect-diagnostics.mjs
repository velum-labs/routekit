#!/usr/bin/env node
/**
 * Run Effect language-service diagnostics without patching TypeScript.
 *
 * `effect-language-service patch` mutates node_modules/typescript. This repo
 * sets ignore-scripts=true, so check invokes the CLI instead of relying on a
 * prepare hook.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const bin = join(process.cwd(), "node_modules", "@effect", "language-service", "cli.js");
if (!existsSync(bin)) {
  console.error("check failed: @effect/language-service is not installed");
  process.exit(1);
}

const result = spawnSync(process.execPath, [bin, "diagnostics", "--project", "tsconfig.json"], {
  encoding: "utf8"
});
if (result.stdout?.trim()) console.log(result.stdout.trim());
if (result.stderr?.trim()) console.error(result.stderr.trim());
if (result.status !== 0) {
  console.error("check failed: Effect language-service diagnostics");
  process.exit(result.status === null ? 1 : result.status);
}
