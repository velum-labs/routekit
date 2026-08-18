import assert from "node:assert/strict";
import test from "node:test";

import { normalizeEvalRoutingTestdriveArgv } from "../lib/eval-routing-testdrive-argv.mjs";

test("eval-routing live wrapper removes only pnpm's leading option separator", () => {
  assert.deepEqual(
    normalizeEvalRoutingTestdriveArgv([
      "--",
      "--live",
      "--classifier-only",
      "--orbit-token-file",
      "/private/token"
    ]),
    ["--live", "--classifier-only", "--orbit-token-file", "/private/token"]
  );
  assert.deepEqual(normalizeEvalRoutingTestdriveArgv(["--live", "--", "literal"]), [
    "--live",
    "--",
    "literal"
  ]);
});

test("eval-routing live wrapper rejects malformed argv", () => {
  assert.throws(() => normalizeEvalRoutingTestdriveArgv(["--live", 1]), /array of strings/u);
});
