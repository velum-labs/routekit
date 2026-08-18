import path from "node:path";

import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { layer as NodeServicesLayer } from "@effect/platform-node/NodeServices";
import {
  type EvalComparisonRequest,
  EvalRunManifest,
  type EvalRunManifest as EvalRunManifestType
} from "@velum-labs/routekit-eval-contracts";
import {
  EvalEngineDiscoveryError,
  EvalEngineDryLoadError,
  EvalEngineExecutionError,
  EvalEnginePortableImportError,
  type EvalEngineValidation,
  type EvalExecutionPortService,
  makeEvalEngine,
  makeRouteKitEvalExecutionPortService
} from "@velum-labs/routekit-eval-engine";
import {
  DEFAULT_MODEL_PRICING,
  PRICING_ALIASES,
  type RegistryModelPricing
} from "@velum-labs/routekit-registry";
import { Data, Effect, FileSystem, Layer, Schema } from "effect";
import { HttpClient } from "effect/unstable/http";

import type { RouteKitEvalComparisonRunnerOptions } from "./layer-options.js";
import {
  EvalComparisonRunner,
  type EvalComparisonRunnerShape,
  type EvalSuiteInspection
} from "./service.js";

export type { RouteKitEvalComparisonRunnerOptions };

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

export class EvalComparisonRunnerSpendLimitError extends Data.TaggedError(
  "EvalComparisonRunnerSpendLimitError"
)<{
  readonly detail: string;
}> {
  override get message(): string {
    return this.detail;
  }
}

const unavailableExecution: EvalExecutionPortService = {
  execute: () =>
    Effect.fail(
      new EvalEngineExecutionError({
        cause: new Error("comparison execution is unavailable during inspection"),
        detail: "RouteKit Eval comparison execution is unavailable during inspection."
      })
    )
};

const inspectionEngine = makeEvalEngine(unavailableExecution);

const validateWithInspectionEngine = (
  suitePath: string
): Effect.Effect<
  EvalEngineValidation,
  EvalEngineDiscoveryError | EvalEngineDryLoadError | EvalEnginePortableImportError,
  never
> => inspectionEngine.validate(suitePath);

const sameStrings = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const MAXIMUM_INPUT_TOKENS_PER_CALL = 256 * 1024;

function modelPricing(model: string): RegistryModelPricing | undefined {
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
}

function maximumCallCost(pricing: RegistryModelPricing, maximumOutputTokens: number): number {
  return (
    (MAXIMUM_INPUT_TOKENS_PER_CALL * pricing.inputPer1mTokens +
      maximumOutputTokens * pricing.outputPer1mTokens) /
    1_000_000
  );
}

function estimateComparison(manifest: EvalRunManifestType) {
  const candidatePrices = manifest.candidateModels.map(modelPricing);
  const judgePrice = modelPricing(manifest.judgeModel);
  if (candidatePrices.some((pricing) => pricing === undefined) || judgePrice === undefined) {
    return {
      callCount: manifest.expectedCallCount,
      pricingKnown: false as const
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
    pricingKnown: true as const
  };
}

const enforceSpendLimit = (
  request: EvalComparisonRequest,
  manifest: EvalRunManifestType
): Effect.Effect<void, EvalComparisonRunnerSpendLimitError> => {
  if (request.spendLimitUsd === undefined) return Effect.void;
  const estimate = estimateComparison(manifest);
  if (!estimate.pricingKnown || estimate.maximumCostUsd === undefined) {
    return Effect.fail(
      new EvalComparisonRunnerSpendLimitError({
        detail:
          "RouteKit Eval cannot enforce spendLimitUsd because pricing is unknown for one or more manifest models."
      })
    );
  }
  if (estimate.maximumCostUsd > request.spendLimitUsd) {
    return Effect.fail(
      new EvalComparisonRunnerSpendLimitError({
        detail:
          `RouteKit Eval maximum estimated cost $${estimate.maximumCostUsd.toFixed(6)} ` +
          `exceeds spendLimitUsd $${request.spendLimitUsd.toFixed(6)}.`
      })
    );
  }
  return Effect.void;
};

const loadExecutionManifest = (
  workingDirectory: string,
  request: EvalComparisonRequest
): Effect.Effect<EvalRunManifestType, EvalComparisonRunnerManifestError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const manifests = yield* fs
      .glob("**/routekit.eval-manifest.json", {
        root: workingDirectory
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new EvalComparisonRunnerManifestError({
              detail: "comparison manifest discovery failed",
              cause
            })
        )
      );
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

const inspectComparisonSuite = (
  request: EvalComparisonRequest
): Effect.Effect<EvalSuiteInspection, unknown, never> =>
  validateWithInspectionEngine(request.suitePath).pipe(
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
  Effect.map(HttpClient.HttpClient, (httpClient) => {
    const runComparison: EvalComparisonRunnerShape["runComparison"] = (request) => {
      const bearerCredential = options.bearerCredential?.trim();
      if (bearerCredential === undefined || bearerCredential.length === 0) {
        return Effect.fail(
          new EvalComparisonRunnerCredentialError({
            detail: "RouteKit Eval comparison execution requires an injected bearer credential."
          })
        );
      }
      const execution = makeRouteKitEvalExecutionPortService(
        {
          bearerCredential,
          ...(options.childEnvironment === undefined
            ? {}
            : { childEnvironment: options.childEnvironment }),
          ...(options.execPath === undefined ? {} : { execPath: options.execPath })
        },
        httpClient
      );
      return Effect.flatMap(inspectComparisonSuite(request), (inspection) =>
        enforceSpendLimit(request, inspection.manifest).pipe(
          Effect.flatMap(
            () =>
              makeEvalEngine(execution).runComparison({
                ...request,
                expectedCaseIds: [...inspection.manifest.caseIds],
                expectedCallCount: inspection.manifest.expectedCallCount,
                maxOutputTokens: inspection.manifest.maxOutputTokens,
                suiteDigest: inspection.suiteDigest
              }) as ReturnType<EvalComparisonRunnerShape["runComparison"]>
          )
        )
      );
    };
    return {
      validate: (suitePath) => validateWithInspectionEngine(suitePath).pipe(Effect.asVoid),
      inspect: (request) => inspectComparisonSuite(request),
      estimate: (request) =>
        inspectComparisonSuite(request).pipe(
          Effect.map((inspection) => estimateComparison(inspection.manifest))
        ),
      runComparison
    } satisfies EvalComparisonRunnerShape;
  });

export const makeEvalComparisonRunnerLayer = (
  options: RouteKitEvalComparisonRunnerOptions
): Layer.Layer<EvalComparisonRunner, never, HttpClient.HttpClient> =>
  Layer.effect(EvalComparisonRunner, makeEvalComparisonRunner(options));
