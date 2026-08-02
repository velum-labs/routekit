#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadLaunchToolIds,
  loadSupportedClients,
  renderSupportedClients,
  validateSupportedClients
} from "./lib/routekit-client-support.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputs = [
  {
    path: join(ROOT, "docs", "routekit-supported-clients.md"),
    content: (manifest) => renderSupportedClients(manifest)
  },
  {
    path: join(ROOT, "apps", "docs", "content", "docs", "reference", "client-compatibility.mdx"),
    content: (manifest) => renderSupportedClients(manifest, { publicDocs: true })
  }
];

const check = process.argv.slice(2).includes("--check");
if (process.argv.slice(2).some((arg) => arg !== "--check")) {
  throw new Error("usage: generate-routekit-client-support.mjs [--check]");
}

const manifest = validateSupportedClients(
  loadSupportedClients(ROOT),
  loadLaunchToolIds(ROOT)
);

for (const output of outputs) {
  const content = output.content(manifest);
  if (check) {
    if (!existsSync(output.path) || readFileSync(output.path, "utf8") !== content) {
      console.error(
        `${output.path.slice(ROOT.length + 1)} is stale; run node scripts/generate-routekit-client-support.mjs`
      );
      process.exitCode = 1;
    }
  } else {
    writeFileSync(output.path, content);
  }
}
