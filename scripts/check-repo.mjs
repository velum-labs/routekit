import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  canonicalSharedPackageViolations,
  fusionkitCompositionViolations,
  isInternalWorkspaceDependency,
  polynomialTrailingSlashRegexViolations,
  routekitDependencyViolations,
  routekitProductionSources,
  routekitSourceViolations,
  toolRegistryCliSourceViolations,
  toolRegistryCompositionViolations,
  toolRegistryConstructionViolations
} from "./lib/architecture-guards.mjs";

const ROUTEKIT_PACKAGE_DIRS = [
  "accounts",
  "cli",
  "cli-core",
  "cli-ui",
  "config",
  "config-core",
  "contracts",
  "control",
  "daemon",
  "gateway",
  "harness-core",
  "registry",
  "router",
  "runtime",
  "telemetry-core",
  "tool-claude",
  "tool-codex",
  "tool-cursor",
  "tool-opencode",
  "tool-registry",
  "tools",
  "tracing"
];

const requiredFiles = [
  "LICENSE",
  "README.md",
  ".npmrc",
  "package.json",
  "pnpm-workspace.yaml",
  "turbo.json",
  "tsconfig.json",
  "tsconfig.base.json",
  "release/npm-packages.json",
  "packages/cli/package.json",
  "packages/cli/src/index.ts",
  "packages/cli/src/cli.ts",
  "packages/tool-registry/package.json",
  "packages/tool-registry/src/index.ts",
  "packages/registry/src/index.ts",
  "packages/runtime/src/index.ts"
];

for (const dir of ROUTEKIT_PACKAGE_DIRS) {
  requiredFiles.push(`packages/${dir}/package.json`);
  if (dir === "cli") continue;
  requiredFiles.push(`packages/${dir}/src/index.ts`);
}

const fail = (message) => {
  console.error(`check failed: ${message}`);
  process.exitCode = 1;
};

for (const file of requiredFiles) {
  if (!existsSync(file)) fail(`missing ${file}`);
}

function runOptionalCheck(scriptPath, label, args = ["--check"], requiredInputs = []) {
  if (!existsSync(scriptPath)) return;
  if (requiredInputs.some((input) => !existsSync(input))) return;
  const result = spawnSync(process.execPath, [scriptPath, ...args], { encoding: "utf8" });
  if (result.stdout?.trim()) console.log(result.stdout.trim());
  if (result.stderr?.trim()) console.error(result.stderr.trim());
  if (result.status !== 0) fail(`${label} check failed`);
}

const registrySpecInputs = [
  "spec/registry/providers.json",
  "spec/registry/subscriptions.json",
  "spec/registry/connectors.json",
  "spec/registry/model-catalog.json",
  "spec/registry/model-capabilities.json",
  "spec/registry/pricing.json",
  "spec/registry/local-catalog.json"
];
runOptionalCheck(
  "scripts/generate-registry.mjs",
  "registry bindings",
  ["--check"],
  registrySpecInputs
);
runOptionalCheck("scripts/generate-pricing.mjs", "pricing", ["--check"], [
  "spec/registry/pricing.json"
]);
runOptionalCheck("scripts/generate-local-catalog.mjs", "local catalog", ["--check"], [
  "spec/registry/local-catalog.json"
]);
runOptionalCheck("scripts/generate-routekit-l06-evidence.mjs", "RouteKit L06 evidence");

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
if (pkg.private !== true) fail("package.json must remain private");
if (!/^pnpm@\d+\.\d+\.\d+$/.test(pkg.packageManager ?? "")) {
  fail("packageManager must pin a concrete pnpm version");
}
if (pkg.scripts?.check !== "node scripts/check-repo.mjs") {
  fail("check script must run scripts/check-repo.mjs");
}

const npmrc = readFileSync(".npmrc", "utf8");
for (const setting of [
  "engine-strict=true",
  "package-manager-strict=true",
  "strict-peer-dependencies=true",
  "ignore-scripts=true",
  "verify-store-integrity=true",
  "minimum-release-age-exclude[]=@velum-labs/model-fusion-protocol"
]) {
  if (!npmrc.includes(setting)) fail(`.npmrc missing ${setting}`);
}

// Third-party dependencies are allowed only as exact-pinned, allowlisted versions.
const TRUSTED_THIRD_PARTY = new Map([
  ["@anthropic-ai/claude-agent-sdk", "0.3.198"],
  ["@openai/codex-sdk", "0.145.0"],
  ["@opencode-ai/sdk", "1.17.13"],
  ["@opentelemetry/api", "1.9.1"],
  ["@opentelemetry/api-logs", "0.220.0"],
  ["@opentelemetry/exporter-logs-otlp-http", "0.220.0"],
  ["@opentelemetry/exporter-trace-otlp-http", "0.220.0"],
  ["@opentelemetry/resources", "2.9.0"],
  ["@opentelemetry/sdk-logs", "0.220.0"],
  ["@opentelemetry/sdk-trace-base", "2.9.0"],
  ["@opentelemetry/sdk-trace-node", "2.9.0"],
  ["@types/figlet", "1.7.0"],
  ["@types/node", "22.19.20"],
  ["@types/react", "19.2.17"],
  ["@zed-industries/agent-client-protocol", "0.4.5"],
  ["commander", "14.0.3"],
  ["figlet", "1.11.0"],
  ["ink", "7.1.0"],
  ["ink-testing-library", "4.0.0"],
  ["portless", "0.15.1"],
  ["react", "19.2.7"],
  ["smol-toml", "1.7.0"],
  ["string-width", "8.2.1"],
  ["turbo", "2.10.5"],
  ["typescript", "6.0.3"],
  ["yaml", "2.9.0"],
  ["zod", "4.4.3"]
]);

function checkDeps(manifestPath, manifest, trustedDependencies = TRUSTED_THIRD_PARTY) {
  for (const [section, deps] of [
    ["dependencies", manifest.dependencies ?? {}],
    ["devDependencies", manifest.devDependencies ?? {}],
    ["optionalDependencies", manifest.optionalDependencies ?? {}]
  ]) {
    for (const [name, version] of Object.entries(deps)) {
      if (isInternalWorkspaceDependency(name)) {
        if (version !== "workspace:*") {
          fail(`${manifestPath} ${section} "${name}": internal packages must use workspace:*`);
        }
        continue;
      }
      const trusted = trustedDependencies.get(name);
      if (trusted === undefined) {
        fail(
          `${manifestPath} ${section} "${name}": not on the trusted dependency allowlist in scripts/check-repo.mjs`
        );
      } else if (version !== trusted) {
        fail(
          `${manifestPath} ${section} "${name}": version "${version}" must be the exact trusted pin "${trusted}"`
        );
      }
    }
  }
}

checkDeps("package.json", pkg);

const releaseManifest = JSON.parse(readFileSync("release/npm-packages.json", "utf8"));
const publishableWorkspaceDirs = new Set(
  (releaseManifest.packages ?? []).map((entry) => entry.path)
);

if (releaseManifest.canonicalRepository !== "velum-labs/routekit") {
  fail("release/npm-packages.json canonicalRepository must be velum-labs/routekit");
}

const workspaceDirs = readdirSync("packages").map((dir) => join("packages", dir));
const workspaceManifests = [];
for (const dir of workspaceDirs) {
  if (!statSync(dir).isDirectory()) continue;
  const trackedPackageJson = spawnSync("git", ["ls-files", join(dir, "package.json")], {
    encoding: "utf8"
  });
  // Publishable packages may be untracked during early bootstrap; anything else
  // under packages/ without a tracked package.json is treated as build debris.
  if (
    trackedPackageJson.status !== 0 ||
    (!trackedPackageJson.stdout.trim() && !publishableWorkspaceDirs.has(dir))
  ) {
    fail(`stale build debris in ${dir} — git clean it (no tracked package.json)`);
  }
}
for (const dir of workspaceDirs) {
  const manifestPath = join(dir, "package.json");
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (publishableWorkspaceDirs.has(dir)) {
    if (manifest.private !== false) {
      fail(`${manifestPath} must set private:false because it is in release/npm-packages.json`);
    }
  } else if (manifest.private !== true) {
    fail(`${manifestPath} must remain private`);
  }
  if (existsSync(join(dir, "src", "test")) && manifest.scripts?.test === undefined) {
    fail(`${manifestPath} has src/test/ but no "test" script — its tests would never run`);
  }
  checkDeps(manifestPath, manifest);
  workspaceManifests.push({ manifestPath, manifest, dir });
}

for (const violation of routekitDependencyViolations(workspaceManifests)) {
  fail(
    `${violation.manifestPath} RouteKit dependency reaches FusionKit: ` +
      violation.dependencyPath.join(" -> ")
  );
}
for (const violation of canonicalSharedPackageViolations(workspaceManifests)) {
  fail(`canonical shared package violation: ${violation}`);
}
for (const violation of fusionkitCompositionViolations(workspaceManifests)) {
  fail(`FusionKit composition violation: ${violation}`);
}
for (const violation of toolRegistryCompositionViolations(workspaceManifests)) {
  fail(`tool registry composition violation: ${violation}`);
}

const consumerName = "@velum-labs/routekit";
const consumer = workspaceManifests.find(({ manifest }) => manifest.name === consumerName);
const consumerSources =
  consumer !== undefined && existsSync(join(consumer.dir, "src"))
    ? routekitProductionSources(consumer.dir)
    : [];
for (const violation of toolRegistryCliSourceViolations(consumerName, consumerSources)) {
  fail(`tool registry consumer violation: ${violation}`);
}

const productionSources = workspaceManifests.flatMap(({ dir }) =>
  existsSync(join(dir, "src")) ? routekitProductionSources(dir) : []
);
for (const violation of toolRegistryConstructionViolations(productionSources)) {
  fail(`tool registry construction violation: ${violation}`);
}
for (const { file, source } of productionSources) {
  for (const violation of polynomialTrailingSlashRegexViolations(file, source)) {
    fail(`unsafe trailing-slash normalization: ${violation}`);
  }
}

for (const file of [
  "packages/tool-registry/package.json",
  "packages/tool-registry/src/index.ts"
]) {
  if (!existsSync(file)) continue;
  if (/(?:@fusionkit\/|\b(?:fusionkit|fusion|fused)\b)/i.test(readFileSync(file, "utf8"))) {
    fail(`${file} must not contain FusionKit dependencies or vocabulary`);
  }
}

for (const wrapper of [
  "packages/tools/src/proc.ts",
  "packages/tools/src/env.ts",
  "packages/cli/src/shared/proc.ts",
  "packages/cli/src/shared/context.ts",
  "packages/cli/src/shared/errors.ts",
  "packages/cli/src/shared/flag-suggest.ts",
  "packages/cli/src/shared/pickers.ts",
  "packages/cli/src/shared/package-version.ts"
]) {
  if (existsSync(wrapper)) fail(`forbidden local shared-core wrapper: ${wrapper}`);
}

for (const legacyHarness of [
  "packages/tool-codex/src/harness.ts",
  "packages/tool-claude/src/harness.ts",
  "packages/tool-cursor/src/harness.ts",
  "packages/tool-opencode/src/harness.ts",
  "packages/tool-claude/src/stream-trajectory.ts",
  "packages/tool-cursor/src/stream-trajectory.ts"
]) {
  if (existsSync(legacyHarness)) fail(`forbidden parallel harness implementation: ${legacyHarness}`);
}

const retiredToolNames = new RegExp(
  `@fusionkit/(?:tools|harness-core|tool-(?:codex|claude|cursor|opencode))|` +
    `FUSIONKIT_${"HARNESS"}_${"DRIVERS"}`
);
for (const { manifestPath, manifest } of workspaceManifests) {
  if (retiredToolNames.test(JSON.stringify(manifest))) {
    fail(`${manifestPath} references a retired tool package or cutover flag`);
  }
}

for (const { manifest, dir } of workspaceManifests) {
  if (!manifest.name?.startsWith("@velum-labs/routekit") || !existsSync(join(dir, "src"))) continue;
  for (const { file, source } of routekitProductionSources(dir)) {
    for (const violation of routekitSourceViolations(file, source)) {
      fail(`${file}: RouteKit architecture violation: ${violation}`);
    }
  }
}

const todoMarker = new RegExp(`TODO${"\\("}(hardcoded|brittle|lib)${"\\)"}`);
const sourceListing = spawnSync(
  "git",
  ["ls-files", "*.ts", "*.mjs", "*.js", "*.yml", "*.yaml", "*.md"],
  { encoding: "utf8" }
);
if (sourceListing.status === 0) {
  for (const file of sourceListing.stdout.split("\n").filter((l) => l.length > 0)) {
    if (file === "scripts/check-repo.mjs") continue;
    if (!existsSync(file)) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (todoMarker.test(lines[i])) {
        fail(`deferred-work marker in ${file}:${i + 1} — fix it or document the decision`);
      }
    }
  }
}

const noConsoleListing = spawnSync(
  "git",
  [
    "ls-files",
    "packages/cli/src/**/*.ts",
    "packages/cli-core/src/**/*.ts",
    "packages/cli-ui/src/**/*.ts",
    "packages/cli-ui/src/**/*.tsx"
  ],
  { encoding: "utf8" }
);
if (noConsoleListing.status === 0) {
  const consolePattern = /\bconsole\.(log|error|warn|info|debug|trace)\(/;
  for (const file of noConsoleListing.stdout.split("\n").filter((line) => line.length > 0)) {
    if (file.includes("/test/")) continue;
    if (!existsSync(file)) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (consolePattern.test(lines[i])) {
        fail(
          `raw console output in ${file}:${i + 1} — render through the @velum-labs/routekit-cli-ui presenter instead`
        );
      }
    }
  }
}

const envSpreadListing = spawnSync("git", ["ls-files", "packages/*/src/**/*.ts"], {
  encoding: "utf8"
});
if (envSpreadListing.status === 0) {
  const envSpreadPattern = /\.\.\.process\.env\b/;
  const waiverPattern = /env-spread-allowed:\s*\S/;
  for (const file of envSpreadListing.stdout.split("\n").filter((line) => line.length > 0)) {
    if (file.startsWith("packages/runtime/")) continue;
    if (file.includes("/test/")) continue;
    if (!existsSync(file)) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (envSpreadPattern.test(lines[i]) && !waiverPattern.test(lines[i - 1] ?? "")) {
        fail(
          `full parent env spread in ${file}:${i + 1} — build the child env with buildChildEnv (@velum-labs/routekit-runtime), ` +
            `or add an "env-spread-allowed: <reason>" comment for a trusted infra child`
        );
      }
    }
  }
}

const trackedEnvFiles = spawnSync("git", ["ls-files", ".env", ".env.*", "**/.env", "**/.env.*"], {
  encoding: "utf8"
});
if (trackedEnvFiles.status === 0) {
  for (const file of trackedEnvFiles.stdout.split("\n").filter((line) => line.length > 0)) {
    if (file.endsWith(".example")) continue;
    fail(`secrets file is tracked in git: ${file}`);
  }
}

const tracked = spawnSync("git", ["ls-files", "*.tsbuildinfo", "**/dist/**"], {
  encoding: "utf8"
});
if (tracked.status === 0) {
  for (const file of tracked.stdout.split("\n").filter((line) => line.length > 0)) {
    fail(`build artifact is tracked in git: ${file}`);
  }
}

if (process.exitCode) process.exit(process.exitCode);
console.log("repo check passed");
