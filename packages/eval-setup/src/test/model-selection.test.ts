import assert from "node:assert/strict";
import { test } from "node:test";

import { modelSelectionFromAnswer } from "../model-selection.js";

test("model selection accepts exactly two candidates followed by a distinct judge", () => {
  assert.deepEqual(
    modelSelectionFromAnswer("openai/gpt-a anthropic/claude-b google/gemini-judge"),
    {
      candidates: ["openai/gpt-a", "anthropic/claude-b"],
      judgeModel: "google/gemini-judge"
    }
  );
});

test("model selection rejects canned answers, duplicates, aliases, and extra ids", () => {
  assert.throws(
    () => modelSelectionFromAnswer("Current model, a cheaper candidate, and a stronger candidate"),
    /exactly three explicit provider\/model ids/iu
  );
  assert.throws(
    () => modelSelectionFromAnswer("openai/a openai/a openai/judge"),
    /three unique model ids/iu
  );
  assert.throws(
    () => modelSelectionFromAnswer("openai/a anthropic/b routekit/auto"),
    /concrete provider\/model id/iu
  );
  assert.throws(
    () => modelSelectionFromAnswer("openai/a anthropic/b google/judge mistral/extra"),
    /exactly three explicit provider\/model ids/iu
  );
});
