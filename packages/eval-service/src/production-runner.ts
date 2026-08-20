import { layer as NodeServicesLayer } from "@effect/platform-node/NodeServices";
import {
  EvalEngineExecutionError,
  EvalExecutionPort,
  type EvalExecutionPortService,
  makeEvalEngineLayer,
  makeRouteKitEvalExecutionPortService
} from "@velum-labs/routekit-eval-engine";
import { Data, Effect, Layer, Stream } from "effect";
import { HttpClient } from "effect/unstable/http";

import type { RouteKitEvalServiceOptions } from "./layer-options.js";
import { EvalService, type EvalServiceConfiguration, makeEvalServiceLayer } from "./service.js";

export type { RouteKitEvalServiceOptions };

export class EvalServiceCredentialError extends Data.TaggedError("EvalServiceCredentialError")<{
  readonly detail: string;
}> {
  override get message(): string {
    return this.detail;
  }
}

const makeProductionExecutionPort = (
  options: RouteKitEvalServiceOptions
): Effect.Effect<EvalExecutionPortService, never, HttpClient.HttpClient> =>
  Effect.map(HttpClient.HttpClient, (httpClient) => {
    const bearerCredential = options.bearerCredential?.trim();
    if (bearerCredential === undefined || bearerCredential.length === 0) {
      return {
        execute: () =>
          Stream.fail(
          new EvalEngineExecutionError({
            cause: new EvalServiceCredentialError({
              detail: "RouteKit Eval comparison execution requires an injected bearer credential."
            }),
            detail: "RouteKit Eval comparison execution requires an injected bearer credential."
          })
          )
      };
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
    if (options.timeoutMs === undefined) return execution;
    return {
      execute: (input) =>
        execution.execute({
          ...input,
          request: {
            ...input.request,
            timeoutMs: options.timeoutMs
          }
        })
    };
  });

const makeProductionEvalEngineLayer = (options: RouteKitEvalServiceOptions) =>
  makeEvalEngineLayer().pipe(
    Layer.provide(Layer.effect(EvalExecutionPort, makeProductionExecutionPort(options)))
  );

/**
 * Complete production composition for RouteKit Eval.
 *
 * EvalService consumes the vendored engine's native Effect service. The
 * execution port is the only adapter; no parallel comparison-runner service
 * mirrors or wraps the engine API.
 */
export const makeRouteKitEvalServiceLayer = (
  configuration: EvalServiceConfiguration,
  options: RouteKitEvalServiceOptions
): Layer.Layer<EvalService, never, HttpClient.HttpClient> =>
  makeEvalServiceLayer(configuration).pipe(
    Layer.provide(makeProductionEvalEngineLayer(options)),
    Layer.provide(NodeServicesLayer)
  );
