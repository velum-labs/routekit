import type {
  EvalComparisonRequest,
  EvalComparisonResult,
  PublishedRoutingActivation,
  RoutingActivationConstraints,
  RoutingBasis,
  RoutingObjectivePolicy
} from "@velum-labs/routekit-eval-contracts";
import {
  assertExplicitEvalModel,
  assertRoutingBasis,
  EvalRunManifest
} from "@velum-labs/routekit-eval-contracts";
import { EvalEngine, type EvalEngineValidation } from "@velum-labs/routekit-eval-engine";
import { makeRoutingActivationStore } from "@velum-labs/routekit-eval-store";
import {
  DEFAULT_MODEL_PRICING,
  PRICING_ALIASES,
  type RegistryModelPricing
} from "@velum-labs/routekit-registry";
import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect";

import {
  compileDimensionEvidenceMatrix,
  type DimensionComparisonEvidenceInput
} from "./dimension-evidence.js";
import {
  EvalServiceComparisonError,
  EvalServiceConfigurationError,
  EvalServiceEstimateError,
  EvalServicePolicyError,
  EvalServicePublicationError,
  EvalServiceSpendLimitError,
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

export type EvalRunConfiguration = {
  readonly concurrency?: number;
  readonly timeoutMs?: number;
};

export type EvalServiceConfiguration = {
  readonly gatewayUrl?: string;
  readonly snapshotRoot?: string;
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
  | EvalServiceEstimateError
  | EvalServicePolicyError
  | EvalServicePublicationError
  | EvalServiceSpendLimitError
  | EvalServiceValidationError;

export type EvalServiceShape = {
  readonly validate: (suitePath: string) => Effect.Effect<void, EvalServiceValidationError>;
  readonly inspect: (
    request: EvalComparisonRequest
  ) => Effect.Effect<EvalSuiteInspection, EvalServiceValidationError>;
  readonly estimate: (
    request: EvalComparisonRequest,
    mode: EvalComparisonMode
  ) => Effect.Effect<EvalComparisonEstimate, EvalServiceEstimateError | EvalServiceValidationError>;
  readonly runComparison: (
    request: EvalComparisonRequest,
    mode: EvalComparisonMode
  ) => Effect.Effect<
    EvalComparisonResult,
    EvalServiceComparisonError | EvalServiceSpendLimitError | EvalServiceValidationError
  >;
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

const validateGatewayUrl = (gatewayUrl: string): void => {
  const gateway = new URL(gatewayUrl);
  if (gateway.protocol !== "http:" && gateway.protocol !== "https:") {
    throw new Error("gatewayUrl must use http or https");
  }
  if (gateway.username.length > 0 || gateway.password.length > 0) {
    throw new Error("gatewayUrl must not contain credentials");
  }
};

const validateConfiguration = (
  configuration: EvalServiceConfiguration
): { readonly gatewayUrl: string; readonly snapshotRoot: string } => {
  if (configuration.gatewayUrl === undefined) {
    throw new Error("gatewayUrl is required for dimension matrix qualification");
  }
  validateGatewayUrl(configuration.gatewayUrl);
  if (configuration.snapshotRoot === undefined || configuration.snapshotRoot.trim().length === 0) {
    throw new Error("snapshotRoot is required for dimension matrix qualification");
  }
  validatePositiveOption("full.concurrency", configuration.full?.concurrency);
  validatePositiveOption("full.timeoutMs", configuration.full?.timeoutMs);
  return {
    gatewayUrl: configuration.gatewayUrl,
    snapshotRoot: configuration.snapshotRoot
  };
};

const sameStrings = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const validateDimensionMatrixInput = (
  configuration: EvalServiceConfiguration,
  input: DimensionMatrixQualificationInput
): {
  readonly gatewayUrl: string;
  readonly snapshotRoot: string;
  readonly suites: Map<string, DimensionMatrixSuite>;
} => {
  const validatedConfiguration = validateConfiguration(configuration);
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
  return { ...validatedConfiguration, suites };
};

const comparisonRequest = (
  configuration: EvalServiceConfiguration,
  gatewayUrl: string,
  input: DimensionMatrixQualificationInput,
  suite: DimensionMatrixSuite
): EvalComparisonRequest => ({
  version: 1,
  profileId: suite.dimensionId,
  suitePath: suite.suitePath,
  candidateModels: [...input.candidateModels],
  judgeModel: input.judgeModel,
  gatewayUrl,
  ...(configuration.full?.concurrency === undefined
    ? {}
    : { concurrency: configuration.full.concurrency }),
  ...(configuration.full?.timeoutMs === undefined
    ? {}
    : { timeoutMs: configuration.full.timeoutMs })
});

const MAXIMUM_INPUT_TOKENS_PER_CALL = 256 * 1024;

const modelPricing = (model: string): RegistryModelPricing | undefined => {
  const names = [model, model.includes("/") ? model.slice(model.indexOf("/") + 1) : model];
  for (const name of names) {
    const direct = Object.entries(DEFAULT_MODEL_PRICING).find(
      ([candidate]) => candidate.toLowerCase() === name.toLowerCase()
    )?.[1];
    if (direct !== undefined) return direct;
    const alias = Object.entries(PRICING_ALIASES).find(
      ([candidate]) => candidate.toLowerCase() === name.toLowerCase()
    )?.[1];
    if (alias === undefined) continue;
    const resolved = Object.entries(DEFAULT_MODEL_PRICING).find(
      ([candidate]) => candidate.toLowerCase() === alias.toLowerCase()
    )?.[1];
    if (resolved !== undefined) return resolved;
  }
  return undefined;
};

const maximumCallCost = (pricing: RegistryModelPricing, maximumOutputTokens: number): number =>
  (MAXIMUM_INPUT_TOKENS_PER_CALL * pricing.inputPer1mTokens +
    maximumOutputTokens * pricing.outputPer1mTokens) /
  1_000_000;

const estimateManifest = (manifest: EvalRunManifest): EvalComparisonEstimate => {
  const candidatePrices = manifest.candidateModels.map(modelPricing);
  const judgePrice = modelPricing(manifest.judgeModel);
  if (candidatePrices.some((pricing) => pricing === undefined) || judgePrice === undefined) {
    return {
      callCount: manifest.expectedCallCount,
      pricingKnown: false
    };
  }
  const candidateCost = candidatePrices.reduce(
    (total, pricing) =>
      total + manifest.caseCount * maximumCallCost(pricing!, manifest.maxOutputTokens),
    0
  );
  const judgeCost =
    manifest.caseCount *
    manifest.candidateModels.length *
    maximumCallCost(judgePrice, manifest.maxOutputTokens);
  return {
    callCount: manifest.expectedCallCount,
    maximumCostUsd: candidateCost + judgeCost,
    pricingKnown: true
  };
};

const enforceSpendLimit = (
  request: EvalComparisonRequest,
  manifest: EvalRunManifest
): Effect.Effect<void, EvalServiceSpendLimitError> => {
  if (request.spendLimitUsd === undefined) return Effect.void;
  const estimate = estimateManifest(manifest);
  if (!estimate.pricingKnown || estimate.maximumCostUsd === undefined) {
    return Effect.fail(
      new EvalServiceSpendLimitError({
        operation: "enforce the comparison spend limit",
        detail:
          "RouteKit Eval cannot enforce spendLimitUsd because pricing is unknown for one or more manifest models."
      })
    );
  }
  if (estimate.maximumCostUsd > request.spendLimitUsd) {
    return Effect.fail(
      new EvalServiceSpendLimitError({
        operation: "enforce the comparison spend limit",
        detail:
          `RouteKit Eval maximum estimated cost $${estimate.maximumCostUsd.toFixed(6)} ` +
          `exceeds spendLimitUsd $${request.spendLimitUsd.toFixed(6)}.`
      })
    );
  }
  return Effect.void;
};

const loadExecutionManifest = Effect.fn("EvalService.loadExecutionManifest")(function* (
  validation: EvalEngineValidation,
  request: EvalComparisonRequest
) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const manifests = yield* fs
    .glob("**/routekit.eval-manifest.json", {
      root: validation.workingDirectory
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new EvalServiceValidationError({
            operation: "discover the comparison manifest",
            detail: detailOf(cause),
            cause
          })
      )
    );
  if (manifests.length !== 1 || manifests[0] === undefined) {
    return yield* new EvalServiceValidationError({
      operation: "discover the comparison manifest",
      detail: "comparison requires exactly one routekit.eval-manifest.json"
    });
  }
  const manifestPath = paths.isAbsolute(manifests[0])
    ? manifests[0]
    : paths.join(validation.workingDirectory, manifests[0]);
  const raw = yield* fs.readFileString(manifestPath).pipe(
    Effect.mapError(
      (cause) =>
        new EvalServiceValidationError({
          operation: "read the comparison manifest",
          detail: detailOf(cause),
          cause
        })
    )
  );
  const json = yield* Effect.try({
    try: () => JSON.parse(raw) as unknown,
    catch: (cause) =>
      new EvalServiceValidationError({
        operation: "parse the comparison manifest",
        detail: "comparison manifest is not JSON",
        cause
      })
  });
  const manifest = yield* Schema.decodeUnknownEffect(EvalRunManifest)(json).pipe(
    Effect.mapError(
      (cause) =>
        new EvalServiceValidationError({
          operation: "decode the comparison manifest",
          detail: "comparison manifest is invalid",
          cause
        })
    )
  );
  if (
    manifest.profileId !== request.profileId ||
    !sameStrings(manifest.candidateModels, request.candidateModels) ||
    manifest.judgeModel !== request.judgeModel
  ) {
    return yield* new EvalServiceValidationError({
      operation: "bind the comparison manifest",
      detail: "comparison request profile or models do not match the authoritative manifest"
    });
  }
  if (
    manifest.profileId.trim().length === 0 ||
    manifest.caseCount < 1 ||
    manifest.caseIds.length !== manifest.caseCount ||
    new Set(manifest.caseIds).size !== manifest.caseIds.length ||
    manifest.caseIds.some((caseId) => caseId.trim().length === 0)
  ) {
    return yield* new EvalServiceValidationError({
      operation: "validate the comparison manifest cases",
      detail: "comparison manifest case identities are incomplete or duplicated"
    });
  }
  const expectedCallCount = manifest.caseCount * manifest.candidateModels.length * 2;
  if (manifest.expectedCallCount !== expectedCallCount || manifest.maxOutputTokens < 1) {
    return yield* new EvalServiceValidationError({
      operation: "validate the comparison manifest limits",
      detail: "comparison manifest call or output-token limits are inconsistent"
    });
  }
  return {
    suiteDigest: validation.suiteDigest,
    manifest
  } satisfies EvalSuiteInspection;
});

export const makeEvalService = (
  configuration: EvalServiceConfiguration = {}
): Effect.Effect<EvalService["Service"], never, EvalEngine | FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const engine = yield* EvalEngine;
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;

    const inspectRaw = Effect.fn("EvalService.inspectRaw")(function* (
      request: EvalComparisonRequest
    ) {
      const validation = yield* engine.validate(request.suitePath);
      return yield* loadExecutionManifest(validation, request).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, paths)
      );
    });

    const validate: EvalServiceShape["validate"] = Effect.fn("EvalService.validate")(
      function* (suitePath) {
        yield* engine.validate(suitePath).pipe(
          Effect.mapError(
            (cause) =>
              new EvalServiceValidationError({
                operation: "validate the comparison suite",
                detail: detailOf(cause),
                cause
              })
          )
        );
      }
    );

    const inspect: EvalServiceShape["inspect"] = (request) =>
      inspectRaw(request).pipe(
        Effect.mapError((cause) =>
          cause instanceof EvalServiceValidationError
            ? cause
            : new EvalServiceValidationError({
                operation: "inspect the comparison manifest",
                detail: detailOf(cause),
                cause
              })
        )
      );

    const estimate: EvalServiceShape["estimate"] = (request) =>
      inspectRaw(request).pipe(
        Effect.map((inspection) => estimateManifest(inspection.manifest)),
        Effect.mapError(
          (cause) =>
            new EvalServiceEstimateError({
              operation: "estimate the comparison",
              detail: detailOf(cause),
              cause
            })
        )
      );

    const runInspectedComparison = (
      request: EvalComparisonRequest,
      inspection: EvalSuiteInspection
    ) =>
      enforceSpendLimit(request, inspection.manifest).pipe(
        Effect.flatMap(() =>
          engine
            .runComparison({
              ...request,
              expectedCaseIds: [...inspection.manifest.caseIds],
              expectedCallCount: inspection.manifest.expectedCallCount,
              maxOutputTokens: inspection.manifest.maxOutputTokens,
              suiteDigest: inspection.suiteDigest
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new EvalServiceComparisonError({
                    operation: "run the comparison",
                    detail: detailOf(cause),
                    cause
                  })
              )
            )
        )
      );

    const runComparison: EvalServiceShape["runComparison"] = (request) =>
      inspect(request).pipe(
        Effect.flatMap((inspection) => runInspectedComparison(request, inspection))
      );

    const qualifyDimensionMatrix: EvalServiceShape["qualifyDimensionMatrix"] = (input) =>
      Effect.gen(function* () {
        const validated = yield* Effect.try({
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
          const suite = validated.suites.get(dimension.id)!;
          const request = comparisonRequest(configuration, validated.gatewayUrl, input, suite);
          const inspection = yield* inspect(request);
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
          const suite = validated.suites.get(dimension.id)!;
          const inspection = inspections.get(dimension.id)!;
          const request = comparisonRequest(configuration, validated.gatewayUrl, input, suite);
          const comparison = yield* runInspectedComparison(request, inspection);
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
        const snapshot = yield* makeRoutingActivationStore(validated.snapshotRoot)
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

    return EvalService.of({
      validate,
      inspect,
      estimate,
      runComparison,
      qualifyDimensionMatrix
    });
  });

export const makeEvalServiceLayer = (
  configuration: EvalServiceConfiguration = {}
): Layer.Layer<EvalService, never, EvalEngine | FileSystem.FileSystem | Path.Path> =>
  Layer.effect(EvalService, makeEvalService(configuration));
