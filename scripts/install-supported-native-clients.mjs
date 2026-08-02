#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadLaunchToolIds,
  loadSupportedClients,
  nativeClientInstallationPlan,
  observedVersionMatches,
  validateSupportedClients
} from "./lib/routekit-client-support.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const printOnly = args.includes("--print") || args.includes("--dry-run");
if (args.some((arg) => !["--print", "--dry-run"].includes(arg))) {
  throw new Error("usage: install-supported-native-clients.mjs [--print|--dry-run]");
}

const manifest = validateSupportedClients(
  loadSupportedClients(ROOT),
  loadLaunchToolIds(ROOT)
);
const plan = nativeClientInstallationPlan(manifest);
if (printOnly) {
  console.log(JSON.stringify(plan, null, 2));
  process.exit(0);
}

const installArgs = [
  "install",
  "--global",
  "--ignore-scripts=false",
  ...plan.allowScripts.map((name) => `--allow-scripts=${name}`),
  ...plan.packages
];
const install = spawnSync("npm", installArgs, { stdio: "inherit" });
if (install.status !== 0) process.exit(install.status ?? 1);

for (const client of plan.clients) {
  const result = spawnSync(client.binary, ["--version"], { encoding: "utf8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.status !== 0) {
    console.error(`${client.binary} --version failed`);
    process.exit(result.status ?? 1);
  }
  console.log(output);
  if (!observedVersionMatches(client, output)) {
    console.error(
      `${client.id} version mismatch: expected ${client.version}, observed ${JSON.stringify(output)}`
    );
    process.exit(1);
  }
}
