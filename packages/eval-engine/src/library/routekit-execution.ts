import { Effect, Layer, Stream } from "effect";
import { HttpClient } from "effect/unstable/http";

import type { EvalExecutionPortService } from "./eval-engine.ts";
import { EvalEngine, EvalEngineExecutionError, EvalExecutionPort, makeEvalEngineLayer } from "./eval-engine.ts";
import { makeRouteKitEvalGatewayBridge } from "./gateway-bridge.ts";
import { makeNodeTestExecutionPort, type NodeTestExecutionOptions } from "./node-test-execution.ts";

export interface RouteKitEvalExecutionOptions
  extends Omit<NodeTestExecutionOptions, "bridgeOrigin"> {
  /**
   * Injected RouteKit gateway credential. It remains in the parent bridge and
   * is never placed in the eval child's environment or arguments.
   */
  readonly bearerCredential: string;
}

/**
 * Concrete production execution port.
 *
 * Each comparison starts a scoped loopback bridge, runs the generated
 * `routekit/eval` SDK through `node --test`, forwards candidate and judge calls
 * to the request's OpenAI-compatible RouteKit gateway, and then releases the
 * bridge, child, and temporary evidence files together.
 */
export const makeRouteKitEvalExecutionPortService = (
  options: RouteKitEvalExecutionOptions,
  client: HttpClient.HttpClient
): EvalExecutionPortService => ({
  execute: ({ comparisonId, discovery, request }) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const bridge = yield* makeRouteKitEvalGatewayBridge({
          gatewayOrigin: request.gatewayUrl,
          bearerCredential: options.bearerCredential,
          candidateModels: request.candidateModels,
          comparisonId,
          judgeModel: request.judgeModel,
          ...(request.maxOutputTokens === undefined
            ? {}
            : { maxOutputTokens: request.maxOutputTokens })
        }).pipe(Effect.provideService(HttpClient.HttpClient, client));
        const executor = makeNodeTestExecutionPort({
          bridgeOrigin: bridge.origin,
          ...(options.childEnvironment === undefined
            ? {}
            : { childEnvironment: options.childEnvironment }),
          ...(options.execPath === undefined ? {} : { execPath: options.execPath })
        });
        return executor.execute({ comparisonId, discovery, request });
      })
    ).pipe(
      Stream.scoped,
      Stream.mapError((cause) =>
        cause instanceof EvalEngineExecutionError
          ? cause
          : new EvalEngineExecutionError({
              cause,
              detail: "RouteKit Eval could not run the scoped gateway comparison."
            })
      )
    )
});

export const makeRouteKitEvalExecutionPort = (
  options: RouteKitEvalExecutionOptions
): Effect.Effect<EvalExecutionPortService, never, HttpClient.HttpClient> =>
  Effect.map(HttpClient.HttpClient, (client) =>
    makeRouteKitEvalExecutionPortService(options, client)
  );

/**
 * Build the complete RouteKit Eval engine layer backed by the injected HTTP
 * client and scoped gateway execution path.
 */
export const makeRouteKitEvalEngineLayer = (
  options: RouteKitEvalExecutionOptions
): Layer.Layer<EvalEngine, never, HttpClient.HttpClient> =>
  makeEvalEngineLayer().pipe(
    Layer.provide(
      Layer.effect(EvalExecutionPort, makeRouteKitEvalExecutionPort(options))
    )
  );
