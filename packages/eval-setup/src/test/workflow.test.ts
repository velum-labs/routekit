import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { layer as NodeServicesLayer } from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import {
  EvalSetup,
  EvalSetupLive,
  EvalSetupRunner,
  OriEvalAuthoring,
  oriAuthoringFromApi
} from "../index.js";
import type { OriEvalAuthoringApi, OriEvalResult } from "../ori-result.js";

const roots: string[] = [];
after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

const waiting = (tag: string, prompt: string): OriEvalResult => ({
  ok: true,
  status: "waiting",
  runDirectory: "/tmp/ori-run",
  tag,
  prompt,
  question: prompt,
  options: ["Support replies", "Documentation", "Routing"],
  context: "Inspected the repository."
});

const fakeAuthoring = (turns: OriEvalResult[]): OriEvalAuthoringApi => {
  let index = 0;
  const next = (): OriEvalResult =>
    turns[Math.min(index++, turns.length - 1)] ?? waiting("surface", "Which surface?");
  return {
    prepare: async () => ({ ok: true, status: "prepared", runDirectory: "/tmp/ori-run" }),
    run: async () => next(),
    answer: async (input) => {
      if (/clarif|what do you mean/iu.test(input.answer)) {
        return { ...waiting("surface", "Which surface?"), accepted: false };
      }
      return next();
    },
    status: async () =>
      turns[Math.max(0, index - 1)] ?? {
        ok: true,
        status: "prepared",
        runDirectory: "/tmp/ori-run"
      }
  };
};

const makeLayer = (api: OriEvalAuthoringApi, publishes: { count: number }) =>
  EvalSetupLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        OriEvalAuthoring.layer(oriAuthoringFromApi(api)),
        EvalSetupRunner.layer({
          validate: () => Effect.void,
          estimate: () =>
            Effect.succeed({ callCount: 12, maximumCostUsd: 0.42, pricingKnown: true }),
          publish: () =>
            Effect.sync(() => {
              publishes.count += 1;
              return {
                comparison: {
                  version: 1 as const,
                  comparisonId: "comparison-1",
                  profileId: "support",
                  suiteDigest: "suite",
                  judgeModel: "openai/judge",
                  startedAt: "2026-08-16T00:00:00.000Z",
                  finishedAt: "2026-08-16T00:01:00.000Z",
                  models: []
                },
                proposal: {
                  version: 1 as const,
                  profileId: "support",
                  selectedModel: "openai/cheap",
                  fallbackModels: ["anthropic/strong"],
                  objective: "lowest-cost" as const,
                  suiteDigest: "suite",
                  evidenceDigest: "evidence",
                  evidence: [],
                  rejected: []
                }
              };
            })
        })
      )
    ),
    Layer.provide(NodeServicesLayer)
  );

test("prepare, run, answer, and status relay Ori questions and resume durable host metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "routekit-eval-setup-ori-"));
  roots.push(root);
  await writeFile(path.join(root, "source.txt"), "unchanged\n");
  const publishes = { count: 0 };
  const api = fakeAuthoring([
    waiting("surface", "Which model call should we evaluate?"),
    {
      ok: true,
      status: "completed",
      runDirectory: "/tmp/ori-run",
      scratchWorkspace: path.join(root, "scratch"),
      evalRuns: []
    }
  ]);
  const first = await Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* EvalSetup;
      const prepared = yield* setup.prepare(root, "support");
      assert.equal(prepared.state.stage, "prepared");
      const running = yield* setup.runApproved(root, "support");
      assert.equal(running.state.stage, "surface");
      assert.equal(running.question?.prompt, "Which model call should we evaluate?");
      const clarification = yield* setup.answer(root, "support", "Can you clarify?");
      assert.equal(clarification.state.stage, "surface");
      return yield* setup.answer(root, "support", "1");
    }).pipe(Effect.provide(makeLayer(api, publishes)))
  );
  assert.equal(first.state.stage, "completed");
  assert.equal(first.state.answers.surface, "1");

  const resumed = await Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* EvalSetup;
      return yield* setup.prepare(root, "support");
    }).pipe(Effect.provide(makeLayer(api, publishes)))
  );
  assert.equal(resumed.state.answers.surface, "1");
  assert.equal(await readFile(path.join(root, "source.txt"), "utf8"), "unchanged\n");
});

test("publication requires a completed Ori run and runs exactly once", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "routekit-eval-setup-publish-"));
  roots.push(root);
  const publishes = { count: 0 };
  const completed: OriEvalResult = {
    ok: true,
    status: "completed",
    runDirectory: "/tmp/ori-run",
    scratchWorkspace: path.join(root, "scratch"),
    evalRuns: [{ ok: true, model: "openai/cheap" }]
  };
  const api = fakeAuthoring([waiting("surface", "Which surface?"), completed]);
  const outcome = await Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* EvalSetup;
      yield* setup.prepare(root, "support");
      yield* setup.runApproved(root, "support");
      const early = yield* Effect.exit(setup.publishApproved(root, "support"));
      assert.equal(early._tag, "Failure");
      yield* setup.answer(root, "support", "1");
      const published = yield* setup.publishApproved(root, "support");
      const duplicateRun = yield* Effect.exit(setup.runApproved(root, "support"));
      assert.equal(duplicateRun._tag, "Failure");
      return published;
    }).pipe(Effect.provide(makeLayer(api, publishes)))
  );
  assert.equal(outcome.state.stage, "completed");
  assert.equal(outcome.proposal?.selectedModel, "openai/cheap");
  assert.equal(publishes.count, 1);
});
