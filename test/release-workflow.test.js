import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const releaseWorkflow = readFileSync(
  new URL("../.github/workflows/release-packages.yml", import.meta.url),
  "utf8"
);
const publishDocsWorkflow = readFileSync(
  new URL("../.github/workflows/publish-docs.yml", import.meta.url),
  "utf8"
);
const deployDocsAction = readFileSync(
  new URL("../.github/actions/deploy-docs/action.yml", import.meta.url),
  "utf8"
);

test("Changesets versioning regenerates the public changelog", () => {
  assert.equal(
    manifest.scripts["version-packages"],
    "changeset version && corepack pnpm docs:generate-public-changelog"
  );
  assert.match(releaseWorkflow, /version: corepack pnpm version-packages/);
  assert.doesNotMatch(releaseWorkflow, /version: corepack pnpm changeset version/);
});

test("npm publishing fails closed before and after a workspace release", () => {
  const release = manifest.scripts.release;
  const preflightIndex = release.indexOf("corepack pnpm release:registry:preflight");
  const publishIndex = release.indexOf("changeset publish");
  const verifyIndex = release.indexOf("corepack pnpm release:registry:verify");
  assert.notEqual(preflightIndex, -1);
  assert.notEqual(publishIndex, -1);
  assert.notEqual(verifyIndex, -1);
  assert.ok(preflightIndex < publishIndex);
  assert.ok(publishIndex < verifyIndex);

  assert.match(releaseWorkflow, /id: npm-release/);
  assert.match(releaseWorkflow, /steps\.changesets\.outputs\.hasChangesets == 'false'/);
  assert.match(releaseWorkflow, /run: corepack pnpm release:registry:verify/);
  assert.match(
    releaseWorkflow,
    /steps\.npm-release\.outcome == 'success' && steps\.routekit-release\.outputs\.released == 'true'/
  );
});

test("manual documentation publishing is main-only and approval-gated", () => {
  assert.match(publishDocsWorkflow, /on:\n  workflow_dispatch:\n/);
  assert.doesNotMatch(publishDocsWorkflow, /\n  push:/);
  assert.doesNotMatch(publishDocsWorkflow, /\n  pull_request:/);
  assert.match(publishDocsWorkflow, /permissions:\n  contents: read/);
  assert.match(publishDocsWorkflow, /if: github\.repository == 'velum-labs\/routekit'/);
  assert.match(publishDocsWorkflow, /DISPATCH_REF: \$\{\{ github\.ref \}\}/);
  assert.match(publishDocsWorkflow, /refs\/heads\/main/);
  assert.match(publishDocsWorkflow, /environment: docs-production/);
  assert.match(publishDocsWorkflow, /group: docs-production/);
  assert.match(publishDocsWorkflow, /cancel-in-progress: false/);
  assert.match(publishDocsWorkflow, /uses: \.\/\.github\/actions\/deploy-docs/);
});

test("verified releases publish documentation through the shared action", () => {
  assert.match(
    releaseWorkflow,
    /routekit-released: \$\{\{ steps\.routekit-release\.outputs\.released \}\}/
  );
  assert.match(releaseWorkflow, /needs\.release\.outputs\.routekit-released == 'true'/);
  assert.match(releaseWorkflow, /uses: \.\/\.github\/actions\/deploy-docs/);
  assert.match(releaseWorkflow, /group: docs-production/);
  assert.doesNotMatch(releaseWorkflow, /environment: docs-production/);
});

test("shared documentation deployment stages, validates, and promotes one Vercel build", () => {
  assert.match(deployDocsAction, /corepack pnpm dlx vercel@58\.4\.4/);
  assert.match(deployDocsAction, /vercel_cli deploy \. \\/);
  assert.match(deployDocsAction, /--prod \\/);
  assert.match(deployDocsAction, /--skip-domain \\/);
  assert.match(deployDocsAction, /--force \\/);
  assert.match(deployDocsAction, /githubCommitSha=\$\{GITHUB_SHA\}/);
  assert.match(deployDocsAction, /githubCommitRef=\$\{GITHUB_REF_NAME\}/);

  const validationIndex = deployDocsAction.indexOf(
    'if [[ ! "${deployment_url}" =~ ^https://[^[:space:]]+$ ]]'
  );
  const promotionIndex = deployDocsAction.indexOf('vercel_cli promote "${deployment_url}" --yes');
  assert.notEqual(validationIndex, -1);
  assert.notEqual(promotionIndex, -1);
  assert.ok(validationIndex < promotionIndex);
  assert.match(deployDocsAction, /deployment-url=\$\{deployment_url\}/);
});
