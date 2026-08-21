import { layer as NodeServicesLayer } from "@effect/platform-node/NodeServices";
import { EVAL_ATTRIBUTION_HEADER } from "@velum-labs/routekit-eval-contracts";
import {
  EvalEngineExecutionError,
  EvalExecutionPort,
  type EvalExecutionPortService,
  makeEvalEngineLayer,
  makeRouteKitEvalExecutionPortService
} from "@velum-labs/routekit-eval-engine";
import { Data, Effect, FileSystem, Layer, Path, Stream } from "effect";
import { HttpClient } from "effect/unstable/http";

import type { RouteKitEvalGatewayCallEvent, RouteKitEvalServiceOptions } from "./layer-options.js";
import { EvalService, type EvalServiceConfiguration, makeEvalServiceLayer } from "./service.js";

export type { RouteKitEvalGatewayCallEvent, RouteKitEvalServiceOptions };

export class EvalServiceCredentialError extends Data.TaggedError("EvalServiceCredentialError")<{
  readonly detail: string;
}> {
  override get message(): string {
    return this.detail;
  }
}

const MODEL_CALL_ID_HEADER = "x-routekit-model-call-id";

const gatewayCallRole = (
  raw: string | undefined
): RouteKitEvalGatewayCallEvent["role"] | undefined => {
  if (raw === undefined) return undefined;
  try {
    const decoded = JSON.parse(raw) as { readonly role?: unknown };
    return decoded.role === "candidate" || decoded.role === "judge" ? decoded.role : undefined;
  } catch {
    return undefined;
  }
};

const observeGatewayCalls = (
  client: HttpClient.HttpClient,
  observe: NonNullable<RouteKitEvalServiceOptions["observeGatewayCall"]>
): HttpClient.HttpClient => {
  let nextObservationId = 0;
  return HttpClient.transform(client, (responseEffect, request) => {
    const role = gatewayCallRole(request.headers[EVAL_ATTRIBUTION_HEADER]);
    if (role === undefined) return responseEffect;
    return Effect.gen(function* () {
      nextObservationId += 1;
      const observationId = `gateway-call-${String(nextObservationId)}`;
      yield* observe({ observationId, phase: "issued", role });
      const response = yield* responseEffect;
      const rawCallId = response.headers[MODEL_CALL_ID_HEADER]?.trim();
      yield* observe({
        observationId,
        phase: "completed",
        role,
        ...(rawCallId === undefined || rawCallId.length === 0 ? {} : { callId: rawCallId })
      });
      return response;
    });
  });
};

const makeProductionExecutionPort = (
  options: RouteKitEvalServiceOptions
): Effect.Effect<
  EvalExecutionPortService,
  never,
  FileSystem.FileSystem | HttpClient.HttpClient | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const bearerCredential = options.bearerCredential?.trim();
    if (bearerCredential === undefined || bearerCredential.length === 0) {
      return EvalExecutionPort.of({
        nodeTestExecPath: options.execPath ?? globalThis.process.execPath,
        execute: () =>
          Stream.fail(
            new EvalEngineExecutionError({
              cause: new EvalServiceCredentialError({
                detail:
                  "RouteKit Eval comparison execution requires an injected bearer credential."
              }),
              detail:
                "RouteKit Eval comparison execution requires an injected bearer credential."
            })
          )
      });
    }
    const baseHttpClient = yield* HttpClient.HttpClient;
    const httpClient =
      options.observeGatewayCall === undefined
        ? baseHttpClient
        : observeGatewayCalls(baseHttpClient, options.observeGatewayCall);
    const paths = yield* Path.Path;
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
    return EvalExecutionPort.of({
      nodeTestExecPath: execution.nodeTestExecPath,
      execute: (input) => {
        const deadlineInput =
          options.timeoutMs === undefined
            ? input
            : {
                ...input,
                request: {
                  ...input.request,
                  timeoutMs: options.timeoutMs
                }
              };
        if (options.isolateExecutionFromProjectSdk !== true) {
          return execution.execute(deadlineInput);
        }
        return Stream.unwrap(
          Effect.gen(function* () {
            const root = yield* Effect.acquireRelease(
              fs.makeTempDirectory({ prefix: "routekit-eval-execution-" }),
              (directory) => fs.remove(directory, { recursive: true }).pipe(Effect.ignore)
            );
            const workingDirectory = paths.join(root, "suite");
            yield* fs.copy(input.discovery.workingDirectory, workingDirectory);
            const discovery = {
              ...input.discovery,
              workingDirectory,
              files: input.discovery.files.map((file) =>
                paths.join(
                  workingDirectory,
                  paths.relative(input.discovery.workingDirectory, file)
                )
              )
            };
            return execution.execute({
              ...deadlineInput,
              discovery
            });
          }).pipe(
            Effect.mapError(
              (cause) =>
                new EvalEngineExecutionError({
                  cause,
                  detail:
                    "RouteKit Eval could not isolate the reviewed suite from project-local SDK packages."
                })
            )
          )
        ).pipe(Stream.scoped);
      }
    });
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
