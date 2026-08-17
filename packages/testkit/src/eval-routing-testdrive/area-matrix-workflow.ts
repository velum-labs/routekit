import { join } from "node:path";

import {
  type PublishedRoutingSnapshotV2,
  type RoutingAreaCatalog,
  type RoutingAreaDefinition
} from "@velum-labs/routekit-eval-contracts";
import {
  EvalService,
  makeEvalComparisonRunnerLayer,
  makeEvalServiceLayer,
  promoteOriAuthoredArtifacts
} from "@velum-labs/routekit-eval-service";
import type { ScaffoldResult } from "@velum-labs/routekit-eval-setup";
import { Effect, FileSystem, Layer } from "effect";

import { type AreaLivePlan, validateAreaLivePlan } from "../eval-routing-v2/area-live-plan.js";
import {
  type ClassifierBenchmark,
  type RoutingAreaCatalogFixture,
  routingAreaCatalogFromFixture
} from "../eval-routing-v2/qualification.js";
import {
  type TestdriveAreaMatrixQualification,
  type TestdriveAreaReport,
  TestdriveWorkflowError
} from "./contracts.js";
import { TestdriveEvidence } from "./evidence.js";
import { type DiscoveredRoutingProfile, repositoryInventory } from "./profile-discovery.js";
import { TestdriveSuiteAuthor } from "./suite-author.js";

export type TestdriveAreaMatrixInput = Readonly<{
  repositoryRoot: string;
  gatewayUrl: string;
  bearerCredential: string;
  snapshotRoot: string;
  candidateModels: readonly string[];
  judgeModel: string;
}>;

export type TestdriveAreaMatrixResult = Readonly<{
  qualification: TestdriveAreaMatrixQualification;
  snapshot: PublishedRoutingSnapshotV2;
  probes: readonly Readonly<{ areaId: string; prompt: string }>[];
  compositeProbes: readonly Readonly<{ caseId: string; prompt: string }>[];
}>;

export type PendingTestdriveAreaReport = Omit<TestdriveAreaReport, "suiteDigest">;

/**
 * Bind retained area metadata to the authoritative digest produced by the
 * execution engine. Promotion also computes an artifact-copy digest, but that
 * is not the suite identity used by comparison evidence or the published
 * matrix.
 */
export function bindAreaComparisonDigests(
  areas: readonly PendingTestdriveAreaReport[],
  comparisons: readonly Readonly<{ profileId: string; suiteDigest: string }>[]
): readonly TestdriveAreaReport[] {
  if (areas.length !== comparisons.length) {
    throw new Error("area metadata and comparison evidence counts do not match");
  }
  const expectedIds = new Set(areas.map((area) => area.areaId));
  const byArea = new Map<string, string>();
  for (const comparison of comparisons) {
    if (
      !expectedIds.has(comparison.profileId) ||
      byArea.has(comparison.profileId) ||
      comparison.suiteDigest.trim().length === 0
    ) {
      throw new Error("comparison evidence does not cover the expected areas exactly once");
    }
    byArea.set(comparison.profileId, comparison.suiteDigest);
  }
  return areas.map((area) => {
    const suiteDigest = byArea.get(area.areaId);
    if (suiteDigest === undefined) {
      throw new Error(`comparison evidence is missing ${JSON.stringify(area.areaId)}`);
    }
    return { ...area, suiteDigest };
  });
}

const parseJson = <A>(label: string, text: string): Effect.Effect<A, TestdriveWorkflowError> =>
  Effect.try({
    try: () => JSON.parse(text) as A,
    catch: (cause) =>
      new TestdriveWorkflowError({
        phase: "area-matrix",
        detail: `${label} is not valid JSON`,
        cause
      })
  });

const descriptionFor = (area: RoutingAreaDefinition): string => area.description;

/**
 * Author, execute, retain, and publish one complete comparison suite for every
 * checked-in routing area. The EvalService performs a manifest-first inspection
 * of every suite before it starts any comparison and publishes only after the
 * complete candidate-by-area evidence matrix validates.
 */
export const runTestdriveAreaMatrix = Effect.fn("EvalRoutingTestdrive.areaMatrix")(function* (
  input: TestdriveAreaMatrixInput
) {
  const fs = yield* FileSystem.FileSystem;
  const evidence = yield* TestdriveEvidence;
  const suiteAuthor = yield* TestdriveSuiteAuthor;
  const fixtureRoot = join(
    input.repositoryRoot,
    "packages",
    "testkit",
    "src",
    "eval-routing-v2",
    "fixtures"
  );
  const [catalogText, planText, benchmarkText, inventory] = yield* Effect.all([
    fs.readFileString(join(fixtureRoot, "routekit-area-catalog.v1.json")),
    fs.readFileString(join(fixtureRoot, "area-live-plan.v1.json")),
    fs.readFileString(join(fixtureRoot, "classifier-benchmark.v1.json")),
    repositoryInventory(input.repositoryRoot).pipe(Effect.provideService(FileSystem.FileSystem, fs))
  ]).pipe(
    Effect.mapError((cause) =>
      cause instanceof TestdriveWorkflowError
        ? cause
        : new TestdriveWorkflowError({
            phase: "area-matrix",
            detail: "failed to read checked-in area-matrix inputs",
            cause
          })
    )
  );
  const catalogFixture = yield* parseJson<RoutingAreaCatalogFixture>(
    "routing area catalog",
    catalogText
  );
  const planFixture = yield* parseJson<unknown>("area live plan", planText);
  const benchmark = yield* parseJson<ClassifierBenchmark>("classifier benchmark", benchmarkText);
  const catalog: RoutingAreaCatalog = yield* Effect.try({
    try: () => routingAreaCatalogFromFixture(catalogFixture),
    catch: (cause) =>
      new TestdriveWorkflowError({
        phase: "area-matrix",
        detail: "checked-in routing area catalog is invalid",
        cause
      })
  });
  const plan: AreaLivePlan = yield* Effect.try({
    try: () => validateAreaLivePlan(planFixture, catalog, inventory.files),
    catch: (cause) =>
      new TestdriveWorkflowError({
        phase: "area-matrix",
        detail: "checked-in area live plan is invalid",
        cause
      })
  });
  if (
    plan.catalogId !== catalogFixture.catalogId ||
    plan.catalogVersion !== catalogFixture.catalogVersion ||
    benchmark.definitionSetDigest !== catalog.definitionSetDigest
  ) {
    return yield* new TestdriveWorkflowError({
      phase: "area-matrix",
      detail: "area live inputs do not identify the checked-in routing area catalog"
    });
  }
  const compositeProbes = benchmark.cases
    .filter((entry) => entry.kind === "composite" && entry.id.startsWith("composite-"))
    .map((entry) => ({ caseId: entry.id, prompt: entry.request }));
  if (compositeProbes.length !== 4) {
    return yield* new TestdriveWorkflowError({
      phase: "area-matrix",
      detail: "classifier benchmark must retain exactly four cross-area live probes"
    });
  }

  yield* evidence.emit({
    type: "phase-started",
    phase: "area-matrix",
    status: "authoring"
  });
  const suites: Array<{ readonly areaId: string; readonly scaffold: ScaffoldResult }> = [];
  const pendingAreaReports: PendingTestdriveAreaReport[] = [];
  for (const area of catalog.areas) {
    const planned = plan.areas.find((entry) => entry.areaId === area.id);
    if (planned === undefined) {
      return yield* new TestdriveWorkflowError({
        phase: "area-matrix",
        detail: `area live plan is missing ${JSON.stringify(area.id)}`
      });
    }
    const profile: DiscoveredRoutingProfile = {
      id: area.id,
      description: descriptionFor(area),
      brief: planned.brief,
      probe: planned.probe,
      sourceFiles: [...planned.sourceFiles],
      sourceInventory: [...inventory.files]
    };
    const authored = yield* suiteAuthor.author({
      profile,
      candidateModels: input.candidateModels,
      judgeModel: input.judgeModel,
      repositoryRoot: input.repositoryRoot,
      artifactScope: "areas"
    });
    const promoted = yield* promoteOriAuthoredArtifacts({
      profileId: area.id,
      description: profile.description,
      repositoryRoot: input.repositoryRoot,
      result: authored
    }).pipe(
      Effect.mapError(
        (cause) =>
          new TestdriveWorkflowError({
            phase: "area-matrix-promotion",
            detail: `failed to promote authored suite for ${JSON.stringify(area.id)}`,
            cause
          })
      )
    );
    suites.push({
      areaId: area.id,
      scaffold: {
        evalPath: promoted.evalPath,
        profilePath: promoted.profilePath,
        profile: promoted.profile
      }
    });
    pendingAreaReports.push({
      areaId: area.id,
      description: profile.description,
      artifacts: {
        evalDirectory: `areas/${area.id}/eval`,
        routingProfilePath: `areas/${area.id}/routing-profile.yaml`,
        comparisonPath: `areas/${area.id}/comparison.json`
      }
    });
  }

  const serviceLayer = makeEvalServiceLayer({
    gatewayUrl: input.gatewayUrl,
    snapshotRoot: input.snapshotRoot,
    full: { concurrency: 4, timeoutMs: 300_000 }
  }).pipe(
    Layer.provide(
      makeEvalComparisonRunnerLayer({
        bearerCredential: input.bearerCredential
      })
    )
  );
  const result = yield* Effect.gen(function* () {
    return yield* (yield* EvalService).qualifyAreaMatrix({
      catalog,
      candidateModels: input.candidateModels,
      judgeModel: input.judgeModel,
      suites
    });
  }).pipe(
    Effect.provide(serviceLayer),
    Effect.mapError(
      (cause) =>
        new TestdriveWorkflowError({
          phase: "area-matrix-comparison",
          detail: "complete model-by-area qualification failed",
          cause
      })
    )
  );
  const areaReports = yield* Effect.try({
    try: () => bindAreaComparisonDigests(pendingAreaReports, result.comparisons),
    catch: (cause) =>
      new TestdriveWorkflowError({
        phase: "area-matrix-evidence",
        detail: "comparison evidence does not cover every authored area exactly once",
        cause
      })
  });
  for (const comparison of result.comparisons) {
    yield* evidence.writeComparison(comparison.profileId, comparison, "areas");
    yield* evidence.emit({
      type: "comparison-finished",
      phase: "area-matrix",
      profileId: comparison.profileId,
      status: "complete",
      sampleCount: plan.casesPerArea * input.candidateModels.length
    });
  }
  const qualification = yield* evidence.writeAreaMatrixQualification({
    snapshot: result.snapshot,
    areas: areaReports,
    casesPerArea: plan.casesPerArea
  });
  yield* evidence.emit({
    type: "snapshot-published",
    phase: "area-matrix",
    status: "published"
  });
  yield* evidence.emit({
    type: "phase-finished",
    phase: "area-matrix",
    status: "passed"
  });
  return {
    qualification,
    snapshot: result.snapshot,
    probes: plan.areas.map((entry) => ({
      areaId: entry.areaId,
      prompt: entry.probe
    })),
    compositeProbes
  } satisfies TestdriveAreaMatrixResult;
});
