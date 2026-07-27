import { existsSync, readFileSync } from "node:fs";

const RELEASE_MANIFEST = "release/npm-packages.json";
const WORKFLOW = ".github/workflows/release-packages.yml";
const NPM_PUBLISHER = "scripts/publish-npm-workspaces.mjs";

const fail = (message) => {
  console.error(`release publish check failed: ${message}`);
  process.exitCode = 1;
};

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

for (const path of [RELEASE_MANIFEST, WORKFLOW, NPM_PUBLISHER]) {
  if (!existsSync(path)) fail(`missing ${path}`);
}

const manifest = readJson(RELEASE_MANIFEST);
if (manifest.canonicalRepository !== "velum-labs/routekit") {
  fail("release manifest must publish only from velum-labs/routekit");
}
for (const pattern of ["routekit-v*", "v*"]) {
  if (!manifest.tagPatterns?.includes(pattern)) {
    fail(`release manifest missing tag pattern ${pattern}`);
  }
}
if (manifest.registry !== "https://registry.npmjs.org") {
  fail("release manifest must publish npm packages to the public npm registry");
}
if (manifest.access !== "public") {
  fail("release manifest must publish npm packages with public access");
}
if (manifest.provenance !== true) {
  fail("release manifest must require npm provenance");
}

const workflow = readFileSync(WORKFLOW, "utf8");
for (const required of [
  "github.repository == 'velum-labs/routekit'",
  "routekit-v*",
  "v*",
  "permissions:",
  // `contents: write` is needed to attach install.sh to the published release.
  "contents: write",
  "id-token: write",
  "corepack pnpm check",
  "corepack pnpm exec turbo run build --filter='./packages/*'",
  "scripts/check-routekit-cli-pack.mjs",
  "corepack pnpm test",
  "scripts/publish-npm-workspaces.mjs",
  "secrets.NPM_TOKEN",
  "inputs.publish == true",
  "npm-bootstrap.npmrc",
  "Publishing via npm OIDC trusted publishing"
]) {
  if (!workflow.includes(required)) {
    fail(`release workflow missing required fragment: ${required}`);
  }
}

const packages = manifest.packages ?? [];
if (packages.length < 20) fail(`expected at least 20 publishable packages, got ${packages.length}`);
for (const entry of packages) {
  if (!entry.name?.startsWith("@velum-labs/routekit")) {
    fail(`publish list contains non-RouteKit package ${entry.name}`);
  }
  if (!existsSync(`${entry.path}/package.json`)) {
    fail(`missing package at ${entry.path}`);
  }
}

if (process.exitCode) process.exit(process.exitCode);
console.log("release publish check passed");
