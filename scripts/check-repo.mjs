import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  canonicalSharedPackageViolations,
  isInternalWorkspaceDependency,
  polynomialTrailingSlashRegexViolations,
  routekitDependencyViolations,
  routekitProductionSources,
  routekitSourceViolations,
  toolRegistryCliSourceViolations,
  toolRegistryCompositionViolations,
  toolRegistryConstructionViolations
} from "./lib/architecture-guards.mjs";

const FORBIDDEN_PRODUCT = ["fu", "sion", "kit"].join("");
const FORBIDDEN_SCOPE = `@${FORBIDDEN_PRODUCT}/`;
const RETIRED_ACP_PACKAGE = "@zed-industries/agent-client-protocol";

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
  ".changeset/config.json",
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
runOptionalCheck("scripts/generate-shell-scripts.mjs", "shell scripts", ["--check"], [
  "shell/lib/preamble.sh",
  "shell/remote/probe.sh"
]);
runOptionalCheck("scripts/generate-pricing.mjs", "pricing", ["--check"], [
  "spec/registry/pricing.json"
]);
runOptionalCheck("scripts/generate-local-catalog.mjs", "local catalog", ["--check"], [
  "spec/registry/local-catalog.json"
]);
runOptionalCheck("scripts/generate-routekit-l06-evidence.mjs", "RouteKit L06 evidence");
runOptionalCheck(
  "scripts/generate-routekit-client-support.mjs",
  "RouteKit client support",
  ["--check"],
  [
    "spec/routekit/supported-clients.json",
    "packages/cli/src/launch-support.ts"
  ]
);

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

// Third-party dependencies must use the pnpm catalog (`catalog:`).
// Pins live in pnpm-workspace.yaml; syncpack lint enforces catalog policy.
function checkDeps(manifestPath, manifest) {
  for (const section of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies"
  ]) {
    if (manifest[section]?.[RETIRED_ACP_PACKAGE] !== undefined) {
      fail(
        `${manifestPath} ${section} references retired package "${RETIRED_ACP_PACKAGE}"; ` +
          'use "@agentclientprotocol/sdk"'
      );
    }
  }
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
      if (version !== "catalog:") {
        fail(
          `${manifestPath} ${section} "${name}": third-party dependencies must use catalog: ` +
            `(add the pin to pnpm-workspace.yaml catalog)`
        );
      }
    }
  }
}

checkDeps("package.json", pkg);
if (readFileSync("pnpm-workspace.yaml", "utf8").includes(RETIRED_ACP_PACKAGE)) {
  fail(
    `pnpm-workspace.yaml references retired package "${RETIRED_ACP_PACKAGE}"; ` +
      'use "@agentclientprotocol/sdk"'
  );
}

const workspaceDirs = readdirSync("packages").map((dir) => join("packages", dir));
if (existsSync("apps")) {
  for (const dir of readdirSync("apps")) {
    const appDir = join("apps", dir);
    if (statSync(appDir).isDirectory() && existsSync(join(appDir, "package.json"))) {
      workspaceDirs.push(appDir);
    }
  }
}
const workspaceManifests = [];
for (const dir of workspaceDirs) {
  if (!statSync(dir).isDirectory()) continue;
  const trackedPackageJson = spawnSync("git", ["ls-files", join(dir, "package.json")], {
    encoding: "utf8"
  });
  if (trackedPackageJson.status !== 0 || !trackedPackageJson.stdout.trim()) {
    fail(`stale build debris in ${dir} — git clean it (no tracked package.json)`);
  }
}
for (const dir of workspaceDirs) {
  const manifestPath = join(dir, "package.json");
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (dir.startsWith("packages/") && existsSync(join(dir, "src", "test")) && manifest.scripts?.test === undefined) {
    fail(`${manifestPath} has src/test/ but no "test" script — its tests would never run`);
  }
  checkDeps(manifestPath, manifest);
  if (dir.startsWith("packages/")) {
    workspaceManifests.push({ manifestPath, manifest, dir });
  }
}

const workspaceVersions = new Set(workspaceManifests.map(({ manifest }) => manifest.version));
if (workspaceVersions.size !== 1) {
  fail(`RouteKit packages must remain lockstep; found versions: ${[...workspaceVersions].join(", ")}`);
}

const changesetsConfig = JSON.parse(readFileSync(".changeset/config.json", "utf8"));
const fixed = changesetsConfig.fixed ?? [];
if (fixed.length !== 1) {
  fail(".changeset/config.json must contain exactly one fixed package group");
} else {
  const expected = workspaceManifests.map(({ manifest }) => manifest.name).sort();
  const actual = [...fixed[0]].sort();
  if (expected.length !== actual.length || expected.some((name, i) => name !== actual[i])) {
    fail(
      ".changeset/config.json fixed group must exactly match packages/*\n" +
        `  expected: ${expected.join(", ")}\n` +
        `  actual:   ${actual.join(", ")}`
    );
  }
}
if (changesetsConfig.access !== "public") {
  fail(".changeset/config.json access must be public");
}
if (changesetsConfig.baseBranch !== "main") {
  fail(".changeset/config.json baseBranch must be main");
}
if (changesetsConfig.privatePackages?.version !== true) {
  fail(".changeset/config.json must version private packages");
}

const publishable = workspaceManifests.filter(({ manifest }) => manifest.private === false);
if (publishable.length < 20) {
  fail(`expected at least 20 publishable packages, got ${publishable.length}`);
}
for (const { manifestPath, manifest } of workspaceManifests) {
  if (manifest.private !== false && manifest.private !== true) {
    fail(`${manifestPath} must explicitly set private:true or private:false`);
  }
}

for (const violation of routekitDependencyViolations(workspaceManifests)) {
  fail(
    `${violation.manifestPath} RouteKit dependency must stay within @velum-labs/routekit*: ` +
      violation.dependencyPath.join(" -> ")
  );
}
for (const violation of canonicalSharedPackageViolations(workspaceManifests)) {
  fail(`canonical shared package violation: ${violation}`);
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
  const forbiddenVocabulary = new RegExp(
    `(?:${FORBIDDEN_SCOPE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}|\\b(?:${FORBIDDEN_PRODUCT}|fusion|fused)\\b)`,
    "i"
  );
  if (forbiddenVocabulary.test(readFileSync(file, "utf8"))) {
    fail(`${file} must not contain foreign product dependencies or vocabulary`);
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
  `${FORBIDDEN_SCOPE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:tools|harness-core|tool-(?:codex|claude|cursor|opencode))|` +
    `${FORBIDDEN_PRODUCT.toUpperCase()}_${"HARNESS"}_${"DRIVERS"}`
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

// Domain policy: deferred-work markers (too product-specific for Biome).
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

const biomeBin = join(process.cwd(), "node_modules", "@biomejs", "biome", "bin", "biome");
const biomeLint = spawnSync(process.execPath, [biomeBin, "lint", "."], {
  encoding: "utf8"
});
if (biomeLint.stdout?.trim()) console.log(biomeLint.stdout.trim());
if (biomeLint.stderr?.trim()) console.error(biomeLint.stderr.trim());
if (biomeLint.status !== 0) fail("biome lint failed");

const syncpackLint = spawnSync(
  process.execPath,
  [join(process.cwd(), "node_modules", "syncpack", "index.cjs"), "lint"],
  { encoding: "utf8" }
);
if (syncpackLint.stdout?.trim()) console.log(syncpackLint.stdout.trim());
if (syncpackLint.stderr?.trim()) console.error(syncpackLint.stderr.trim());
if (syncpackLint.status !== 0) fail("syncpack lint failed");

const depcruise = spawnSync(
  process.execPath,
  [
    join(process.cwd(), "node_modules", "dependency-cruiser", "bin", "dependency-cruise.mjs"),
    "packages",
    "--config",
    ".dependency-cruiser.mjs"
  ],
  { encoding: "utf8" }
);
if (depcruise.stdout?.trim()) console.log(depcruise.stdout.trim());
if (depcruise.stderr?.trim()) console.error(depcruise.stderr.trim());
if (depcruise.status !== 0) fail("dependency-cruiser failed");

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

const forbiddenGrep = spawnSync(
  "git",
  ["grep", "-I", "-i", "-n", FORBIDDEN_PRODUCT, "--", "packages", "scripts", "test", "SECURITY.md"],
  { encoding: "utf8" }
);
if (forbiddenGrep.status === 0) {
  const hits = forbiddenGrep.stdout
    .split("\n")
    .filter((line) => line.length > 0 && !line.startsWith("scripts/check-repo.mjs:"))
    .join("\n");
  if (hits.length > 0) {
    fail(`forbidden product vocabulary in tracked sources:\n${hits}`);
  }
} else if (forbiddenGrep.status !== 1) {
  fail(`forbidden vocabulary grep failed: ${forbiddenGrep.stderr || forbiddenGrep.stdout}`);
}

if (process.exitCode) process.exit(process.exitCode);
console.log("repo check passed");
