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
const evalEngineTypes = join(root, "packages", "eval-engine", "dist", "index.d.ts");
if (!existsSync(evalEngineTypes)) {
  const packageManager = process.env.npm_execpath;
  if (packageManager === undefined) {
    console.error("check failed: cannot build eval-engine declarations without npm_execpath");
    process.exit(1);
  }
  const clean = spawnSync(
    process.execPath,
    [packageManager, "--filter", "@velum-labs/routekit-eval-engine...", "run", "clean"],
    {
      cwd: root,
      encoding: "utf8"
    }
  );
  if (clean.stdout?.trim()) console.log(clean.stdout.trim());
  if (clean.stderr?.trim()) console.error(clean.stderr.trim());
  if (clean.status !== 0) {
    console.error("check failed: clean eval-engine declaration dependencies");
    process.exit(clean.status === null ? 1 : clean.status);
  }
  const build = spawnSync(
    process.execPath,
    [packageManager, "--filter", "@velum-labs/routekit-eval-engine...", "run", "build"],
    {
      cwd: root,
      encoding: "utf8"
    }
  );
  if (build.stdout?.trim()) console.log(build.stdout.trim());
  if (build.stderr?.trim()) console.error(build.stderr.trim());
  if (build.status !== 0) {
    console.error("check failed: eval-engine public declarations");
    process.exit(build.status === null ? 1 : build.status);
  }
}
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
