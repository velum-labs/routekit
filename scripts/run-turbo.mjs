#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createCorepackPnpmEnvironment } from "./lib/corepack-pnpm.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, "..");
const turboCommand = process.platform === "win32" ? "turbo.cmd" : "turbo";
const pinned = createCorepackPnpmEnvironment(process.env);

let result;
try {
  result = spawnSync(turboCommand, process.argv.slice(2), {
    cwd: repoRoot,
    env: pinned.environment,
    stdio: "inherit"
  });
} finally {
  pinned.dispose();
}

if (result.error !== undefined) {
  console.error(`RouteKit Turbo runner failed to start: ${result.error.message}`);
  process.exit(1);
}
if (result.signal !== null) {
  process.kill(process.pid, result.signal);
} else {
  process.exit(result.status ?? 1);
}
