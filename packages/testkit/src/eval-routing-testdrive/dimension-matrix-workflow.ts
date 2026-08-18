import { join } from "node:path";

import {
  type PublishedRoutingActivation,
  type RoutingBasis,
  type WorkloadDimension
} from "@velum-labs/routekit-eval-contracts";
import {
  EvalService,
  makeEvalComparisonRunnerLayer,
  makeEvalServiceLayer
} from "@velum-labs/routekit-eval-service";
import { Effect, FileSystem, Layer } from "effect";

import {
  type DimensionLivePlan,
  validateDimensionLivePlan
} from "../eval-routing-compositional/dimension-live-plan.js";
import {
  type ClassifierBenchmark,
  type RoutingBasisFixture,
  routingBasisFromFixture
} from "../eval-routing-compositional/qualification.js";
import {
  type TestdriveDimensionMatrixQualification,
  type TestdriveDimensionReport,
  TestdriveWorkflowError
} from "./contracts.js";
import { TestdriveEvidence } from "./evidence.js";
import { repositoryInventory } from "./repository-inventory.js";
import {
  TestdriveSuiteAuthor,
  type TestdriveDimensionAuthoringContext
} from "./suite-author.js";

export type TestdriveDimensionMatrixInput = Readonly<{
  repositoryRoot: string;
  gatewayUrl: string;
  bearerCredential: string;
  snapshotRoot: string;
  candidateModels: readonly string[];
  classifierModel: string;
  judgeModel: string;
}>;

export type TestdriveDimensionMatrixResult = Readonly<{
  qualification: TestdriveDimensionMatrixQualification;
  snapshot: PublishedRoutingActivation;
  probes: readonly Readonly<{ dimensionId: string; prompt: string }>[];
  compositeProbes: readonly Readonly<{ caseId: string; prompt: string }>[];
}>;

export type PendingTestdriveDimensionReport = Omit<TestdriveDimensionReport, "suiteDigest">;

/**
 * Bind retained dimension metadata to the authoritative digest produced by the
 * execution engine. Promotion also computes an artifact-copy digest, but that
 * is not the suite identity used by comparison evidence or the published
 * matrix.
 */
export function bindDimensionComparisonDigests(
  dimensions: readonly PendingTestdriveDimensionReport[],
  comparisons: readonly Readonly<{ profileId: string; suiteDigest: string }>[]
): readonly TestdriveDimensionReport[] {
  if (dimensions.length !== comparisons.length) {
    throw new Error("dimension metadata and comparison evidence counts do not match");
  }
  const expectedIds = new Set(dimensions.map((dimension) => dimension.dimensionId));
  const byDimension = new Map<string, string>();
  for (const comparison of comparisons) {
    if (
      !expectedIds.has(comparison.profileId) ||
      byDimension.has(comparison.profileId) ||
      comparison.suiteDigest.trim().length === 0
    ) {
      throw new Error("comparison evidence does not cover the expected dimensions exactly once");
    }
    byDimension.set(comparison.profileId, comparison.suiteDigest);
  }
  return dimensions.map((dimension) => {
    const suiteDigest = byDimension.get(dimension.dimensionId);
    if (suiteDigest === undefined) {
      throw new Error(`comparison evidence is missing ${JSON.stringify(dimension.dimensionId)}`);
    }
    return { ...dimension, suiteDigest };
  });
}

const parseJson = <A>(label: string, text: string): Effect.Effect<A, TestdriveWorkflowError> =>
  Effect.try({
    try: () => JSON.parse(text) as A,
    catch: (cause) =>
      new TestdriveWorkflowError({
        phase: "dimension-matrix",
        detail: `${label} is not valid JSON`,
        cause
      })
  });

const descriptionFor = (dimension: WorkloadDimension): string => dimension.description;

/**
 * Author, execute, retain, and publish one complete comparison suite for every
 * checked-in routing dimension. The EvalService performs a manifest-first inspection
 * of every suite before it starts any comparison and publishes only after the
 * complete candidate-by-dimension evidence matrix validates.
 */
export const runTestdriveDimensionMatrix = Effect.fn("EvalRoutingTestdrive.dimensionMatrix")(
  function* (input: TestdriveDimensionMatrixInput) {
    const fs = yield* FileSystem.FileSystem;
    const evidence = yield* TestdriveEvidence;
    const suiteAuthor = yield* TestdriveSuiteAuthor;
    const fixtureRoot = join(
      input.repositoryRoot,
      "packages",
      "testkit",
      "src",
      "eval-routing-compositional",
      "fixtures"
    );
    const [catalogText, planText, benchmarkText, inventory] = yield* Effect.all([
      fs.readFileString(join(fixtureRoot, "routing-basis.json")),
      fs.readFileString(join(fixtureRoot, "dimension-live-plan.json")),
      fs.readFileString(join(fixtureRoot, "decomposition-benchmark.json")),
      repositoryInventory(input.repositoryRoot).pipe(
        Effect.provideService(FileSystem.FileSystem, fs)
      )
    ]).pipe(
      Effect.mapError((cause) =>
        cause instanceof TestdriveWorkflowError
          ? cause
          : new TestdriveWorkflowError({
              phase: "dimension-matrix",
              detail: "failed to read checked-in dimension-matrix inputs",
              cause
            })
      )
    );
    const catalogFixture = yield* parseJson<RoutingBasisFixture>(
      "routing dimension basis",
      catalogText
    );
    const planFixture = yield* parseJson<unknown>("dimension live plan", planText);
    const benchmark = yield* parseJson<ClassifierBenchmark>("classifier benchmark", benchmarkText);
    const basis: RoutingBasis = yield* Effect.try({
      try: () => routingBasisFromFixture(catalogFixture),
      catch: (cause) =>
        new TestdriveWorkflowError({
          phase: "dimension-matrix",
          detail: "checked-in routing dimension basis is invalid",
          cause
        })
    });
    const plan: DimensionLivePlan = yield* Effect.try({
      try: () => validateDimensionLivePlan(planFixture, basis, inventory.files),
      catch: (cause) =>
        new TestdriveWorkflowError({
          phase: "dimension-matrix",
          detail: "checked-in dimension live plan is invalid",
          cause
        })
    });
    if (
      plan.basisId !== catalogFixture.basisId ||
      plan.basisVersion !== catalogFixture.basisVersion ||
      benchmark.basisDigest !== basis.basisDigest
    ) {
      return yield* new TestdriveWorkflowError({
        phase: "dimension-matrix",
        detail: "dimension live inputs do not identify the checked-in routing dimension basis"
      });
    }
    const compositeProbes = benchmark.cases
      .filter((entry) => entry.kind === "composite" && entry.id.startsWith("composite-"))
      .map((entry) => ({ caseId: entry.id, prompt: entry.request }));
    if (compositeProbes.length !== 4) {
      return yield* new TestdriveWorkflowError({
        phase: "dimension-matrix",
        detail: "classifier benchmark must retain exactly four cross-dimension live probes"
      });
    }

    yield* evidence.emit({
      type: "phase-started",
      phase: "dimension-matrix",
      status: "authoring"
    });
    const suites: Array<{ readonly dimensionId: string; readonly suitePath: string }> = [];
    const pendingDimensionReports: PendingTestdriveDimensionReport[] = [];
    for (const dimension of basis.dimensions) {
      const planned = plan.dimensions.find((entry) => entry.dimensionId === dimension.id);
      if (planned === undefined) {
        return yield* new TestdriveWorkflowError({
          phase: "dimension-matrix",
          detail: `dimension live plan is missing ${JSON.stringify(dimension.id)}`
        });
      }
      const authoringContext: TestdriveDimensionAuthoringContext = {
        id: dimension.id,
        description: descriptionFor(dimension),
        brief: planned.brief,
        probe: planned.probe,
        sourceFiles: [...planned.sourceFiles],
        sourceInventory: [...inventory.files]
      };
      const authored = yield* suiteAuthor.author({
        dimension: authoringContext,
        candidateModels: input.candidateModels,
        judgeModel: input.judgeModel,
        repositoryRoot: input.repositoryRoot
      });
      suites.push({
        dimensionId: dimension.id,
        suitePath: authored.evalPath
      });
      pendingDimensionReports.push({
        dimensionId: dimension.id,
        description: authoringContext.description,
        artifacts: {
          evalDirectory: `dimensions/${dimension.id}/eval`,
          manifestPath: `dimensions/${dimension.id}/eval/routekit.eval-manifest.json`,
          comparisonPath: `dimensions/${dimension.id}/comparison.json`
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
      return yield* (yield* EvalService).qualifyDimensionMatrix({
        basis,
        candidateModels: input.candidateModels,
        classifierModel: input.classifierModel,
        judgeModel: input.judgeModel,
        objective: { kind: "highest-quality" },
        maximumUnknownWeight: 0.2,
        suites
      });
    }).pipe(
      Effect.provide(serviceLayer),
      Effect.mapError(
        (cause) =>
          new TestdriveWorkflowError({
            phase: "dimension-matrix-comparison",
            detail: "complete model-by-dimension qualification failed",
            cause
          })
      )
    );
    const dimensionReports = yield* Effect.try({
      try: () => bindDimensionComparisonDigests(pendingDimensionReports, result.comparisons),
      catch: (cause) =>
        new TestdriveWorkflowError({
          phase: "dimension-matrix-evidence",
          detail: "comparison evidence does not cover every authored dimension exactly once",
          cause
        })
    });
    for (const comparison of result.comparisons) {
      yield* evidence.writeComparison(comparison.profileId, comparison);
      yield* evidence.emit({
        type: "comparison-finished",
        phase: "dimension-matrix",
        dimensionId: comparison.profileId,
        status: "complete",
        sampleCount: plan.casesPerDimension * input.candidateModels.length
      });
    }
    const qualification = yield* evidence.writeDimensionMatrixQualification({
      snapshot: result.snapshot,
      dimensions: dimensionReports,
      casesPerDimension: plan.casesPerDimension
    });
    yield* evidence.emit({
      type: "snapshot-published",
      phase: "dimension-matrix",
      status: "published"
    });
    yield* evidence.emit({
      type: "phase-finished",
      phase: "dimension-matrix",
      status: "passed"
    });
    return {
      qualification,
      snapshot: result.snapshot,
      probes: plan.dimensions.map((entry) => ({
        dimensionId: entry.dimensionId,
        prompt: entry.probe
      })),
      compositeProbes
    } satisfies TestdriveDimensionMatrixResult;
  }
);
