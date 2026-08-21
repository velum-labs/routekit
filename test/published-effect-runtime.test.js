import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const cliManifest = JSON.parse(
  readFileSync(new URL("../packages/cli/package.json", import.meta.url), "utf8")
);
const workspace = readFileSync(new URL("../pnpm-workspace.yaml", import.meta.url), "utf8");

test("published CLI anchors the Effect platform runtime used by eval qualification", () => {
  assert.equal(cliManifest.dependencies.effect, "catalog:");
  assert.equal(cliManifest.dependencies["@effect/platform-node-shared"], "catalog:");
  assert.match(workspace, /^\s+"?effect"?: 4\.0\.0-rc\.108$/mu);
  assert.match(workspace, /^\s+"?@effect\/platform-node-shared"?: 4\.0\.0-rc\.108$/mu);
});
