import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { layer as NodeServicesLayer } from "@effect/platform-node/NodeServices";
import type {
  EvalComparisonRequest,
  EvalComparisonResult,
  RoutingBasis
} from "@velum-labs/routekit-eval-contracts";
import { Effect, Layer } from "effect";

import {
  EvalComparisonRunner,
  EvalService,
  EvalServiceComparisonError,
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
    inspect: (request) =>
      Effect.succeed({
        suiteDigest: "suite-digest",
        manifest: {
          version: 1,
          profileId: request.profileId,
          candidateModels: request.candidateModels,
          judgeModel: request.judgeModel,
          caseCount: 1,
          caseIds: ["case-1"],
          maxOutputTokens: 1,
          expectedCallCount: request.candidateModels.length * 2
        }
      }),
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
  return makeEvalServiceLayer({
    gatewayUrl: "http://127.0.0.1:8080/v1",
    snapshotRoot: input.snapshotRoot,
    pilot: { concurrency: 2, timeoutMs: 5_000, spendLimitUsd: 0.5 },
    full: { concurrency: 8, timeoutMs: 30_000, spendLimitUsd: 5 }
  }).pipe(Layer.provide(runner), Layer.provide(NodeServicesLayer));
};

test("service publishes a compiled policy snapshot without embedding credentials", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "routekit-eval-service-"));
  roots.push(root);
  const requests: EvalComparisonRequest[] = [];
  const modes: string[] = [];
  const snapshotRoot = path.join(root, ".routekit", "published");
  const layer = makeWorkflowLayer({ snapshotRoot, requests, modes });
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
  const outcome = await Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* EvalService;
      const comparison = yield* service.runPilot(scaffold);
      const policy = yield* service.propose(scaffold, comparison);
      return yield* service.publish(policy);
    }).pipe(Effect.provide(layer))
  );
  assert.equal(outcome.profiles.support?.selectedModel, "openai/cheap");
  assert.deepEqual(modes, ["pilot"]);
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
    inspect: (request) =>
      Effect.succeed({
        suiteDigest: "suite-digest",
        manifest: {
          version: 1,
          profileId: request.profileId,
          candidateModels: request.candidateModels,
          judgeModel: request.judgeModel,
          caseCount: 1,
          caseIds: ["case-1"],
          maxOutputTokens: 1,
          expectedCallCount: request.candidateModels.length * 2
        }
      }),
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

const matrixDimensionIds = [
  "gateway-protocol",
  "eval-routing",
  "account-pooling",
  "typescript-maintenance",
  "release-operations"
] as const;

const matrixCatalog: RoutingBasis = {
  version: 2,
  basisDigest: "matrix-definition-set",
  dimensions: matrixDimensionIds.map((id) => ({
    id,
    description: `Requests about ${id}`,
    includes: [`Tasks specifically involving ${id}`],
    excludes: [`Tasks unrelated to ${id}`]
  }))
};

const matrixScaffolds = (root: string) =>
  matrixDimensionIds.map((dimensionId) => ({
    dimensionId,
    scaffold: {
      evalPath: path.join(root, `${dimensionId}.eval.ts`),
      profilePath: path.join(root, `${dimensionId}.yaml`),
      profile: {
        version: 1 as const,
        id: dimensionId,
        suite: `${dimensionId}.eval.ts`,
        candidates: ["openai/cheap", "anthropic/strong"],
        judge: "openai/judge",
        eligibility: {},
        objective: "highest-quality" as const
      }
    }
  }));

test("dimension matrix qualification inspects every manifest before compiling one v2 snapshot", async () => {
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
        return {
          ...resultFor(request),
          comparisonId: `comparison-${request.profileId}`,
          suiteDigest: `suite-${request.profileId}`
        };
      })
  });
  const layer = makeEvalServiceLayer({
    gatewayUrl: "http://127.0.0.1:8080/v1",
    snapshotRoot
  }).pipe(Layer.provide(runner), Layer.provide(NodeServicesLayer));

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* EvalService).qualifyDimensionMatrix({
        basis: matrixCatalog,
        candidateModels: ["openai/cheap", "anthropic/strong"],
        classifierModel: "openai/classifier",
        judgeModel: "openai/judge",
        objective: { kind: "highest-quality" },
        maximumUnknownWeight: 0.2,
        suites: matrixScaffolds(root)
      });
    }).pipe(Effect.provide(layer))
  );

  assert.equal(result.comparisons.length, 5);
  assert.equal(result.snapshot.evidence.length, 10);
  assert.deepEqual(
    events,
    [
      ...matrixDimensionIds.map((dimensionId) => `inspect:${dimensionId}`),
      ...matrixDimensionIds.map((dimensionId) => `run:${dimensionId}`)
    ]
  );
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
    runComparison: (request) =>
      Effect.succeed({
        ...resultFor(request),
        comparisonId: `comparison-${request.profileId}`,
        suiteDigest: `suite-${request.profileId}`
      })
  });
  const layer = makeEvalServiceLayer({
    gatewayUrl: "http://127.0.0.1:8080/v1",
    snapshotRoot
  }).pipe(Layer.provide(runner), Layer.provide(NodeServicesLayer));

  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      return yield* (yield* EvalService).qualifyDimensionMatrix({
        basis: matrixCatalog,
        candidateModels: ["openai/cheap", "anthropic/strong"],
        classifierModel: "openai/classifier",
        judgeModel: "openai/judge",
        objective: { kind: "highest-quality" },
        maximumUnknownWeight: 0.2,
        suites: matrixScaffolds(root)
      });
    }).pipe(Effect.provide(layer))
  );

  assert.equal(exit._tag, "Failure");
  await assert.rejects(
    readFile(path.join(snapshotRoot, "published-routing.json"), "utf8"),
    /ENOENT/u
  );
});
