import assert from "node:assert/strict";
import { test } from "node:test";

import { cursorInstructions } from "../launch.js";

test("Cursor setup instructions encode selected effort in the model name", () => {
  assert.match(
    cursorInstructions("http://127.0.0.1:8080", "openai/gpt-5.5"),
    /Model name\s+: routekit\/openai\/gpt-5\.5\n/
  );
  assert.match(
    cursorInstructions("http://127.0.0.1:8080", "openai/gpt-5.5", "token", {
      mode: "effort",
      effort: "high"
    }),
    /Model name\s+: routekit\/openai\/gpt-5\.5:high\n/
  );
  assert.match(
    cursorInstructions("http://127.0.0.1:8080", "openai/gpt-5.5", "token", {
      mode: "effort",
      effort: "high"
    }),
    /Effort "high" is encoded in the model name/
  );
});
