import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const releaseWorkflow = readFileSync(
  new URL("../.github/workflows/release-packages.yml", import.meta.url),
  "utf8"
);

test("Changesets versioning regenerates the public changelog", () => {
  assert.equal(
    manifest.scripts["version-packages"],
    "changeset version && pnpm docs:generate-public-changelog"
  );
  assert.match(releaseWorkflow, /version: corepack pnpm version-packages/);
  assert.doesNotMatch(releaseWorkflow, /version: corepack pnpm changeset version/);
});
