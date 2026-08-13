import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertExplicitEvalModel,
  EVAL_POLICY,
  isForbiddenEvalModel
} from "../index.js";

test("eval contracts forbid auto-router model ids", () => {
  assert.equal(isForbiddenEvalModel("auto"), true);
  assert.equal(isForbiddenEvalModel("openai/gpt-4o-mini"), false);
  assert.throws(() => assertExplicitEvalModel("auto", "candidate"), /explicit provider\/model/);
  assert.equal(EVAL_POLICY.autoRouterForbidden, true);
  assert.equal(EVAL_POLICY.onlineRequestPathIsolated, true);
});
