import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { layer as NodeServicesLayer } from "@effect/platform-node/NodeServices";
import type {
  EvalComparisonRequest,
  EvalComparisonResult,
  RoutingBasis
} from "@velum-labs/routekit-eval-contracts";
import { EvalEngine, type EvalEngineService } from "@velum-labs/routekit-eval-engine";
import { Effect, Fiber, FileSystem, Layer, Path } from "effect";

import { EvalService, makeEvalService, makeEvalServiceLayer } from "../service.js";

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
    suitePath: path.join(root, dimensionId, `${dimensionId}.eval.ts`)
  }));

const prepareSuites = async (
  root: string,
  caseIds: readonly string[] = ["case-1"]
): Promise<void> => {
  await Promise.all(
    dimensions.map(async (dimensionId) => {
      const directory = path.join(root, dimensionId);
      await mkdir(directory, { recursive: true });
      await writeFile(
        path.join(directory, `${dimensionId}.eval.ts`),
        'import { test } from "node:test"; test("case", () => {});\n'
      );
      await writeFile(
        path.join(directory, "routekit.eval-manifest.json"),
        `${JSON.stringify({
          version: 1,
          profileId: dimensionId,
          candidateModels: ["openai/cheap", "anthropic/strong"],
          judgeModel: "openai/judge",
          caseCount: caseIds.length,
          caseIds,
          maxOutputTokens: 256,
          expectedCallCount: caseIds.length * 4
        })}\n`
      );
    })
  );
};

const mockEngineLayer = (
  runComparison: EvalEngineService["runComparison"],
  onValidate?: (dimensionId: string) => void
) =>
  Layer.succeed(
    EvalEngine,
    EvalEngine.of({
      discover: (target) =>
        Effect.succeed({
          searchRoot: target,
          workingDirectory: path.dirname(target),
          files: [target]
        }),
      validate: (target) => {
        const dimensionId = path.basename(target, ".eval.ts");
        onValidate?.(dimensionId);
        return Effect.succeed({
          searchRoot: target,
          workingDirectory: path.dirname(target),
          files: [target],
          suiteDigest: `suite-${dimensionId}`
        });
      },
      runComparison
    })
  );

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

test("manifest discovery does not call FileSystem.glob when Node glob is unavailable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "routekit-manifest-no-glob-"));
  roots.push(root);
  const suiteDirectory = path.join(root, "nested", "suite");
  const suitePath = path.join(suiteDirectory, "nested.eval.ts");
  await mkdir(suiteDirectory, { recursive: true });
  await writeFile(suitePath, 'import { test } from "node:test"; test("case", () => {});\n');
  await symlink(root, path.join(suiteDirectory, "routekit-link"), "dir");
  await writeFile(
    path.join(suiteDirectory, "routekit.eval-manifest.json"),
    `${JSON.stringify({
      version: 1,
      profileId: "nested",
      candidateModels: ["openai/cheap", "anthropic/strong"],
      judgeModel: "openai/judge",
      caseCount: 1,
      caseIds: ["case-1"],
      maxOutputTokens: 256,
      expectedCallCount: 4
    })}\n`
  );

  let globCalls = 0;
  const inspection = await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const fileSystemWithoutNodeGlob: FileSystem.FileSystem = {
        ...fs,
        glob: () => {
          globCalls += 1;
          return Effect.die(new TypeError("Function.prototype.apply was called on undefined"));
        }
      };
      const service = yield* makeEvalService().pipe(
        Effect.provideService(
          EvalEngine,
          EvalEngine.of({
            discover: () => Effect.die("unexpected discover"),
            validate: () =>
              Effect.succeed({
                searchRoot: suitePath,
                workingDirectory: root,
                files: [suitePath],
                suiteDigest: "suite-nested"
              }),
            runComparison: () => Effect.die("unexpected comparison")
          })
        ),
        Effect.provideService(FileSystem.FileSystem, fileSystemWithoutNodeGlob),
        Effect.provideService(Path.Path, paths)
      );
      return yield* service.inspect({
        version: 1,
        profileId: "nested",
        suitePath,
        candidateModels: ["openai/cheap", "anthropic/strong"],
        judgeModel: "openai/judge",
        gatewayUrl: "http://127.0.0.1:8080/v1"
      });
    }).pipe(Effect.provide(NodeServicesLayer))
  );

  assert.equal(inspection.suiteDigest, "suite-nested");
  assert.equal(inspection.manifest.profileId, "nested");
  assert.equal(globCalls, 0);
});

test("dimension matrix qualification inspects every manifest before publishing one activation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "routekit-dimension-matrix-"));
  roots.push(root);
  await prepareSuites(root);
  const events: string[] = [];
  const snapshotRoot = path.join(root, "snapshots");
  const engine = mockEngineLayer(
    (request) =>
      Effect.sync(() => {
        events.push(`run:${request.profileId}`);
        return resultFor(request);
      }),
    (dimensionId) => events.push(`inspect:${dimensionId}`)
  );
  const layer = makeEvalServiceLayer({
    gatewayUrl: "http://127.0.0.1:8080/v1",
    snapshotRoot
  }).pipe(Layer.provide(engine), Layer.provide(NodeServicesLayer));

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
  await prepareSuites(root, ["case-1", "case-2"]);
  const snapshotRoot = path.join(root, "snapshots");
  const engine = mockEngineLayer((request) => Effect.succeed(resultFor(request)));
  const layer = makeEvalServiceLayer({
    gatewayUrl: "http://127.0.0.1:8080/v1",
    snapshotRoot
  }).pipe(Layer.provide(engine), Layer.provide(NodeServicesLayer));

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
  await prepareSuites(root);
  const snapshotRoot = path.join(root, "snapshots");
  let runs = 0;
  const engine = mockEngineLayer((request) => {
    runs += 1;
    return runs === 1 ? Effect.succeed(resultFor(request)) : Effect.never;
  });
  const layer = makeEvalServiceLayer({
    gatewayUrl: "http://127.0.0.1:8080/v1",
    snapshotRoot
  }).pipe(Layer.provide(engine), Layer.provide(NodeServicesLayer));

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
