import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { layer as NodeServicesLayer } from "@effect/platform-node/NodeServices";
import {
  EvalEngine,
  EvalEngineExecutionError,
  makeEvalEngineLayer,
  makeRouteKitEvalExecutionPort
} from "@velum-labs/routekit-eval-engine";
import { EvalSetup } from "@velum-labs/routekit-eval-setup";
import { Data, Effect, FileSystem, Layer } from "effect";
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

type LexicalState =
  | "block-comment"
  | "code"
  | "double-quote"
  | "line-comment"
  | "single-quote"
  | "template";

/**
 * Count top-level entries in a literal array without evaluating authored code.
 *
 * This deliberately understands only JavaScript lexical boundaries and
 * balanced delimiters. If a suite computes or imports its cases, the caller
 * falls back to counting explicit node:test registrations instead.
 */
const literalArrayLength = (source: string, start: number): number | undefined => {
  if (source[start] !== "[") return undefined;
  let state: LexicalState = "code";
  let escaped = false;
  let braceDepth = 0;
  let bracketDepth = 1;
  let parenthesisDepth = 0;
  let entries = 0;
  let hasEntry = false;

  for (let index = start + 1; index < source.length; index += 1) {
    const current = source[index] ?? "";
    const next = source[index + 1] ?? "";

    if (state === "line-comment") {
      if (current === "\n") state = "code";
      continue;
    }
    if (state === "block-comment") {
      if (current === "*" && next === "/") {
        state = "code";
        index += 1;
      }
      continue;
    }
    if (state !== "code") {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (current === "\\") {
        escaped = true;
        continue;
      }
      if (
        (state === "single-quote" && current === "'") ||
        (state === "double-quote" && current === '"') ||
        (state === "template" && current === "`")
      ) {
        state = "code";
      }
      continue;
    }

    if (current === "/" && next === "/") {
      state = "line-comment";
      index += 1;
      continue;
    }
    if (current === "/" && next === "*") {
      state = "block-comment";
      index += 1;
      continue;
    }
    if (current === "'") {
      state = "single-quote";
      hasEntry = true;
      continue;
    }
    if (current === '"') {
      state = "double-quote";
      hasEntry = true;
      continue;
    }
    if (current === "`") {
      state = "template";
      hasEntry = true;
      continue;
    }
    if (current === "{") braceDepth += 1;
    else if (current === "}") braceDepth -= 1;
    else if (current === "(") parenthesisDepth += 1;
    else if (current === ")") parenthesisDepth -= 1;
    else if (current === "[") bracketDepth += 1;
    else if (current === "]") {
      bracketDepth -= 1;
      if (bracketDepth === 0) return entries + (hasEntry ? 1 : 0);
    } else if (
      current === "," &&
      bracketDepth === 1 &&
      braceDepth === 0 &&
      parenthesisDepth === 0
    ) {
      if (hasEntry) entries += 1;
      hasEntry = false;
      continue;
    }

    if (!/\s/u.test(current) && bracketDepth === 1) hasEntry = true;
  }
  return undefined;
};

const authoredCaseCount = (source: string): number => {
  const declarations = source.matchAll(/\b(?:const|let|var)\s+cases\s*=/gu);
  let literalCount = 0;
  let foundLiteral = false;
  for (const declaration of declarations) {
    const afterDeclaration = (declaration.index ?? 0) + declaration[0].length;
    const arrayStart = source.indexOf("[", afterDeclaration);
    if (arrayStart === -1) continue;
    const count = literalArrayLength(source, arrayStart);
    if (count === undefined) continue;
    foundLiteral = true;
    literalCount += count;
  }
  if (foundLiteral) return literalCount;

  // Deterministic conservative fallback for suites that author one explicit
  // node:test registration per logical case.
  return [...source.matchAll(/\b(?:it|test)\s*\(/gu)].length;
};

const estimateCalls = (
  files: readonly string[],
  candidateCount: number
): Effect.Effect<
  { readonly callCount: number; readonly pricingKnown: false },
  never,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const counts = yield* Effect.forEach(
      files,
      (file) => fs.readFileString(file).pipe(Effect.map(authoredCaseCount)),
      { concurrency: "unbounded" }
    );
    const caseCount = counts.reduce((total, count) => total + count, 0);
    const candidateCalls = caseCount * candidateCount;
    const judgeCalls = candidateCalls;
    return {
      callCount: candidateCalls + judgeCalls,
      pricingKnown: false as const
    };
  }).pipe(Effect.orDie);

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
      estimate: (request) =>
        withInspectionEngine((engine) => engine.validate(request.suitePath)).pipe(
          Effect.flatMap((validation) =>
            estimateCalls(validation.files, request.candidateModels.length)
          ),
          Effect.provide(NodeServicesLayer)
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
          return yield* Effect.gen(function* () {
            return yield* (yield* EvalEngine).runComparison(request);
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
