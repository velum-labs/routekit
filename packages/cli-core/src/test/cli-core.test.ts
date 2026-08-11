import assert from "node:assert/strict";
import test from "node:test";

import {
  findFlagTypos,
  formatPackageVersion,
  immutableCliRuntime,
  parseIdValue,
  parsePositiveInteger,
  processCliRuntime
} from "../index.js";

test("shared option and flag mechanics are deterministic", () => {
  assert.deepEqual(parseIdValue("--model", "writer=openai:gpt"), {
    id: "writer",
    value: "openai:gpt"
  });
  assert.equal(parsePositiveInteger("--count", "3"), 3);
  assert.deepEqual(findFlagTypos(["--budget"], ["--buget"]), [
    { given: "--buget", suggestion: "--budget" }
  ]);
  assert.equal(
    formatPackageVersion("@velum-labs/routekit-example", "1.2.3"),
    "@velum-labs/routekit-example@1.2.3"
  );
  assert.equal(processCliRuntime.platform, process.platform);
  const runtime = immutableCliRuntime({
    stdout: process.stdout,
    stderr: process.stderr,
    env: { TEST_VALUE: "original" },
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.versions.node
  });
  assert.ok(Object.isFrozen(runtime));
  assert.ok(Object.isFrozen(runtime.env));
});
