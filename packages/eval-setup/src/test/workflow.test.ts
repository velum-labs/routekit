import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { layer as NodeServicesLayer } from "@effect/platform-node/NodeServices";
import type {
  CompiledRoutingPolicy,
  EvalComparisonResult
} from "@velum-labs/routekit-eval-contracts";
import { Effect, Layer } from "effect";

import {
  EvalRepositoryInspectorLive,
  EvalSetup,
  EvalSetupLive,
  EvalSetupRunner,
  EvalSetupScaffolderLive,
  EvalSetupStateStoreLive
} from "../index.js";

const roots: string[] = [];
after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

const comparison: EvalComparisonResult = {
  version: 1,
  comparisonId: "comparison-1",
  profileId: "support",
  suiteDigest: "suite-digest",
  judgeModel: "openai/judge",
  startedAt: "2026-08-15T00:00:00.000Z",
  finishedAt: "2026-08-15T00:01:00.000Z",
  models: []
};

const proposal: CompiledRoutingPolicy = {
  version: 1,
  profileId: "support",
  selectedModel: "openai/cheap",
  fallbackModels: ["anthropic/strong"],
  objective: "lowest-cost",
  suiteDigest: "suite-digest",
  evidenceDigest: "evidence-digest",
  evidence: [],
  rejected: []
};

const makeLayer = (counters: { runs: number; publishes: number }) =>
  EvalSetupLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        EvalSetupStateStoreLive,
        EvalRepositoryInspectorLive,
        EvalSetupScaffolderLive,
        EvalSetupRunner.layer({
          validate: () => Effect.void,
          estimate: () =>
            Effect.succeed({ callCount: 9, maximumCostUsd: 1.25, pricingKnown: true }),
          runPilot: () =>
            Effect.sync(() => {
              counters.runs += 1;
              return comparison;
            }),
          runFull: () =>
            Effect.sync(() => {
              counters.runs += 1;
              return comparison;
            }),
          propose: () => Effect.succeed(proposal),
          publish: () =>
            Effect.sync(() => {
              counters.publishes += 1;
            })
        })
      )
    ),
    Layer.provide(NodeServicesLayer)
  );

const answerStages = (root: string) =>
  Effect.gen(function* () {
    const setup = yield* EvalSetup;
    yield* setup.prepare(root, "support");
    yield* setup.answer(root, "support", "support replies");
    yield* setup.answer(root, "support", "test/fixtures/support.json");
    yield* setup.answer(root, "support", "Answers follow the support policy.");
    yield* setup.answer(root, "support", "Lowest cost after quality");
    return yield* setup.answer(root, "support", "openai/cheap anthropic/strong openai/judge");
  });

test("workflow persists one open question and resumes without repeating completed answers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "routekit-eval-setup-flow-"));
  roots.push(root);
  await writeFile(path.join(root, "support.ts"), 'const model = "openai/current";\n');
  const counters = { runs: 0, publishes: 0 };
  const first = await Effect.runPromise(
    answerStages(root).pipe(Effect.provide(makeLayer(counters)))
  );
  assert.equal(first.state.stage, "spend-approval");
  assert.equal(first.events.filter((event) => event.type === "question").length, 1);
  assert.match(await readFile(first.state.generatedEvalPath ?? "", "utf8"), /routekit\/eval/u);

  const resumed = await Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* EvalSetup;
      return yield* setup.prepare(root, "support");
    }).pipe(Effect.provide(makeLayer(counters)))
  );
  assert.equal(resumed.state.stage, "spend-approval");
  assert.equal(resumed.state.answers.surface, "support replies");
  assert.equal(resumed.question?.id, "spend-approval");
});

test("paid execution and publication each require explicit approval and run exactly once", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "routekit-eval-setup-approve-"));
  roots.push(root);
  await writeFile(path.join(root, "support.ts"), 'const model = "openai/current";\n');
  const counters = { runs: 0, publishes: 0 };
  const program = Effect.gen(function* () {
    const setup = yield* EvalSetup;
    yield* answerStages(root);
    yield* setup.answer(root, "support", "Run a three-case pilot");
    const run = yield* setup.runApproved(root, "support");
    assert.equal(run.state.stage, "publish");
    assert.equal(run.question?.id, "publish");
    const duplicate = yield* Effect.exit(setup.runApproved(root, "support"));
    assert.equal(duplicate._tag, "Failure");
    yield* setup.answer(root, "support", "Publish this policy");
    return yield* setup.publishApproved(root, "support");
  });
  const completed = await Effect.runPromise(program.pipe(Effect.provide(makeLayer(counters))));
  assert.equal(completed.state.stage, "completed");
  assert.equal(counters.runs, 1);
  assert.equal(counters.publishes, 1);
});

test("save-only completes without invoking the runner", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "routekit-eval-setup-save-"));
  roots.push(root);
  await writeFile(path.join(root, "support.ts"), 'const model = "openai/current";\n');
  const counters = { runs: 0, publishes: 0 };
  const completed = await Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* EvalSetup;
      yield* answerStages(root);
      return yield* setup.answer(root, "support", "Save without running");
    }).pipe(Effect.provide(makeLayer(counters)))
  );
  assert.equal(completed.state.stage, "completed");
  assert.equal(counters.runs, 0);
  assert.equal(counters.publishes, 0);
});

test("candidate stage rejects canned and non-unique model selections without advancing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "routekit-eval-setup-model-answer-"));
  roots.push(root);
  await writeFile(path.join(root, "support.ts"), 'const model = "openai/current";\n');
  const counters = { runs: 0, publishes: 0 };
  const program = Effect.gen(function* () {
    const setup = yield* EvalSetup;
    yield* setup.prepare(root, "support");
    yield* setup.answer(root, "support", "support replies");
    yield* setup.answer(root, "support", "test/fixtures/support.json");
    yield* setup.answer(root, "support", "Answers follow the support policy.");
    yield* setup.answer(root, "support", "Lowest cost after quality");
    const canned = yield* Effect.exit(
      setup.answer(root, "support", "Current model, a cheaper candidate, and a stronger candidate")
    );
    assert.equal(canned._tag, "Failure");
    const duplicate = yield* Effect.exit(
      setup.answer(root, "support", "openai/cheap openai/cheap openai/judge")
    );
    assert.equal(duplicate._tag, "Failure");
    return yield* setup.status(root, "support");
  });
  const status = await Effect.runPromise(program.pipe(Effect.provide(makeLayer(counters))));
  assert.equal(status?.state.stage, "candidates");
  assert.equal(status?.state.answers.candidates, undefined);
});
