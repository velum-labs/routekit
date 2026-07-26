/**
 * Generate the RouteKit registry bindings from spec/registry/*.json.
 *
 * The JSON files under spec/registry/ are the single source of truth for
 * provider metadata (base URLs, key env vars, probes, discovery), subscription
 * auth metadata (Claude Code / Codex), cloud/local model catalogs,
 * model-family capability quirks, and default pricing. This script writes only
 * the neutral RouteKit binding:
 *
 *   - packages/registry/src/generated/data.ts (@velum-labs/routekit-registry)
 *
 * Run `node scripts/generate-registry.mjs` after editing any spec/registry
 * file; `--check` verifies the generated file is current (used by pnpm check).
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

const NEUTRAL_SPEC_FILES = [
  ["providers", "spec/registry/providers.json"],
  ["subscriptions", "spec/registry/subscriptions.json"],
  ["connectors", "spec/registry/connectors.json"],
  ["modelCatalog", "spec/registry/model-catalog.json"],
  ["modelCapabilities", "spec/registry/model-capabilities.json"],
  ["pricing", "spec/registry/pricing.json"],
  ["localCatalog", "spec/registry/local-catalog.json"]
];

const TARGETS = [
  {
    files: NEUTRAL_SPEC_FILES,
    exportName: "REGISTRY",
    ts: "packages/registry/src/generated/data.ts"
  }
];

const checkMode = process.argv.includes("--check");

function loadRegistry(specFiles) {
  const registry = {};
  for (const [key, path] of specFiles) {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const section = parsed[key];
    if (section === undefined) {
      throw new Error(`${path} must carry its data under the "${key}" key`);
    }
    registry[key] = section;
  }
  return registry;
}

const HEADER_NOTE =
  "GENERATED FILE - DO NOT EDIT. Source of truth: spec/registry/*.json. " +
  "Regenerate with `node scripts/generate-registry.mjs`.";

function renderTs(registry, exportName) {
  const body = JSON.stringify(registry, null, 2);
  return `// ${HEADER_NOTE}\n\nexport const ${exportName} = ${body};\n`;
}

function apply(path, content) {
  if (checkMode) {
    if (!existsSync(path)) {
      console.error(`registry check failed: missing generated file ${path}`);
      process.exitCode = 1;
      return;
    }
    const current = readFileSync(path, "utf8");
    if (current !== content) {
      console.error(
        `registry check failed: ${path} is stale; run \`node scripts/generate-registry.mjs\``
      );
      process.exitCode = 1;
    }
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  console.log(`wrote ${path}`);
}

for (const target of TARGETS) {
  const registry = loadRegistry(target.files);
  apply(target.ts, renderTs(registry, target.exportName));
}

if (checkMode && process.exitCode === undefined) {
  console.log("registry check passed");
}
