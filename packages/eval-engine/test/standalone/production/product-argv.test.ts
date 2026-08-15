import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { parseProductArgv } from "../../../src/vendor/eval-system/product-argv.ts";

describe("product argv routing", () => {
  test("treats spawn as the command after leading output-mode flags", () => {
    assert.deepEqual(parseProductArgv(["--json", "spawn", "run", "--repo", "/tmp/repo"]), {
      command: "spawn",
      commandArgs: ["spawn", "run", "--repo", "/tmp/repo"],
      outputFlags: ["--json"],
    });
    assert.deepEqual(parseProductArgv(["--human", "--json", "spawn", "manifest"]), {
      command: "spawn",
      commandArgs: ["spawn", "manifest"],
      outputFlags: ["--human", "--json"],
    });
  });

  test("leaves eval and version commands in place", () => {
    assert.equal(parseProductArgv(["--json", "eval", "scratch"]).command, "eval");
    assert.equal(parseProductArgv(["--version"]).command, "--version");
    assert.equal(parseProductArgv(["-v"]).command, "-v");
    assert.equal(parseProductArgv([]).command, undefined);
  });
});
