import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { layer as NodeServicesLayer } from "@effect/platform-node/NodeServices";
import type {
  EvalComparisonRequest,
  EvalComparisonResult,
  RoutingBasis
} from "@velum-labs/routekit-eval-contracts";
import { Effect, Fiber, Layer } from "effect";

import { EvalComparisonRunner, EvalService, makeEvalServiceLayer } from "../index.js";

const roots: string[] = [];
after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

const dimensions = [
  "gateway-protocol",
  "eval-routing",
  "account-pooling",
  "typescript-maintenance",
  "release-operations"
] as const;

const basis: RoutingBasis = {
  version: 2,
  basisDigest: "matrix-definition-set",
  dimensions: dimensions.map((id) => ({
    id,
    description: `Requests about ${id}`,
    includes: [`Tasks specifically involving ${id}`],
    excludes: [`Tasks unrelated to ${id}`]
  }))
};

const suites = (root: string) =>
  dimensions.map((dimensionId) => ({
    dimensionId,
    suitePath: path.join(root, `${dimensionId}.eval.ts`)
  }));

const resultFor = (request: EvalComparisonRequest): EvalComparisonResult => ({
  version: 1,
  comparisonId: `comparison-${request.profileId}`,
  profileId: request.profileId,
  suiteDigest: `suite-${request.profileId}`,
  judgeModel: request.judgeModel,
  startedAt: "2026-08-18T00:00:00.000Z",
  finishedAt: "2026-08-18T00:01:00.000Z",
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

const qualification = (root: string) => ({
  basis,
  candidateModels: ["openai/cheap", "anthropic/strong"],
  classifierModel: "openai/classifier",
  judgeModel: "openai/judge",
  objective: { kind: "highest-quality" as const },
  maximumUnknownWeight: 0.2,
  suites: suites(root)
});

test("dimension matrix qualification inspects every manifest before publishing one activation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "routekit-dimension-matrix-"));
  roots.push(root);
  const events: string[] = [];
  const snapshotRoot = path.join(root, "snapshots");
  const runner = EvalComparisonRunner.layer({
    validate: () => Effect.void,
    inspect: (request) =>
      Effect.sync(() => {
        events.push(`inspect:${request.profileId}`);
        return {
          suiteDigest: `suite-${request.profileId}`,
          manifest: {
            version: 1,
            profileId: request.profileId,
            candidateModels: request.candidateModels,
            judgeModel: request.judgeModel,
            caseCount: 1,
            caseIds: ["case-1"],
            maxOutputTokens: 256,
            expectedCallCount: request.candidateModels.length * 2
          }
        };
      }),
    estimate: () => Effect.succeed({ callCount: 0, pricingKnown: false }),
    runComparison: (request) =>
      Effect.sync(() => {
        events.push(`run:${request.profileId}`);
        return resultFor(request);
      })
  });
  const layer = makeEvalServiceLayer({
    gatewayUrl: "http://127.0.0.1:8080/v1",
    snapshotRoot
  }).pipe(Layer.provide(runner), Layer.provide(NodeServicesLayer));

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* EvalService).qualifyDimensionMatrix(qualification(root));
    }).pipe(Effect.provide(layer))
  );

  assert.equal(result.comparisons.length, dimensions.length);
  assert.equal(result.snapshot.evidence.length, dimensions.length * 2);
  assert.deepEqual(events, [
    ...dimensions.map((id) => `inspect:${id}`),
    ...dimensions.map((id) => `run:${id}`)
  ]);
  const persisted = JSON.parse(
    await readFile(path.join(snapshotRoot, "published-routing.json"), "utf8")
  ) as { evidenceDigest?: string };
  assert.equal(persisted.evidenceDigest, result.snapshot.evidenceDigest);
});

test("dimension matrix qualification never publishes incomplete comparison evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "routekit-dimension-matrix-incomplete-"));
  roots.push(root);
  const snapshotRoot = path.join(root, "snapshots");
  const runner = EvalComparisonRunner.layer({
    validate: () => Effect.void,
    inspect: (request) =>
      Effect.succeed({
        suiteDigest: `suite-${request.profileId}`,
        manifest: {
          version: 1,
          profileId: request.profileId,
          candidateModels: request.candidateModels,
          judgeModel: request.judgeModel,
          caseCount: 2,
          caseIds: ["case-1", "case-2"],
          maxOutputTokens: 256,
          expectedCallCount: request.candidateModels.length * 4
        }
      }),
    estimate: () => Effect.succeed({ callCount: 0, pricingKnown: false }),
    runComparison: (request) => Effect.succeed(resultFor(request))
  });
  const layer = makeEvalServiceLayer({
    gatewayUrl: "http://127.0.0.1:8080/v1",
    snapshotRoot
  }).pipe(Layer.provide(runner), Layer.provide(NodeServicesLayer));

  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      return yield* (yield* EvalService).qualifyDimensionMatrix(qualification(root));
    }).pipe(Effect.provide(layer))
  );

  assert.equal(exit._tag, "Failure");
  await assert.rejects(
    readFile(path.join(snapshotRoot, "published-routing.json"), "utf8"),
    /ENOENT/u
  );
});

test("interrupted qualification leaves no half-published activation for a daemon restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "routekit-dimension-matrix-interrupted-"));
  roots.push(root);
  const snapshotRoot = path.join(root, "snapshots");
  let runs = 0;
  const runner = EvalComparisonRunner.layer({
    validate: () => Effect.void,
    inspect: (request) =>
      Effect.succeed({
        suiteDigest: `suite-${request.profileId}`,
        manifest: {
          version: 1,
          profileId: request.profileId,
          candidateModels: request.candidateModels,
          judgeModel: request.judgeModel,
          caseCount: 1,
          caseIds: ["case-1"],
          maxOutputTokens: 256,
          expectedCallCount: request.candidateModels.length * 2
        }
      }),
    estimate: () => Effect.succeed({ callCount: 0, pricingKnown: false }),
    runComparison: (request) => {
      runs += 1;
      return runs === 1 ? Effect.succeed(resultFor(request)) : Effect.never;
    }
  });
  const layer = makeEvalServiceLayer({
    gatewayUrl: "http://127.0.0.1:8080/v1",
    snapshotRoot
  }).pipe(Layer.provide(runner), Layer.provide(NodeServicesLayer));

  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        (yield* EvalService).qualifyDimensionMatrix(qualification(root))
      );
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(layer))
  );

  await assert.rejects(
    readFile(path.join(snapshotRoot, "published-routing.json"), "utf8"),
    /ENOENT/u
  );
});
