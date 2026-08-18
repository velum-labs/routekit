import type {
  EvalComparisonRequest,
  EvalComparisonResult,
  EvalRunManifest,
  PublishedRoutingActivation,
  RoutingActivationConstraints,
  RoutingBasis,
  RoutingObjectivePolicy
} from "@velum-labs/routekit-eval-contracts";
import { assertExplicitEvalModel, assertRoutingBasis } from "@velum-labs/routekit-eval-contracts";
import { makeRoutingActivationStore } from "@velum-labs/routekit-eval-store";
import { Context, Effect, FileSystem, Layer, Path } from "effect";

import {
  compileDimensionEvidenceMatrix,
  type DimensionComparisonEvidenceInput
} from "./dimension-evidence.js";
import {
  EvalServiceComparisonError,
  EvalServiceConfigurationError,
  EvalServicePolicyError,
  EvalServicePublicationError,
  EvalServiceValidationError
} from "./errors.js";

export type EvalComparisonMode = "pilot" | "full";

export type EvalSuiteInspection = {
  readonly suiteDigest: string;
  readonly manifest: EvalRunManifest;
};

export type EvalComparisonEstimate = {
  readonly callCount: number;
  readonly maximumCostUsd?: number;
  readonly pricingKnown: boolean;
};

export type EvalComparisonRunnerShape = {
  readonly validate: (suitePath: string) => Effect.Effect<void, unknown, never>;
  readonly inspect: (
    request: EvalComparisonRequest
  ) => Effect.Effect<EvalSuiteInspection, unknown, never>;
  readonly estimate: (
    request: EvalComparisonRequest,
    mode: EvalComparisonMode
  ) => Effect.Effect<EvalComparisonEstimate, unknown, never>;
  readonly runComparison: (
    request: EvalComparisonRequest,
    mode: EvalComparisonMode
  ) => Effect.Effect<EvalComparisonResult, unknown, never>;
};

export class EvalComparisonRunner extends Context.Service<
  EvalComparisonRunner,
  EvalComparisonRunnerShape
>()("@velum-labs/routekit-eval-service/EvalComparisonRunner") {
  static layer(service: EvalComparisonRunnerShape) {
    return Layer.succeed(EvalComparisonRunner, EvalComparisonRunner.of(service));
  }
}

export type EvalRunConfiguration = {
  readonly concurrency?: number;
  readonly timeoutMs?: number;
};

export type EvalServiceConfiguration = {
  readonly gatewayUrl: string;
  readonly snapshotRoot: string;
  readonly full?: EvalRunConfiguration;
};

export type DimensionMatrixSuite = {
  readonly dimensionId: string;
  readonly suitePath: string;
};

export type DimensionMatrixQualificationInput = {
  readonly basis: RoutingBasis;
  readonly candidateModels: ReadonlyArray<string>;
  readonly classifierModel: string;
  readonly judgeModel: string;
  readonly objective: RoutingObjectivePolicy;
  readonly maximumUnknownWeight: number;
  readonly constraints?: RoutingActivationConstraints;
  readonly suites: ReadonlyArray<DimensionMatrixSuite>;
};

export type DimensionMatrixQualificationResult = {
  readonly comparisons: ReadonlyArray<EvalComparisonResult>;
  readonly snapshot: PublishedRoutingActivation;
};

export type EvalServiceError =
  | EvalServiceComparisonError
  | EvalServiceConfigurationError
  | EvalServicePolicyError
  | EvalServicePublicationError
  | EvalServiceValidationError;

export type EvalServiceShape = {
  readonly qualifyDimensionMatrix: (
    input: DimensionMatrixQualificationInput
  ) => Effect.Effect<DimensionMatrixQualificationResult, EvalServiceError>;
};

export class EvalService extends Context.Service<EvalService, EvalServiceShape>()(
  "@velum-labs/routekit-eval-service/EvalService"
) {}

const detailOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const validatePositiveOption = (
  label: string,
  value: number | undefined,
  allowZero = false
): void => {
  if (value === undefined) return;
  if (!Number.isFinite(value) || (allowZero ? value < 0 : value < 1)) {
    throw new Error(`${label} must be ${allowZero ? "non-negative" : "at least 1"}`);
  }
};

const validateConfiguration = (configuration: EvalServiceConfiguration): void => {
  const gateway = new URL(configuration.gatewayUrl);
  if (gateway.protocol !== "http:" && gateway.protocol !== "https:") {
    throw new Error("gatewayUrl must use http or https");
  }
  if (gateway.username.length > 0 || gateway.password.length > 0) {
    throw new Error("gatewayUrl must not contain credentials");
  }
  if (configuration.snapshotRoot.trim().length === 0) {
    throw new Error("snapshotRoot must not be empty");
  }
  validatePositiveOption("full.concurrency", configuration.full?.concurrency);
  validatePositiveOption("full.timeoutMs", configuration.full?.timeoutMs);
};

const sameStrings = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const validateDimensionMatrixInput = (
  configuration: EvalServiceConfiguration,
  input: DimensionMatrixQualificationInput
): Map<string, DimensionMatrixSuite> => {
  validateConfiguration(configuration);
  assertRoutingBasis(input.basis);
  if (input.candidateModels.length < 2) {
    throw new Error("dimension matrix requires at least two candidate models");
  }
  if (new Set(input.candidateModels).size !== input.candidateModels.length) {
    throw new Error("dimension matrix candidate models must be unique");
  }
  for (const model of input.candidateModels) assertExplicitEvalModel(model, "candidate");
  assertExplicitEvalModel(input.classifierModel, "classifier");
  assertExplicitEvalModel(input.judgeModel, "judge");
  const expectedDimensions = new Set(input.basis.dimensions.map((dimension) => dimension.id));
  const suites = new Map<string, DimensionMatrixSuite>();
  for (const entry of input.suites) {
    if (!expectedDimensions.has(entry.dimensionId)) {
      throw new Error(
        `dimension matrix contains unknown dimension ${JSON.stringify(entry.dimensionId)}`
      );
    }
    if (suites.has(entry.dimensionId)) {
      throw new Error(
        `dimension matrix contains duplicate dimension ${JSON.stringify(entry.dimensionId)}`
      );
    }
    if (entry.suitePath.trim().length === 0) {
      throw new Error(
        `dimension matrix suite path is empty for ${JSON.stringify(entry.dimensionId)}`
      );
    }
    suites.set(entry.dimensionId, entry);
  }
  for (const dimensionId of expectedDimensions) {
    if (!suites.has(dimensionId)) {
      throw new Error(`dimension matrix is missing dimension ${JSON.stringify(dimensionId)}`);
    }
  }
  return suites;
};

const comparisonRequest = (
  configuration: EvalServiceConfiguration,
  input: DimensionMatrixQualificationInput,
  suite: DimensionMatrixSuite
): EvalComparisonRequest => ({
  version: 1,
  profileId: suite.dimensionId,
  suitePath: suite.suitePath,
  candidateModels: [...input.candidateModels],
  judgeModel: input.judgeModel,
  gatewayUrl: configuration.gatewayUrl,
  ...(configuration.full?.concurrency === undefined
    ? {}
    : { concurrency: configuration.full.concurrency }),
  ...(configuration.full?.timeoutMs === undefined
    ? {}
    : { timeoutMs: configuration.full.timeoutMs })
});

export const makeEvalService = (
  configuration: EvalServiceConfiguration
): Effect.Effect<
  EvalService["Service"],
  never,
  EvalComparisonRunner | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const runner = yield* EvalComparisonRunner;
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const activationStore = makeRoutingActivationStore(configuration.snapshotRoot);

    const qualifyDimensionMatrix: EvalServiceShape["qualifyDimensionMatrix"] = (input) =>
      Effect.gen(function* () {
        const suites = yield* Effect.try({
          try: () => validateDimensionMatrixInput(configuration, input),
          catch: (cause) =>
            new EvalServiceConfigurationError({
              operation: "validate the dimension matrix qualification",
              detail: detailOf(cause),
              cause
            })
        });
        const inspections = new Map<string, EvalSuiteInspection>();
        for (const dimension of input.basis.dimensions) {
          const suite = suites.get(dimension.id)!;
          const request = comparisonRequest(configuration, input, suite);
          const inspection = yield* runner.inspect(request).pipe(
            Effect.mapError(
              (cause) =>
                new EvalServiceValidationError({
                  operation: "inspect the full comparison manifest",
                  detail: detailOf(cause),
                  cause
                })
            )
          );
          if (
            inspection.manifest.profileId !== dimension.id ||
            inspection.manifest.judgeModel !== input.judgeModel ||
            !sameStrings(inspection.manifest.candidateModels, input.candidateModels)
          ) {
            return yield* new EvalServiceValidationError({
              operation: "inspect the full comparison manifest",
              detail: `authoritative manifest does not match dimension ${JSON.stringify(dimension.id)}`
            });
          }
          inspections.set(dimension.id, inspection);
        }

        const comparisons: EvalComparisonResult[] = [];
        const evidenceInputs: DimensionComparisonEvidenceInput[] = [];
        for (const dimension of input.basis.dimensions) {
          const suite = suites.get(dimension.id)!;
          const inspection = inspections.get(dimension.id)!;
          const request = comparisonRequest(configuration, input, suite);
          const comparison = yield* runner.runComparison(request, "full").pipe(
            Effect.mapError(
              (cause) =>
                new EvalServiceComparisonError({
                  operation: "run the full comparison",
                  detail: detailOf(cause),
                  cause
                })
            )
          );
          if (
            comparison.profileId !== dimension.id ||
            comparison.judgeModel !== input.judgeModel ||
            comparison.suiteDigest !== inspection.suiteDigest
          ) {
            return yield* new EvalServiceComparisonError({
              operation: "validate the full comparison",
              detail: `comparison identity does not match dimension ${JSON.stringify(dimension.id)}`
            });
          }
          comparisons.push(comparison);
          evidenceInputs.push({
            dimensionId: dimension.id,
            suiteDigest: inspection.suiteDigest,
            judgeModel: inspection.manifest.judgeModel,
            expectedCaseIds: inspection.manifest.caseIds,
            comparison
          });
        }

        const compiled = yield* Effect.try({
          try: () =>
            compileDimensionEvidenceMatrix({
              basis: input.basis,
              candidateModels: input.candidateModels,
              comparisons: evidenceInputs
            }),
          catch: (cause) =>
            new EvalServicePolicyError({
              operation: "compile the dimension evidence matrix",
              detail: detailOf(cause),
              cause
            })
        });
        const snapshot = yield* activationStore
          .publish({
            basisDigest: input.basis.basisDigest,
            evidenceDigest: compiled.evidenceDigest,
            classifierModel: input.classifierModel,
            objective: input.objective,
            maximumUnknownWeight: input.maximumUnknownWeight,
            ...(input.constraints === undefined ? {} : { constraints: input.constraints }),
            dimensions: [...input.basis.dimensions],
            candidateModels: [...input.candidateModels],
            evidence: [...compiled.evidence]
          })
          .pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, paths),
            Effect.mapError(
              (cause) =>
                new EvalServicePublicationError({
                  operation: "publish the dimension evidence snapshot",
                  detail: detailOf(cause),
                  cause
                })
            )
          );
        return { comparisons, snapshot };
      });

    return EvalService.of({ qualifyDimensionMatrix });
  });

export const makeEvalServiceLayer = (
  configuration: EvalServiceConfiguration
): Layer.Layer<EvalService, never, EvalComparisonRunner | FileSystem.FileSystem | Path.Path> =>
  Layer.effect(EvalService, makeEvalService(configuration));
