import assert from "node:assert/strict";
import { test } from "node:test";

import { questionForStage } from "../questions.js";

test("setup exposes exactly one question for each unresolved stage", () => {
  const stages = [
    "surface",
    "data",
    "criteria",
    "constraints",
    "candidates",
    "spend-approval",
    "publish"
  ] as const;
  for (const stage of stages) {
    const question = questionForStage(stage);
    assert.equal(question?.id, stage);
    assert.equal(question?.options.length, 3);
  }
  assert.equal(questionForStage("completed"), undefined);
});

test("repository findings become workspace-specific setup options", () => {
  const question = questionForStage("surface", {
    repositoryRoot: "/repo",
    materials: [],
    surfaces: [
      { name: "support", path: "src/support.ts", model: "openai/current" },
      { name: "triage", path: "src/triage.ts" }
    ]
  });
  assert.deepEqual(question?.options, [
    "support on openai/current",
    "triage (src/triage.ts)",
    "Stop setup"
  ]);
});
