import assert from "node:assert/strict";
import { test } from "node:test";
import { setupAgent, setupJudge } from "routekit/eval";
import cases from "./data/cases.json" with { type: "json" };
import manifest from "./routekit.eval-manifest.json" with { type: "json" };

const candidateModels = manifest.candidateModels;
assert.equal(candidateModels.length >= 2, true);
assert.equal(cases.length, manifest.caseCount);
const judge = setupJudge({
  agent: setupAgent({ model: manifest.judgeModel }),
  minScore: 0.8
});

for (const model of candidateModels) {
  const candidate = setupAgent({ model });
  for (const testCase of cases) {
    test(`${model} / ${testCase.id}`, async () => {
      const candidatePrompt = [
        testCase.prompt,
        "",
        "Reference material:",
        "-----",
        testCase.context,
        "-----"
      ].join("\n");
      const run = await candidate.run({ prompt: candidatePrompt, caseId: testCase.id });
      run.toComplete();
      await judge.autoEvals({
        criteria: testCase.rubric,
        prompt: candidatePrompt,
        run
      });
    });
  }
}
