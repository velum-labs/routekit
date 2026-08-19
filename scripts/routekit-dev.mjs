#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnCorepackPnpmSync } from "./lib/corepack-pnpm.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const cliEntry = resolve(repoRoot, "packages", "cli", "dist", "index.js");

function runBuild() {
  if (process.env.ROUTEKIT_DEV_SKIP_BUILD === "1") return;

  const result = spawnCorepackPnpmSync(["--dir", repoRoot, "run", "build:cli"], {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit"
  });

  if (result.error !== undefined) {
    console.error(`routekit-dev: failed to start build: ${result.error.message}`);
    process.exit(1);
  }
  if (result.signal !== null) {
    console.error(`routekit-dev: build terminated by ${result.signal}`);
    process.exit(1);
  }
  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}

runBuild();

if (!existsSync(cliEntry)) {
  console.error(`routekit-dev: missing built CLI at ${cliEntry}`);
  console.error(
    "routekit-dev: run `corepack pnpm run build:cli` from the RouteKit checkout and try again."
  );
  process.exit(1);
}

const child = spawn(process.execPath, [cliEntry, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit"
});

child.on("error", (error) => {
  console.error(`routekit-dev: failed to launch local CLI: ${error.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal !== null) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
