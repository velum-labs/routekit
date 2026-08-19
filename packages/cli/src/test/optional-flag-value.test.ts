import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { normalizeOptionalFlagValues } from "../adapters/optional-flag-value.js";

test("bare watch receives the historical five-second default", () => {
  assert.deepEqual(normalizeOptionalFlagValues(["status", "--watch"], "status"), [
    "status",
    "--watch",
    "5"
  ]);
  assert.deepEqual(
    normalizeOptionalFlagValues(["usage", "--watch", "--quiet"], "usage"),
    ["usage", "--watch", "5", "--quiet"]
  );
});

test("watch values and passthrough arguments are not rewritten", () => {
  assert.deepEqual(
    normalizeOptionalFlagValues(["status", "--watch", "10"], "status"),
    ["status", "--watch", "10"]
  );
  assert.deepEqual(
    normalizeOptionalFlagValues(["codex", "--", "--watch"], "codex"),
    ["codex", "--", "--watch"]
  );
});

test("the process adapter accepts bare watch before Effect parsing", () => {
  const entrypoint = fileURLToPath(new URL("../index.js", import.meta.url));
  const result = spawnSync(process.execPath, [entrypoint, "status", "--watch", "--json"], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" }
  });
  assert.equal(result.status, 1);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /status --watch.*live human view.*cannot be combined with --json/
  );
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /requires a value|expected.*seconds/i);
});
