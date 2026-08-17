import path from "node:path";

import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { layer as NodeServicesLayer } from "@effect/platform-node/NodeServices";
import {
  EvalEngine,
  EvalEngineExecutionError,
  makeEvalEngineLayer,
  makeRouteKitEvalExecutionPort
} from "@velum-labs/routekit-eval-engine";
import { EvalRunManifest, type EvalComparisonRequest } from "@velum-labs/routekit-eval-contracts";
import { EvalSetup } from "@velum-labs/routekit-eval-setup";
import { Data, Effect, FileSystem, Layer, Schema } from "effect";
import { HttpClient } from "effect/unstable/http";

import type {
  RouteKitEvalComparisonRunnerOptions,
  RouteKitEvalSetupLayerOptions
} from "./layer-options.js";
import { makeOriEvalSetupLayer } from "./ori-setup-layer.js";
import { EvalComparisonRunner, type EvalComparisonRunnerShape } from "./service.js";

export type { RouteKitEvalComparisonRunnerOptions, RouteKitEvalSetupLayerOptions };

export class EvalComparisonRunnerCredentialError extends Data.TaggedError(
  "EvalComparisonRunnerCredentialError"
)<{
  readonly detail: string;
}> {
  override get message(): string {
    return this.detail;
  }
}

export class EvalComparisonRunnerManifestError extends Data.TaggedError(
  "EvalComparisonRunnerManifestError"
)<{
  readonly detail: string;
  readonly cause?: unknown;
}> {
  override get message(): string {
    return this.detail;
  }
}

const unavailableExecution = {
  execute: () =>
    Effect.fail(
      new EvalEngineExecutionError({
        cause: new Error("comparison execution is unavailable during inspection"),
        detail: "RouteKit Eval comparison execution is unavailable during inspection."
      })
    )
};

const withInspectionEngine = <A, E>(
  use: (engine: EvalEngine["Service"]) => Effect.Effect<A, E>
): Effect.Effect<A, E> =>
  Effect.gen(function* () {
    return yield* use(yield* EvalEngine);
  }).pipe(Effect.provide(makeEvalEngineLayer(unavailableExecution)));

const sameStrings = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const loadExecutionManifest = (workingDirectory: string, request: EvalComparisonRequest) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const manifests = yield* fs.glob("**/routekit.eval-manifest.json", {
      root: workingDirectory
    });
    if (manifests.length !== 1 || manifests[0] === undefined) {
      return yield* new EvalComparisonRunnerManifestError({
        detail: "comparison requires exactly one routekit.eval-manifest.json"
      });
    }
    const manifestPath = path.isAbsolute(manifests[0])
      ? manifests[0]
      : path.join(workingDirectory, manifests[0]);
    const raw = yield* fs.readFileString(manifestPath).pipe(
      Effect.mapError(
        (cause) =>
          new EvalComparisonRunnerManifestError({
            detail: "comparison manifest could not be read",
            cause
          })
      )
    );
    const json = yield* Effect.try({
      try: () => JSON.parse(raw) as unknown,
      catch: (cause) =>
        new EvalComparisonRunnerManifestError({
          detail: "comparison manifest is not JSON",
          cause
        })
    });
    const manifest = yield* Schema.decodeUnknownEffect(EvalRunManifest)(json).pipe(
      Effect.mapError(
        (cause) =>
          new EvalComparisonRunnerManifestError({
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
      return yield* new EvalComparisonRunnerManifestError({
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
      return yield* new EvalComparisonRunnerManifestError({
        detail: "comparison manifest case identities are incomplete or duplicated"
      });
    }
    const expectedCallCount = manifest.caseCount * manifest.candidateModels.length * 2;
    if (manifest.expectedCallCount !== expectedCallCount || manifest.maxOutputTokens < 1) {
      return yield* new EvalComparisonRunnerManifestError({
        detail: "comparison manifest call or output-token limits are inconsistent"
      });
    }
    return manifest;
  });

const inspectComparisonSuite = (request: EvalComparisonRequest) =>
  withInspectionEngine((engine) => engine.validate(request.suitePath)).pipe(
    Effect.flatMap((validation) =>
      loadExecutionManifest(validation.workingDirectory, request).pipe(
        Effect.map((manifest) => ({
          suiteDigest: validation.suiteDigest,
          manifest
        }))
      )
    ),
    Effect.provide(NodeServicesLayer)
  );

/**
 * Production adapter from EvalService's comparison port to the vendored,
 * Effect-native RouteKit Eval engine.
 */
export const makeEvalComparisonRunner = (
  options: RouteKitEvalComparisonRunnerOptions
): Effect.Effect<EvalComparisonRunnerShape, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    return {
      validate: (suitePath) =>
        withInspectionEngine((engine) => engine.validate(suitePath)).pipe(Effect.asVoid),
      inspect: (request) => inspectComparisonSuite(request),
      estimate: (request) =>
        inspectComparisonSuite(request).pipe(
          Effect.map((inspection) => ({
            callCount: inspection.manifest.expectedCallCount,
            pricingKnown: false as const
          }))
        ),
      runComparison: (request) =>
        Effect.gen(function* () {
          const bearerCredential = options.bearerCredential?.trim();
          if (bearerCredential === undefined || bearerCredential.length === 0) {
            return yield* new EvalComparisonRunnerCredentialError({
              detail: "RouteKit Eval comparison execution requires an injected bearer credential."
            });
          }
          const execution = yield* makeRouteKitEvalExecutionPort({
            bearerCredential,
            ...(options.childEnvironment === undefined
              ? {}
              : { childEnvironment: options.childEnvironment }),
            ...(options.execPath === undefined ? {} : { execPath: options.execPath })
          }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
          const inspection = yield* inspectComparisonSuite(request);
          return yield* Effect.gen(function* () {
            return yield* (yield* EvalEngine).runComparison({
              ...request,
              expectedCaseIds: [...inspection.manifest.caseIds],
              expectedCallCount: inspection.manifest.expectedCallCount,
              maxOutputTokens: inspection.manifest.maxOutputTokens,
              suiteDigest: inspection.suiteDigest
            });
          }).pipe(Effect.provide(makeEvalEngineLayer(execution)));
        })
    } satisfies EvalComparisonRunnerShape;
  });

export const makeEvalComparisonRunnerLayer = (
  options: RouteKitEvalComparisonRunnerOptions
): Layer.Layer<EvalComparisonRunner, never, HttpClient.HttpClient> =>
  Layer.effect(EvalComparisonRunner, makeEvalComparisonRunner(options));

/**
 * Complete production onboarding composition used by CLI and other hosts.
 *
 * The layer is credential-optional so setup, authoring, validation, and
 * estimation remain available before the user approves a paid run.
 */
export const makeRouteKitEvalSetupLayer = (
  options: RouteKitEvalSetupLayerOptions
): Layer.Layer<EvalSetup> => makeOriEvalSetupLayer(options);
