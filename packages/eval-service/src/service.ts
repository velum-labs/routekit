import type {
  CompiledRoutingPolicy,
  EvalComparisonRequest,
  EvalComparisonResult,
  EvalRunManifest,
  PublishedRoutingSnapshot,
  PublishedRoutingSnapshotV2,
  RoutingAreaCatalog
} from "@velum-labs/routekit-eval-contracts";
import {
  assertRoutingAreaCatalog,
  assertRoutingProfile
} from "@velum-labs/routekit-eval-contracts";
import { compileRoutingPolicy } from "@velum-labs/routekit-eval-core";
import { type ScaffoldResult, type SetupEstimate } from "@velum-labs/routekit-eval-setup";
import {
  makeRoutingSnapshotStore,
  makeRoutingSnapshotStoreV2
} from "@velum-labs/routekit-eval-store";
import { Context, Effect, FileSystem, Layer, Path } from "effect";

import {
  type AreaComparisonEvidenceInput,
  compileAreaEvidenceMatrix
} from "./area-evidence.js";
import {
  EvalServiceComparisonError,
  EvalServiceConfigurationError,
  EvalServiceEstimateError,
  EvalServicePolicyError,
  EvalServicePublicationError,
  EvalServiceValidationError
} from "./errors.js";

export type EvalComparisonMode = "pilot" | "full";

export type EvalSuiteInspection = {
  readonly suiteDigest: string;
  readonly manifest: EvalRunManifest;
};

export type EvalComparisonRunnerShape = {
  /** Validate/dry-load the suite without executing its test bodies. */
  readonly validate: (suitePath: string) => Effect.Effect<void, unknown>;
  /** Read the authoritative manifest and bind it to the validated suite digest. */
  readonly inspect: (
    request: EvalComparisonRequest
  ) => Effect.Effect<EvalSuiteInspection, unknown>;
  /** Estimate calls and spend without making candidate or judge calls. */
  readonly estimate: (
    request: EvalComparisonRequest,
    mode: EvalComparisonMode
  ) => Effect.Effect<SetupEstimate, unknown>;
  /** Execute the comparison in-process through the injected engine adapter. */
  readonly runComparison: (
    request: EvalComparisonRequest,
    mode: EvalComparisonMode
  ) => Effect.Effect<EvalComparisonResult, unknown>;
};

/**
 * RouteKit-Effect boundary around the copied eval engine. The adapter may bridge
 * the engine's temporary Effect beta internally, but every operation exposed to
 * this package uses RouteKit's catalog-pinned Effect.
 */
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
  readonly spendLimitUsd?: number;
};

export type EvalServiceConfiguration = {
  readonly gatewayUrl: string;
  readonly snapshotRoot: string;
  readonly pilot?: EvalRunConfiguration;
  readonly full?: EvalRunConfiguration;
};

export type AreaMatrixSuite = {
  readonly areaId: string;
  readonly scaffold: ScaffoldResult;
};

export type AreaMatrixQualificationInput = {
  readonly catalog: RoutingAreaCatalog;
  readonly candidateModels: ReadonlyArray<string>;
  readonly judgeModel: string;
  readonly suites: ReadonlyArray<AreaMatrixSuite>;
};

export type AreaMatrixQualificationResult = {
  readonly comparisons: ReadonlyArray<EvalComparisonResult>;
  readonly snapshot: PublishedRoutingSnapshotV2;
};

export type EvalServiceError =
  | EvalServiceComparisonError
  | EvalServiceConfigurationError
  | EvalServiceEstimateError
  | EvalServicePolicyError
  | EvalServicePublicationError
  | EvalServiceValidationError;

export type EvalServiceShape = {
  readonly validate: (
    input: ScaffoldResult
  ) => Effect.Effect<void, EvalServiceConfigurationError | EvalServiceValidationError>;
  readonly estimate: (
    input: ScaffoldResult,
    mode: EvalComparisonMode
  ) => Effect.Effect<SetupEstimate, EvalServiceConfigurationError | EvalServiceEstimateError>;
  readonly inspect: (
    input: ScaffoldResult,
    mode: EvalComparisonMode
  ) => Effect.Effect<
    EvalSuiteInspection,
    EvalServiceConfigurationError | EvalServiceValidationError
  >;
  readonly runPilot: (
    input: ScaffoldResult
  ) => Effect.Effect<
    EvalComparisonResult,
    EvalServiceConfigurationError | EvalServiceComparisonError
  >;
  readonly runFull: (
    input: ScaffoldResult
  ) => Effect.Effect<
    EvalComparisonResult,
    EvalServiceConfigurationError | EvalServiceComparisonError
  >;
  readonly propose: (
    input: ScaffoldResult,
    comparison: EvalComparisonResult
  ) => Effect.Effect<CompiledRoutingPolicy, EvalServicePolicyError>;
  readonly publish: (
    policy: CompiledRoutingPolicy
  ) => Effect.Effect<PublishedRoutingSnapshot, EvalServicePublicationError>;
  readonly qualifyAreaMatrix: (
    input: AreaMatrixQualificationInput
  ) => Effect.Effect<AreaMatrixQualificationResult, EvalServiceError>;
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
  for (const [mode, settings] of [
    ["pilot", configuration.pilot],
    ["full", configuration.full]
  ] as const) {
    validatePositiveOption(`${mode}.concurrency`, settings?.concurrency);
    validatePositiveOption(`${mode}.timeoutMs`, settings?.timeoutMs);
    validatePositiveOption(`${mode}.spendLimitUsd`, settings?.spendLimitUsd, true);
  }
};

const validateInput = (
  configuration: EvalServiceConfiguration,
  input: ScaffoldResult
): Effect.Effect<void, EvalServiceConfigurationError> =>
  Effect.try({
    try: () => {
      validateConfiguration(configuration);
      assertRoutingProfile(input.profile);
      if (input.evalPath.trim().length === 0) throw new Error("evalPath must not be empty");
    },
    catch: (cause) =>
      new EvalServiceConfigurationError({
        operation: "validate configuration",
        detail: detailOf(cause),
        cause
      })
  });

const comparisonRequest = (
  configuration: EvalServiceConfiguration,
  input: ScaffoldResult,
  mode: EvalComparisonMode
): EvalComparisonRequest => {
  const run = configuration[mode];
  return {
    version: 1,
    profileId: input.profile.id,
    suitePath: input.evalPath,
    candidateModels: [...input.profile.candidates],
    judgeModel: input.profile.judge,
    gatewayUrl: configuration.gatewayUrl,
    ...(run?.concurrency === undefined ? {} : { concurrency: run.concurrency }),
    ...(run?.timeoutMs === undefined ? {} : { timeoutMs: run.timeoutMs }),
    ...(run?.spendLimitUsd === undefined ? {} : { spendLimitUsd: run.spendLimitUsd })
  };
};

const validateComparison = (input: ScaffoldResult, comparison: EvalComparisonResult): void => {
  if (comparison.profileId !== input.profile.id) {
    throw new Error(
      `comparison profile ${JSON.stringify(comparison.profileId)} does not match ${JSON.stringify(input.profile.id)}`
    );
  }
  if (comparison.judgeModel !== input.profile.judge) {
    throw new Error(
      `comparison judge ${JSON.stringify(comparison.judgeModel)} does not match ${JSON.stringify(input.profile.judge)}`
    );
  }
  const expected = new Set(input.profile.candidates);
  const seen = new Set<string>();
  for (const result of comparison.models) {
    if (!expected.has(result.model)) {
      throw new Error(`comparison contains unexpected model ${JSON.stringify(result.model)}`);
    }
    if (seen.has(result.model)) {
      throw new Error(`comparison contains duplicate model ${JSON.stringify(result.model)}`);
    }
    seen.add(result.model);
  }
  if (comparison.suiteDigest.trim().length === 0) {
    throw new Error("comparison suiteDigest must not be empty");
  }
};

const sameStrings = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const validateAreaMatrixInput = (
  configuration: EvalServiceConfiguration,
  input: AreaMatrixQualificationInput
): Map<string, ScaffoldResult> => {
  validateConfiguration(configuration);
  assertRoutingAreaCatalog(input.catalog);
  if (input.candidateModels.length === 0) {
    throw new Error("area matrix candidate model list must not be empty");
  }
  if (input.judgeModel.trim().length === 0) {
    throw new Error("area matrix judge model must not be empty");
  }
  const expectedAreas = new Set(input.catalog.areas.map((area) => area.id));
  const suites = new Map<string, ScaffoldResult>();
  for (const entry of input.suites) {
    assertRoutingProfile(entry.scaffold.profile);
    if (entry.scaffold.evalPath.trim().length === 0) {
      throw new Error(`area matrix suite path is empty for ${JSON.stringify(entry.areaId)}`);
    }
    if (!expectedAreas.has(entry.areaId)) {
      throw new Error(`area matrix contains unknown area ${JSON.stringify(entry.areaId)}`);
    }
    if (suites.has(entry.areaId)) {
      throw new Error(`area matrix contains duplicate area ${JSON.stringify(entry.areaId)}`);
    }
    if (entry.scaffold.profile.id !== entry.areaId) {
      throw new Error(
        `area matrix suite profile ${JSON.stringify(
          entry.scaffold.profile.id
        )} does not match area ${JSON.stringify(entry.areaId)}`
      );
    }
    if (!sameStrings(entry.scaffold.profile.candidates, input.candidateModels)) {
      throw new Error(
        `area matrix candidates do not match area ${JSON.stringify(entry.areaId)}`
      );
    }
    if (entry.scaffold.profile.judge !== input.judgeModel) {
      throw new Error(`area matrix judge does not match area ${JSON.stringify(entry.areaId)}`);
    }
    suites.set(entry.areaId, entry.scaffold);
  }
  for (const areaId of expectedAreas) {
    if (!suites.has(areaId)) {
      throw new Error(`area matrix is missing area ${JSON.stringify(areaId)}`);
    }
  }
  return suites;
};

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
    const snapshotStore = makeRoutingSnapshotStore(configuration.snapshotRoot);
    const snapshotStoreV2 = makeRoutingSnapshotStoreV2(configuration.snapshotRoot);

    const validate: EvalServiceShape["validate"] = (input) =>
      validateInput(configuration, input).pipe(
        Effect.andThen(runner.validate(input.evalPath)),
        Effect.mapError((cause) =>
          cause instanceof EvalServiceConfigurationError
            ? cause
            : new EvalServiceValidationError({
                operation: "validate the generated suite",
                detail: detailOf(cause),
                cause
              })
        )
      );

    const estimate: EvalServiceShape["estimate"] = (input, mode) =>
      validateInput(configuration, input).pipe(
        Effect.andThen(runner.estimate(comparisonRequest(configuration, input, mode), mode)),
        Effect.mapError((cause) =>
          cause instanceof EvalServiceConfigurationError
            ? cause
            : new EvalServiceEstimateError({
                operation: `estimate the ${mode} comparison`,
                detail: detailOf(cause),
                cause
              })
        )
      );

    const inspect: EvalServiceShape["inspect"] = (input, mode) =>
      validateInput(configuration, input).pipe(
        Effect.andThen(runner.inspect(comparisonRequest(configuration, input, mode))),
        Effect.mapError((cause) =>
          cause instanceof EvalServiceConfigurationError
            ? cause
            : new EvalServiceValidationError({
                operation: `inspect the ${mode} comparison manifest`,
                detail: detailOf(cause),
                cause
              })
        )
      );

    const run = (
      input: ScaffoldResult,
      mode: EvalComparisonMode
    ): Effect.Effect<
      EvalComparisonResult,
      EvalServiceConfigurationError | EvalServiceComparisonError
    > =>
      validateInput(configuration, input).pipe(
        Effect.andThen(runner.runComparison(comparisonRequest(configuration, input, mode), mode)),
        Effect.flatMap((comparison) =>
          Effect.try({
            try: () => {
              validateComparison(input, comparison);
              return comparison;
            },
            catch: (cause) =>
              new EvalServiceComparisonError({
                operation: `validate the ${mode} comparison`,
                detail: detailOf(cause),
                cause
              })
          })
        ),
        Effect.mapError((cause) =>
          cause instanceof EvalServiceConfigurationError ||
          cause instanceof EvalServiceComparisonError
            ? cause
            : new EvalServiceComparisonError({
                operation: `run the ${mode} comparison`,
                detail: detailOf(cause),
                cause
              })
        )
      );

    const propose: EvalServiceShape["propose"] = (input, comparison) =>
      Effect.try({
        try: () => {
          assertRoutingProfile(input.profile);
          validateComparison(input, comparison);
          return compileRoutingPolicy(input.profile, comparison);
        },
        catch: (cause) =>
          new EvalServicePolicyError({
            operation: "compile the routing policy",
            detail: detailOf(cause),
            cause
          })
      });

    const publish: EvalServiceShape["publish"] = (policy) =>
      snapshotStore.publish(policy).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, paths),
        Effect.mapError(
          (cause) =>
            new EvalServicePublicationError({
              operation: "publish the routing snapshot",
              detail: detailOf(cause),
              cause
            })
        )
      );

    const qualifyAreaMatrix: EvalServiceShape["qualifyAreaMatrix"] = (input) =>
      Effect.gen(function* () {
        const suites = yield* Effect.try({
          try: () => validateAreaMatrixInput(configuration, input),
          catch: (cause) =>
            new EvalServiceConfigurationError({
              operation: "validate the area matrix qualification",
              detail: detailOf(cause),
              cause
            })
        });
        const comparisons: EvalComparisonResult[] = [];
        const evidenceInputs: AreaComparisonEvidenceInput[] = [];
        const inspections = new Map<string, EvalSuiteInspection>();
        for (const area of input.catalog.areas) {
          const scaffold = suites.get(area.id)!;
          const inspection = yield* inspect(scaffold, "full");
          if (
            inspection.manifest.profileId !== area.id ||
            inspection.manifest.judgeModel !== input.judgeModel ||
            !sameStrings(inspection.manifest.candidateModels, input.candidateModels)
          ) {
            return yield* new EvalServiceValidationError({
              operation: "inspect the full comparison manifest",
              detail: `authoritative manifest does not match area ${JSON.stringify(area.id)}`
            });
          }
          inspections.set(area.id, inspection);
        }
        for (const area of input.catalog.areas) {
          const scaffold = suites.get(area.id)!;
          const inspection = inspections.get(area.id)!;
          const comparison = yield* run(scaffold, "full");
          comparisons.push(comparison);
          evidenceInputs.push({
            areaId: area.id,
            suiteDigest: inspection.suiteDigest,
            judgeModel: inspection.manifest.judgeModel,
            expectedCaseIds: inspection.manifest.caseIds,
            comparison
          });
        }
        const compiled = yield* Effect.try({
          try: () =>
            compileAreaEvidenceMatrix({
              catalog: input.catalog,
              candidateModels: input.candidateModels,
              comparisons: evidenceInputs
            }),
          catch: (cause) =>
            new EvalServicePolicyError({
              operation: "compile the area evidence matrix",
              detail: detailOf(cause),
              cause
            })
        });
        const snapshot = yield* snapshotStoreV2
          .publish({
            definitionSetDigest: input.catalog.definitionSetDigest,
            evidenceDigest: compiled.evidenceDigest,
            areas: [...input.catalog.areas],
            candidateModels: [...input.candidateModels],
            evidence: [...compiled.evidence]
          })
          .pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, paths),
            Effect.mapError(
              (cause) =>
                new EvalServicePublicationError({
                  operation: "publish the area evidence snapshot",
                  detail: detailOf(cause),
                  cause
                })
            )
          );
        return { comparisons, snapshot };
      });

    return EvalService.of({
      validate,
      estimate,
      inspect,
      runPilot: (input) => run(input, "pilot"),
      runFull: (input) => run(input, "full"),
      propose,
      publish,
      qualifyAreaMatrix
    });
  });

export const makeEvalServiceLayer = (
  configuration: EvalServiceConfiguration
): Layer.Layer<EvalService, never, EvalComparisonRunner | FileSystem.FileSystem | Path.Path> =>
  Layer.effect(EvalService, makeEvalService(configuration));
