import assert from "node:assert/strict";
import test from "node:test";

import { formatRoutingRejections } from "../authored-profile-executor.js";

test("authored profile failures preserve sanitized per-model rejection reasons", () => {
  assert.equal(
    formatRoutingRejections([
      {
        model: "openai/one",
        reasons: ["pass rate 0.6 is below 0.8", "judge score 0.7 is below 0.8"]
      },
      {
        model: "openai/two",
        reasons: ["judge score 0.75 is below 0.8"]
      }
    ]),
    "openai/one: pass rate 0.6 is below 0.8; judge score 0.7 is below 0.8 | openai/two: judge score 0.75 is below 0.8"
  );
});
