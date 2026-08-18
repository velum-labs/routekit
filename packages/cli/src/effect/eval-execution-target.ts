import { lstat } from "node:fs/promises";

import type {
  EvalClassifierObservation,
  EvalExecutionPlan,
  EvalRunCleanup,
  EvalRunTarget
} from "@velum-labs/routekit-eval-setup";
import { isLoopbackHost, trimTrailingSlashes } from "@velum-labs/routekit-runtime/network";
import { RouteKitFailure } from "@velum-labs/routekit-runtime/effect";
import { Effect, FileSystem, Redacted, Ref } from "effect";
import type { HttpClient } from "effect/unstable/http";

import { cliTry } from "../cli-session.js";
import { routekitClient } from "../client.js";
import { selectedRemoteMetadata } from "../target.js";

/**
 * Candidate prompts are bounded by authored-suite contracts. Judge requests
 * also contain one bounded candidate response, so 256 KiB is a conservative
 * serialized-body reservation for every candidate or judge call.
 */
const QUALIFICATION_PER_CALL_INPUT_BYTES = 256 * 1024;
const TOKEN_FILE_MAX_BYTES = 16 * 1024;

export type QualificationTarget = {
  readonly gatewayUrl: string;
  readonly bearerCredential: Redacted.Redacted<string>;
  readonly target: EvalRunTarget;
  readonly inspectCall?: (
    callId: string
  ) => Effect.Effect<EvalClassifierObservation["measurement"], Error, HttpClient.HttpClient>;
};

export type QualificationTargetInput = {
  readonly operationId: string;
  readonly plan: EvalExecutionPlan;
  readonly gatewayUrl?: string;
  readonly tokenFile?: string;
};

const failure = (message: string, cause?: unknown): RouteKitFailure =>
  new RouteKitFailure({ message, ...(cause === undefined ? {} : { cause }) });

function normalizedExternalGateway(value: string): string {
  const url = new URL(value);
  const hostname =
    url.hostname.startsWith("[") && url.hostname.endsWith("]")
      ? url.hostname.slice(1, -1)
      : url.hostname;
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error("external eval gateway URL must not contain credentials");
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    throw new Error("external eval gateway URL must not contain a query or fragment");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(hostname))) {
    throw new Error("external eval gateways require HTTPS unless they use a loopback host");
  }
  return trimTrailingSlashes(url.toString());
}

const readPrivateCredential = (
  path: string
): Effect.Effect<Redacted.Redacted<string>, RouteKitFailure, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const info = yield* Effect.tryPromise({
      try: () => lstat(path),
      catch: (cause) => failure("external eval token file is unavailable", cause)
    });
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      Number(info.size) > TOKEN_FILE_MAX_BYTES ||
      (info.mode & 0o077) !== 0
    ) {
      return yield* failure(
        "external eval token file must be a private 0600 regular non-symlink file no larger than 16 KiB"
      );
    }
    const credential = (yield* fs
      .readFileString(path)
      .pipe(
        Effect.mapError((cause) => failure("external eval token file could not be read", cause))
      )).trim();
    if (credential.length === 0) {
      return yield* failure("external eval token file is empty");
    }
    return Redacted.make(credential);
  });

export const makeQualificationCleanupRef: Effect.Effect<Ref.Ref<EvalRunCleanup>> =
  Ref.make<EvalRunCleanup>({
    sessionOpened: false,
    sessionClosed: false
  });

export function withQualificationTarget<A, E, R>(
  input: QualificationTargetInput,
  cleanup: Ref.Ref<EvalRunCleanup>,
  use: (target: QualificationTarget) => Effect.Effect<A, E, R>
): Effect.Effect<A, E | Error, R | FileSystem.FileSystem> {
  const externalRequested = input.gatewayUrl !== undefined || input.tokenFile !== undefined;
  if (externalRequested) {
    return Effect.gen(function* () {
      if (input.gatewayUrl === undefined || input.tokenFile === undefined) {
        return yield* failure(
          "external qualification requires both --gateway-url and --token-file"
        );
      }
      const gatewayUrl = yield* Effect.try({
        try: () => normalizedExternalGateway(input.gatewayUrl!),
        catch: (cause) => failure("external eval gateway URL is invalid", cause)
      });
      const bearerCredential = yield* readPrivateCredential(input.tokenFile);
      return yield* use({
        gatewayUrl,
        bearerCredential,
        target: {
          kind: "external",
          identity: gatewayUrl,
          publishAllowed: false
        }
      });
    });
  }

  return Effect.gen(function* () {
    const remote = yield* cliTry(() => selectedRemoteMetadata());
    const client = yield* routekitClient;
    for (const model of [
      ...new Set([input.plan.classifierModel, input.plan.judgeModel, ...input.plan.candidateModels])
    ]) {
      yield* client.call("models.info", { model });
    }
    return yield* Effect.acquireUseRelease(
      client
        .call(
          "evalSession.open",
          {
            purpose: "qualification",
            operationId: input.operationId,
            allowedModels: [
              ...new Set([
                input.plan.classifierModel,
                input.plan.judgeModel,
                ...input.plan.candidateModels
              ])
            ],
            limits: {
              calls: input.plan.expectedCallCount,
              inputTokens: input.plan.expectedCallCount * QUALIFICATION_PER_CALL_INPUT_BYTES,
              outputTokens: input.plan.expectedCallCount * input.plan.maximumOutputTokens,
              perCallOutputTokens: input.plan.maximumOutputTokens,
              wallTimeMs: 2 * 60 * 60_000
            },
            expiresInSeconds: 2 * 60 * 60
          },
          { idempotencyKey: input.operationId }
        )
        .pipe(
          Effect.tap(() =>
            Ref.set(cleanup, {
              sessionOpened: true,
              sessionClosed: false
            })
          )
        ),
      (opened) =>
        use({
          gatewayUrl: remote?.gatewayUrl ?? opened.gatewayUrl,
          bearerCredential: Redacted.make(opened.bearerCredential),
          target: {
            kind: "configured",
            identity: opened.targetIdentity,
            publishAllowed: true
          },
          inspectCall: (callId) =>
            client.call("calls.inspect", { callId }).pipe(
              Effect.map((call) => {
                const started = Date.parse(call.timing.startedAt);
                const finished =
                  call.timing.finishedAt === undefined
                    ? Number.NaN
                    : Date.parse(call.timing.finishedAt);
                return {
                  ...(call.cost.estimateUsd === undefined
                    ? {}
                    : { costUsd: call.cost.estimateUsd }),
                  ...(call.usage?.prompt_tokens === undefined
                    ? {}
                    : { inputTokens: call.usage.prompt_tokens }),
                  ...(call.usage?.completion_tokens === undefined
                    ? {}
                    : { outputTokens: call.usage.completion_tokens }),
                  ...(Number.isFinite(started) && Number.isFinite(finished) && finished >= started
                    ? { durationMs: finished - started }
                    : {})
                };
              })
            )
        }),
      (opened) =>
        client
          .call(
            "evalSession.close",
            { sessionId: opened.sessionId },
            { idempotencyKey: `close-${input.operationId}` }
          )
          .pipe(
            Effect.flatMap((result) =>
              result.closed
                ? Ref.set(cleanup, {
                    sessionOpened: true,
                    sessionClosed: true
                  })
                : Effect.fail(
                    failure("RouteKit eval qualification session cleanup was not confirmed")
                  )
            ),
            Effect.tapError(() =>
              Ref.set(cleanup, {
                sessionOpened: true,
                sessionClosed: false,
                detail: "session cleanup was not confirmed"
              })
            )
          )
    );
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof RouteKitFailure
        ? cause
        : failure("RouteKit eval qualification target failed", cause)
    )
  ) as Effect.Effect<A, E | Error, R | FileSystem.FileSystem>;
}
