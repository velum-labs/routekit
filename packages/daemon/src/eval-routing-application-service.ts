import type { EffectRouteKitControlHandlers } from "@velum-labs/routekit-control/effect";
import { DEFAULT_CLASSIFIER_MODEL } from "@velum-labs/routekit-config";
import {
  assertPublishedRoutingActivation,
  PublishedRoutingActivation
} from "@velum-labs/routekit-eval-contracts";
import {
  makeRoutingActivationStore,
  RoutingActivationConflictError,
  type RoutingActivationPublication
} from "@velum-labs/routekit-eval-store/effect";
import { ControlError } from "@velum-labs/routekit-runtime";
import { Effect, Schema } from "effect";

import { ActiveGateway, DaemonEnv, DaemonState } from "./effect/services.js";
import { evalRoutingSnapshotDirectory } from "./eval-routing-policy.js";

type EvalRoutingHandlers = Pick<
  EffectRouteKitControlHandlers,
  "evalRouting.status" | "evalRouting.activate"
>;

function detailOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function decodeActivation(value: unknown) {
  return Schema.decodeUnknownEffect(PublishedRoutingActivation)(value).pipe(
    Effect.flatMap((activation) =>
      Effect.try({
        try: () => {
          assertPublishedRoutingActivation(activation);
          const { version: _version, generatedAt: _generatedAt, ...publication } = activation;
          return publication satisfies RoutingActivationPublication;
        },
        catch: (cause) =>
          new ControlError({
            code: "bad_request",
            message: `routing activation is invalid: ${detailOf(cause)}`
          })
      })
    ),
    Effect.mapError((cause) =>
      cause instanceof ControlError
        ? cause
        : new ControlError({
            code: "bad_request",
            message: `routing activation is invalid: ${detailOf(cause)}`
          })
    )
  );
}

/** Owns target-local compositional routing status and atomic activation. */
export class EvalRoutingApplicationService {
  handlers(): EvalRoutingHandlers {
    return {
      "evalRouting.status": () =>
        Effect.gen(function* () {
          const env = yield* DaemonEnv;
          const store = makeRoutingActivationStore(evalRoutingSnapshotDirectory(env.home));
          const activation = yield* store.read().pipe(
            Effect.mapError(
              (cause) =>
                new ControlError({
                  code: "internal",
                  message: `failed to read routing activation: ${detailOf(cause)}`
                })
            )
          );
          return { activation: activation ?? null };
        }),
      "evalRouting.activate": (params) =>
        Effect.gen(function* () {
          const env = yield* DaemonEnv;
          const state = yield* DaemonState;
          const gateway = yield* ActiveGateway;
          const publication = yield* decodeActivation(params.activation);
          const router = gateway.router();
          if (router === undefined) {
            return yield* Effect.fail(
              new ControlError({
                code: "unavailable",
                message: "routing activation requires a running data gateway"
              })
            );
          }
          const configuredClassifier = state.config.classifierModel ?? DEFAULT_CLASSIFIER_MODEL;
          if (publication.classifierModel !== configuredClassifier) {
            return yield* Effect.fail(
              new ControlError({
                code: "unavailable",
                message: `routing activation classifier ${JSON.stringify(
                  publication.classifierModel
                )} does not match the running classifier ${JSON.stringify(configuredClassifier)}`
              })
            );
          }
          const served = new Set(router.modelCatalog().map((model) => model.id));
          const unavailableModels = [
            publication.classifierModel,
            ...publication.candidateModels
          ].filter((model, index, models) => !served.has(model) && models.indexOf(model) === index);
          if (unavailableModels.length > 0) {
            return yield* Effect.fail(
              new ControlError({
                code: "unavailable",
                message: `routing activation references models not served by this target: ${unavailableModels
                  .map((model) => JSON.stringify(model))
                  .join(", ")}`
              })
            );
          }
          const store = makeRoutingActivationStore(evalRoutingSnapshotDirectory(env.home));
          const activation = yield* store
            .publishIfCurrent(publication, params.expectedEvidenceDigest ?? undefined)
            .pipe(
              Effect.mapError((cause) =>
                cause instanceof RoutingActivationConflictError
                  ? new ControlError({ code: "conflict", message: cause.message })
                  : new ControlError({
                      code: "internal",
                      message: `failed to activate routing policy: ${detailOf(cause)}`
                    })
              )
            );
          return { activated: true as const, activation };
        })
    };
  }
}
