import type {
  CompiledRoutingPolicy,
  EvalComparisonRequest,
  EvalComparisonResult,
  PublishedRoutingSnapshot
} from "@velum-labs/routekit-eval-contracts";
import { assertRoutingProfile } from "@velum-labs/routekit-eval-contracts";
import { compileRoutingPolicy } from "@velum-labs/routekit-eval-core";
import {
  EvalSetupRunner,
  EvalSetupRunnerError,
  type ScaffoldResult,
  type SetupEstimate
} from "@velum-labs/routekit-eval-setup";
import { makeRoutingSnapshotStore } from "@velum-labs/routekit-eval-store";
import { Context, Effect, FileSystem, Layer, Path } from "effect";

import {
  EvalServiceComparisonError,
  EvalServiceConfigurationError,
  EvalServiceEstimateError,
  EvalServicePolicyError,
  EvalServicePublicationError,
  EvalServiceValidationError
} from "./errors.js";

export type EvalComparisonMode = "pilot" | "full";

export type EvalComparisonRunnerShape = {
  /** Validate/dry-load the suite without executing its test bodies. */
  readonly validate: (suitePath: string) => Effect.Effect<void, unknown>;
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
            catch: (cause) => cause
          })
        ),
        Effect.mapError((cause) =>
          cause instanceof EvalServiceConfigurationError
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

    return EvalService.of({
      validate,
      estimate,
      runPilot: (input) => run(input, "pilot"),
      runFull: (input) => run(input, "full"),
      propose,
      publish
    });
  });

export const makeEvalServiceLayer = (
  configuration: EvalServiceConfiguration
): Layer.Layer<EvalService, never, EvalComparisonRunner | FileSystem.FileSystem | Path.Path> =>
  Layer.effect(EvalService, makeEvalService(configuration));

const setupRunnerError = (operation: string, cause: EvalServiceError) =>
  new EvalSetupRunnerError({ operation, detail: cause.message, cause });

/** Adapt the offline service to the durable onboarding workflow's runner port. */
export const EvalSetupRunnerFromEvalService = Layer.effect(
  EvalSetupRunner,
  Effect.gen(function* () {
    const service = yield* EvalService;
    return EvalSetupRunner.of({
      validate: (input) =>
        service
          .validate(input)
          .pipe(Effect.mapError((cause) => setupRunnerError("validate", cause))),
      estimate: (input, mode) =>
        service
          .estimate(input, mode)
          .pipe(Effect.mapError((cause) => setupRunnerError("estimate", cause))),
      runPilot: (input) =>
        service
          .runPilot(input)
          .pipe(Effect.mapError((cause) => setupRunnerError("run pilot", cause))),
      runFull: (input) =>
        service
          .runFull(input)
          .pipe(Effect.mapError((cause) => setupRunnerError("run full comparison", cause))),
      propose: (input, comparison) =>
        service
          .propose(input, comparison)
          .pipe(Effect.mapError((cause) => setupRunnerError("propose policy", cause))),
      publish: (policy) =>
        service.publish(policy).pipe(
          Effect.asVoid,
          Effect.mapError((cause) => setupRunnerError("publish policy", cause))
        )
    });
  })
);
