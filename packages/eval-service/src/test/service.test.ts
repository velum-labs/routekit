import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { layer as NodeServicesLayer } from "@effect/platform-node/NodeServices";
import type {
  EvalComparisonRequest,
  EvalComparisonResult
} from "@velum-labs/routekit-eval-contracts";
import {
  EvalRepositoryInspectorLive,
  EvalSetup,
  EvalSetupLive,
  EvalSetupScaffolderLive,
  EvalSetupStateStoreLive
} from "@velum-labs/routekit-eval-setup";
import { Effect, Layer } from "effect";

import {
  EvalComparisonRunner,
  EvalService,
  EvalServiceComparisonError,
  EvalSetupRunnerFromEvalService,
  makeEvalServiceLayer
} from "../index.js";

const roots: string[] = [];
after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

const readTree = async (root: string): Promise<string> => {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
  return (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
};

const resultFor = (request: EvalComparisonRequest): EvalComparisonResult => ({
  version: 1,
  comparisonId: "comparison-1",
  profileId: request.profileId,
  suiteDigest: "suite-digest",
  judgeModel: request.judgeModel,
  startedAt: "2026-08-15T00:00:00.000Z",
  finishedAt: "2026-08-15T00:01:00.000Z",
  models: request.candidateModels.map((model) => ({
    model,
    cases: [
      {
        caseId: "case-1",
        outcome: "passed",
        measurement: {
          judgeScore: model === "openai/cheap" ? 0.9 : 0.95,
          costUsd: model === "openai/cheap" ? 0.001 : 0.1,
          durationMs: model === "openai/cheap" ? 200 : 100
        }
      }
    ]
  }))
});

const makeWorkflowLayer = (input: {
  readonly snapshotRoot: string;
  readonly requests: EvalComparisonRequest[];
  readonly modes: string[];
  readonly invalidResult?: boolean;
}) => {
  const runner = EvalComparisonRunner.layer({
    validate: () => Effect.void,
    estimate: (request, mode) =>
      Effect.sync(() => {
        input.requests.push(request);
        input.modes.push(`estimate:${mode}`);
        return { callCount: mode === "pilot" ? 6 : 20, pricingKnown: false };
      }),
    runComparison: (request, mode) =>
      Effect.sync(() => {
        input.requests.push(request);
        input.modes.push(mode);
        const result = resultFor(request);
        return input.invalidResult ? { ...result, profileId: "wrong-profile" } : result;
      })
  });
  const service = makeEvalServiceLayer({
    gatewayUrl: "http://127.0.0.1:8080/v1",
    snapshotRoot: input.snapshotRoot,
    pilot: { concurrency: 2, timeoutMs: 5_000, spendLimitUsd: 0.5 },
    full: { concurrency: 8, timeoutMs: 30_000, spendLimitUsd: 5 }
  }).pipe(Layer.provide(runner), Layer.provide(NodeServicesLayer));
  const setupRunner = EvalSetupRunnerFromEvalService.pipe(Layer.provide(service));
  const setup = EvalSetupLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        EvalSetupStateStoreLive,
        EvalRepositoryInspectorLive,
        EvalSetupScaffolderLive,
        setupRunner
      )
    ),
    Layer.provide(NodeServicesLayer)
  );
  return Layer.merge(setup, service);
};

const answerThroughCandidates = (root: string) =>
  Effect.gen(function* () {
    const setup = yield* EvalSetup;
    yield* setup.prepare(root, "support");
    yield* setup.answer(root, "support", "support replies");
    yield* setup.answer(root, "support", "test/fixtures/support.json");
    yield* setup.answer(root, "support", "Answers follow the support policy.");
    yield* setup.answer(root, "support", "Lowest cost");
    return yield* setup.answer(root, "support", "openai/cheap anthropic/strong openai/judge");
  });

test("setup composes an approved comparison into a deterministic published snapshot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "routekit-eval-service-"));
  roots.push(root);
  await writeFile(path.join(root, "support.ts"), 'const model = "openai/current";\n');
  const requests: EvalComparisonRequest[] = [];
  const modes: string[] = [];
  const snapshotRoot = path.join(root, ".routekit", "published");
  const layer = makeWorkflowLayer({ snapshotRoot, requests, modes });

  const run = await Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* EvalSetup;
      yield* answerThroughCandidates(root);
      const estimate = yield* setup.estimate(root, "support", "pilot");
      assert.equal(estimate.callCount, 6);
      yield* setup.answer(root, "support", "Run a three-case pilot");
      return yield* setup.runApproved(root, "support");
    }).pipe(Effect.provide(layer))
  );
  assert.equal(run.state.stage, "publish");
  assert.equal(run.proposal?.selectedModel, "openai/cheap");
  assert.deepEqual(run.proposal?.fallbackModels, ["anthropic/strong"]);

  // Recreate every service and resume only from durable setup/checkpoint files.
  const resumedLayer = makeWorkflowLayer({ snapshotRoot, requests, modes });
  const outcome = await Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* EvalSetup;
      const status = yield* setup.status(root, "support");
      assert.equal(status?.state.stage, "publish");
      yield* setup.answer(root, "support", "Publish this policy");
      return yield* setup.publishApproved(root, "support");
    }).pipe(Effect.provide(resumedLayer))
  );

  assert.equal(outcome.state.stage, "completed");
  assert.deepEqual(modes, ["estimate:pilot", "pilot"]);
  const request = requests.at(-1);
  assert.deepEqual(request?.candidateModels, ["openai/cheap", "anthropic/strong"]);
  assert.equal(request?.judgeModel, "openai/judge");
  assert.equal(request?.concurrency, 2);
  assert.equal(request?.spendLimitUsd, 0.5);
  const snapshot = JSON.parse(
    await readFile(path.join(snapshotRoot, "published-routing.v1.json"), "utf8")
  ) as { profiles: Record<string, { selectedModel: string }> };
  assert.equal(snapshot.profiles.support?.selectedModel, "openai/cheap");
  const persisted = await readTree(path.join(root, ".routekit"));
  assert.doesNotMatch(persisted, /authorization|bearer|credential|candidateOutput|judgeOutput/iu);
});

test("full and pilot modes receive independent explicit execution limits", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "routekit-eval-service-limits-"));
  roots.push(root);
  const requests: EvalComparisonRequest[] = [];
  const modes: string[] = [];
  const layer = makeWorkflowLayer({ snapshotRoot: path.join(root, "snapshots"), requests, modes });
  const scaffold = {
    evalPath: path.join(root, "support.eval.ts"),
    profilePath: path.join(root, "support.yaml"),
    profile: {
      version: 1 as const,
      id: "support",
      suite: "support.eval.ts",
      candidates: ["openai/cheap", "anthropic/strong"],
      judge: "openai/judge",
      eligibility: { minimumPassRate: 0.8 },
      objective: "lowest-cost" as const
    }
  };
  await Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* EvalService;
      yield* service.runPilot(scaffold);
      yield* service.runFull(scaffold);
    }).pipe(Effect.provide(layer))
  );
  assert.deepEqual(modes, ["pilot", "full"]);
  assert.equal(requests[0]?.concurrency, 2);
  assert.equal(requests[0]?.timeoutMs, 5_000);
  assert.equal(requests[1]?.concurrency, 8);
  assert.equal(requests[1]?.timeoutMs, 30_000);
});

test("invalid explicit models fail before the injected comparison runner is called", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "routekit-eval-service-models-"));
  roots.push(root);
  const requests: EvalComparisonRequest[] = [];
  const modes: string[] = [];
  const layer = makeWorkflowLayer({ snapshotRoot: path.join(root, "snapshots"), requests, modes });
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const service = yield* EvalService;
      return yield* service.runPilot({
        evalPath: path.join(root, "support.eval.ts"),
        profilePath: path.join(root, "support.yaml"),
        profile: {
          version: 1,
          id: "support",
          suite: "support.eval.ts",
          candidates: ["auto"],
          judge: "openai/judge",
          eligibility: {},
          objective: "lowest-cost"
        }
      });
    }).pipe(Effect.provide(layer))
  );
  assert.equal(exit._tag, "Failure");
  assert.deepEqual(requests, []);
});

test("gateway credentials cannot be embedded in configuration", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "routekit-eval-service-credential-"));
  roots.push(root);
  const requests: EvalComparisonRequest[] = [];
  const runner = EvalComparisonRunner.layer({
    validate: () => Effect.void,
    estimate: () => Effect.succeed({ callCount: 0, pricingKnown: false }),
    runComparison: (request) =>
      Effect.sync(() => {
        requests.push(request);
        return resultFor(request);
      })
  });
  const layer = makeEvalServiceLayer({
    gatewayUrl: "http://routekit:rk_eval_SUPER_SECRET_7c91@127.0.0.1:8080/v1",
    snapshotRoot: path.join(root, "snapshots")
  }).pipe(Layer.provide(runner), Layer.provide(NodeServicesLayer));
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const service = yield* EvalService;
      return yield* service.runPilot({
        evalPath: path.join(root, "support.eval.ts"),
        profilePath: path.join(root, "support.yaml"),
        profile: {
          version: 1,
          id: "support",
          suite: "support.eval.ts",
          candidates: ["openai/cheap"],
          judge: "openai/judge",
          eligibility: {},
          objective: "lowest-cost"
        }
      });
    }).pipe(Effect.provide(layer))
  );
  assert.equal(exit._tag, "Failure");
  assert.deepEqual(requests, []);
  assert.doesNotMatch(await readTree(root), /rk_eval_SUPER_SECRET_7c91/u);
});

test("mismatched comparison results are typed failures and cannot be proposed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "routekit-eval-service-result-"));
  roots.push(root);
  const layer = makeWorkflowLayer({
    snapshotRoot: path.join(root, "snapshots"),
    requests: [],
    modes: [],
    invalidResult: true
  });
  const scaffold = {
    evalPath: path.join(root, "support.eval.ts"),
    profilePath: path.join(root, "support.yaml"),
    profile: {
      version: 1 as const,
      id: "support",
      suite: "support.eval.ts",
      candidates: ["openai/cheap", "anthropic/strong"],
      judge: "openai/judge",
      eligibility: {},
      objective: "lowest-cost" as const
    }
  };
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const service = yield* EvalService;
      return yield* service.runPilot(scaffold);
    }).pipe(Effect.provide(layer))
  );
  assert.equal(exit._tag, "Failure");
  if (exit._tag === "Failure") {
    const failure = exit.cause;
    assert.match(String(failure), /comparison profile/u);
  }
  assert.equal(
    new EvalServiceComparisonError({ operation: "test", detail: "test" })._tag,
    "EvalServiceComparisonError"
  );
});
