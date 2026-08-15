import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { layer as nodeServicesLayer } from "@effect/platform-node/NodeServices";
import { Effect, Layer, Option, Redacted } from "effect";
import { HttpClient } from "effect/unstable/http";

import {
  compareEvalRun,
  EvalAuthoring,
  EvalAuthoringLive,
  EvalAuthorSdk,
  EvalAuthorSdkLive,
  EvalHarness,
  makeEvalHarnessLayer,
  parseEvalBaselineSelector,
  renderRouteKitEvalReport,
  validateExplicitEvalModel
} from "../index.js";

const runNode = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect);
const authorSdkTestLayer = Layer.merge(EvalAuthorSdkLive, nodeServicesLayer);

test("generated SDK is fully RouteKit branded and materializes routekit/eval", async () => {
  const root = await mkdtemp(join(tmpdir(), "routekit-eval-sdk-test-"));
  try {
    const materialized = await runNode(
      Effect.gen(function* () {
        const sdk = yield* EvalAuthorSdk;
        return yield* sdk.materialize(root);
      }).pipe(Effect.provide(authorSdkTestLayer))
    );
    const packageJson = JSON.parse(
      await readFile(join(materialized.packageDirectory, "package.json"), "utf8")
    );
    const declarations = await readFile(join(materialized.packageDirectory, "eval.d.ts"), "utf8");
    assert.equal(packageJson.name, "routekit");
    assert.equal(packageJson.exports["./eval"], "./eval.js");
    assert.match(declarations, /setupAgent/);
    assert.match(declarations, /setupJudge/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("authoring state is durable and enforces one question at a time", async () => {
  const root = await mkdtemp(join(tmpdir(), "routekit-eval-authoring-test-"));
  try {
    const program = Effect.gen(function* () {
      const authoring = yield* EvalAuthoring;
      yield* authoring.prepare({
        sessionId: "session-1",
        repository: "/repo",
        request: "Create an eval",
        stateRoot: root
      });
      yield* authoring.ask(root, "session-1", {
        id: "q1",
        prompt: "Which model?",
        options: ["A", "B"]
      });
      const duplicate = yield* Effect.exit(
        authoring.ask(root, "session-1", { id: "q2", prompt: "Another?" })
      );
      assert.equal(duplicate._tag, "Failure");
      yield* authoring.answer(root, "session-1", "A");
      return yield* authoring.status(root, "session-1");
    });
    const state = await runNode(program.pipe(Effect.provide(EvalAuthoringLive)));
    assert.equal(state?.status, "running");
    assert.deepEqual(state?.answers, ["A"]);
    assert.equal(state?.turn, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("gateway harness authenticates and preserves candidate/judge roles", async () => {
  const seen: Array<{ authorization?: string; role?: string; model?: string }> = [];
  const fakeClient = HttpClient.make((request) => {
    const body = JSON.parse(
      new TextDecoder().decode(
        request.body._tag === "Uint8Array" ? request.body.body : new Uint8Array()
      )
    ) as { model?: string };
    seen.push({
      authorization: request.headers.authorization,
      role: request.headers["x-routekit-eval-role"],
      model: body.model
    });
    return Effect.succeed({
      status: 200,
      headers: request.headers,
      cookies: {},
      remoteAddress: Option.none(),
      stream: Effect.die("unused"),
      text: Effect.succeed(
        JSON.stringify({
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 2, completion_tokens: 1 }
        })
      ),
      json: Effect.succeed({
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 2, completion_tokens: 1 }
      }),
      formData: Effect.die("unused"),
      arrayBuffer: Effect.die("unused"),
      urlParamsBody: Effect.die("unused"),
      request
    } as never);
  });
  const config = {
    inferenceOrigin: "http://127.0.0.1:8080",
    catalogOrigin: "http://127.0.0.1:8080",
    credential: Redacted.make("super-secret-token"),
    candidateModel: "provider/candidate",
    judgeModel: "provider/judge",
    harness: "gateway" as const,
    timeoutMs: 1000,
    concurrency: 2
  };
  const layer = makeEvalHarnessLayer(config).pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient)(fakeClient))
  );
  const results = await runNode(
    Effect.gen(function* () {
      const harness = yield* EvalHarness;
      return yield* Effect.all([
        harness.invoke({ role: "candidate", model: config.candidateModel, prompt: "candidate" }),
        harness.invoke({ role: "judge", model: config.judgeModel, prompt: "judge" })
      ]);
    }).pipe(Effect.provide(layer))
  );
  assert.deepEqual(
    results.map((result) => result.role),
    ["candidate", "judge"]
  );
  assert.deepEqual(
    seen.map((entry) => entry.role),
    ["candidate", "judge"]
  );
  assert.ok(seen.every((entry) => entry.authorization === "Bearer super-secret-token"));
  assert.doesNotMatch(JSON.stringify(results), /super-secret-token/);
});

test("explicit model validation forbids recursive routing aliases", () => {
  for (const model of ["auto", "router", "default", "alias"]) {
    assert.ok(validateExplicitEvalModel(model, "candidate"));
  }
  assert.equal(validateExplicitEvalModel("provider/model", "candidate"), undefined);
});

test("baseline and complete report preserve absent measurements", () => {
  const baseline = {
    recordedAt: "2026-08-01T00:00:00.000Z",
    exitCode: 0,
    failedRuns: 0,
    runs: 1,
    files: ["a.eval.ts"],
    models: [{ model: "provider/model", failedRuns: 0, runs: 1 }],
    tests: { passed: 1, failed: 0, skipped: 0 }
  };
  const current = { ...baseline, recordedAt: "2026-08-02T00:00:00.000Z" };
  const selector = Option.getOrThrow(parseEvalBaselineSelector("last"));
  const comparison = compareEvalRun({ baseline, current, selector });
  const report = renderRouteKitEvalReport({
    files: ["a.eval.ts"],
    generatedAt: current.recordedAt,
    history: [baseline],
    comparison,
    results: [{ model: "provider/model", cutOff: false, outcome: "unknown" }],
    tests: []
  });
  assert.match(report, /RouteKit Eval report|Eval report/);
  assert.match(report, /unmeasured/);
  assert.doesNotMatch(report, /\$0\.000000/);
});
