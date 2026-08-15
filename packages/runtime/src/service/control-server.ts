/** Authenticated loopback HTTP server for the product-neutral control plane. */
import type { IncomingMessage } from "node:http";
import { createServer } from "node:http";
import { Deferred, Effect, Stream } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import * as HttpEffect from "effect/unstable/http/HttpEffect";
import { HttpServerError } from "effect/unstable/http/HttpServerError";

import {
  type RouteKitPlatform,
  runRouteKitEffect
} from "../effect/effect-runtime.js";
import { routeKitError, toRouteKitFailure } from "../effect/errors.js";
import { createNodeHttpHandlerEffect } from "../effect/node-http.js";
import type {
  ControlEvent,
  ControlFailure,
  ControlHandler,
  ControlPrincipal,
  ControlRequest,
  ControlServerErrorContext,
  ControlSuccess,
  RunningControlServer
} from "./control-protocol.js";
import {
  CONTROL_BODY_LIMIT_BYTES,
  CONTROL_PROTOCOL_VERSION,
  ControlError,
  controlTokenMatches,
  generateControlToken
} from "./control-protocol.js";

function bearer(req: IncomingMessage): string | undefined {
  const value = req.headers.authorization;
  return typeof value === "string" && value.startsWith("Bearer ")
    ? value.slice("Bearer ".length)
    : undefined;
}

function loopbackHost(req: IncomingMessage): boolean {
  const raw = req.headers.host;
  const host = raw?.startsWith("[") === true ? raw.slice(1, raw.indexOf("]")) : raw?.split(":")[0];
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function controlJson(status: number, body: unknown): HttpServerResponse.HttpServerResponse {
  return HttpServerResponse.jsonUnsafe(body, {
    status,
    headers: { "cache-control": "no-store" }
  });
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const contentType = req.headers["content-type"]?.split(";")[0]?.trim();
  if (contentType !== "application/json") {
    throw new ControlError({
      code: "bad_request",
      message: "control requests require application/json"
    });
  }
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > CONTROL_BODY_LIMIT_BYTES) {
    throw new ControlError({ code: "bad_request", message: "control request body is too large" });
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const value of req) {
    const chunk = value as Buffer;
    total += chunk.length;
    if (total > CONTROL_BODY_LIMIT_BYTES) {
      throw new ControlError({ code: "bad_request", message: "control request body is too large" });
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new ControlError({ code: "bad_request", message: "invalid control request JSON" });
  }
}

function parseRequest(value: unknown): ControlRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ControlError({ code: "bad_request", message: "control request must be an object" });
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.protocol !== "string" ||
    typeof record.id !== "string" ||
    typeof record.method !== "string" ||
    record.id.length === 0 ||
    record.method.length === 0
  ) {
    throw new ControlError({
      code: "bad_request",
      message: "control request requires protocol, id, and method"
    });
  }
  return {
    protocol: record.protocol,
    id: record.id,
    method: record.method,
    ...(record.params !== undefined ? { params: record.params } : {}),
    ...(typeof record.idempotencyKey === "string" ? { idempotencyKey: record.idempotencyKey } : {}),
    ...(typeof record.client === "object" && record.client !== null
      ? { client: record.client as ControlRequest["client"] }
      : {})
  };
}

function asFailure(id: string, error: unknown): { status: number; body: ControlFailure } {
  const normalized =
    error instanceof ControlError
      ? error
      : new ControlError({ code: "internal", message: "control operation failed" });
  return {
    status: normalized.status,
    body: {
      protocol: CONTROL_PROTOCOL_VERSION,
      id,
      ok: false,
      error: {
        code: normalized.code,
        message: normalized.message,
        ...(normalized.details !== undefined ? { details: normalized.details } : {})
      }
    }
  };
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function"
  );
}

function ndjsonBytes(event: ControlEvent): Uint8Array {
  return Buffer.from(`${JSON.stringify(event)}\n`, "utf8");
}

function incomingRequest(request: HttpServerRequest.HttpServerRequest): IncomingMessage {
  return request.source as IncomingMessage;
}

export type ControlServerOptions = {
  handler: ControlHandler;
  token?: string;
  host?: "127.0.0.1" | "::1";
  port?: number;
  product?: string;
  packageVersion?: string;
  capabilities?: readonly string[];
  /**
   * Optional secondary authorizer for durable control-plane tokens (registry).
   * The per-start ephemeral token always remains valid.
   */
  authorize?: (presented: string) => ControlPrincipal | undefined;
  /** Observe unexpected handler/transport failures without exposing them to clients. */
  onError?: (error: unknown, context: ControlServerErrorContext) => void;
};

export function startControlServerEffect(
  input: ControlServerOptions
): Effect.Effect<RunningControlServer, Error, RouteKitPlatform> {
  return Effect.gen(function* () {
    const host = input.host ?? "127.0.0.1";
    const token = input.token ?? generateControlToken();
    const reportError = (error: unknown, context: ControlServerErrorContext): void => {
      try {
        input.onError?.(error, context);
      } catch {
        // Observability must never change the control response or crash the server.
      }
    };
    const resolveCaller = (presented: string | undefined): ControlPrincipal | undefined => {
      if (presented === undefined) return undefined;
      if (controlTokenMatches(token, presented)) {
        return { id: "ephemeral", label: "local", role: "ephemeral" };
      }
      return input.authorize?.(presented);
    };
    const authorize = (
      request: HttpServerRequest.HttpServerRequest
    ): ControlPrincipal | HttpServerResponse.HttpServerResponse => {
      const nodeReq = incomingRequest(request);
      if (!loopbackHost(nodeReq)) {
        return controlJson(403, {
          error: { code: "unauthorized", message: "invalid control host" }
        });
      }
      const principal = resolveCaller(bearer(nodeReq));
      if (principal === undefined) {
        return controlJson(401, { error: { code: "unauthorized", message: "unauthorized" } });
      }
      return principal;
    };

    const handleCall = (request: HttpServerRequest.HttpServerRequest) => {
      const authorized = authorize(request);
      if (!("id" in authorized) || !("role" in authorized)) return Effect.succeed(authorized);
      const principal = authorized;
      const nodeReq = incomingRequest(request);
      let requestId = "unknown";
      let requestMethod: string | undefined;
      return Effect.gen(function* () {
        const parsed = yield* Effect.tryPromise({
          try: async () => parseRequest(await readJson(nodeReq)),
          catch: (error) => toRouteKitFailure(error)
        });
        requestId = parsed.id;
        requestMethod = parsed.method;
        if (parsed.protocol !== CONTROL_PROTOCOL_VERSION) {
          const failure = asFailure(
            parsed.id,
            new ControlError({
              code: "upgrade_required",
              message: `unsupported control protocol ${parsed.protocol}`,
              details: { supported: [CONTROL_PROTOCOL_VERSION] }
            })
          );
          return controlJson(failure.status, failure.body);
        }
        if (parsed.method === "hello") {
          return controlJson(200, {
            protocol: CONTROL_PROTOCOL_VERSION,
            id: parsed.id,
            ok: true,
            result: {
              protocolVersion: CONTROL_PROTOCOL_VERSION,
              product: input.product,
              packageVersion: input.packageVersion,
              capabilities: input.capabilities ?? []
            }
          } satisfies ControlSuccess);
        }
        const aborter = yield* Effect.acquireRelease(
          Effect.sync(() => new AbortController()),
          (controller) =>
            Effect.sync(() => controller.abort(new Error("control client disconnected")))
        );
        const result = yield* Effect.tryPromise({
          try: async () =>
            await input.handler(parsed.method, parsed.params, {
              signal: aborter.signal,
              requestId: parsed.id,
              principal,
              ...(parsed.idempotencyKey !== undefined
                ? { idempotencyKey: parsed.idempotencyKey }
                : {}),
              ...(parsed.client !== undefined ? { client: parsed.client } : {})
            }),
          catch: (error) => toRouteKitFailure(error)
        });
        if (!isAsyncIterable(result)) {
          return controlJson(200, {
            protocol: CONTROL_PROTOCOL_VERSION,
            id: parsed.id,
            ok: true,
            result
          } satisfies ControlSuccess);
        }
        const encoder = (event: ControlEvent): Uint8Array => ndjsonBytes(event);
        const stream = Stream.fromAsyncIterable(result, (error) => error).pipe(
          Stream.map((data) =>
            encoder({
              protocol: CONTROL_PROTOCOL_VERSION,
              id: parsed.id,
              event: "data",
              data
            })
          ),
          Stream.concat(
            Stream.succeed(
              encoder({
                protocol: CONTROL_PROTOCOL_VERSION,
                id: parsed.id,
                event: "done"
              })
            )
          ),
          Stream.catch((error) => {
            const boundaryError = routeKitError(error);
            if (!(boundaryError instanceof ControlError)) {
              reportError(boundaryError, { requestId, method: parsed.method });
            }
            const failure = asFailure(parsed.id, boundaryError);
            return Stream.succeed(
              encoder({
                protocol: CONTROL_PROTOCOL_VERSION,
                id: parsed.id,
                event: "error",
                error: failure.body.error
              })
            );
          })
        );
        return HttpEffect.scopeTransferToStream(
          HttpServerResponse.stream(stream, {
            status: 200,
            headers: {
              "content-type": "application/x-ndjson",
              "cache-control": "no-store"
            }
          })
        );
      }).pipe(
        Effect.catch((error) => {
          const boundaryError = routeKitError(error);
          if (!(boundaryError instanceof ControlError)) {
            reportError(boundaryError, {
              requestId,
              ...(requestMethod !== undefined ? { method: requestMethod } : {})
            });
          }
          const failure = asFailure(requestId, boundaryError);
          return Effect.succeed(controlJson(failure.status, failure.body));
        })
      );
    };

    const httpEffect = yield* Effect.gen(function* () {
      const router = yield* HttpRouter.make;
      yield* router.add("GET", "/control/v2/health", (request) => {
        const authorized = authorize(request);
        if (!("id" in authorized) || !("role" in authorized)) return Effect.succeed(authorized);
        return Effect.succeed(
          controlJson(200, {
            status: "ok",
            protocol: CONTROL_PROTOCOL_VERSION,
            product: input.product,
            version: input.packageVersion
          })
        );
      });
      yield* router.add("POST", "/control/v2/call", handleCall);
      return router;
    }).pipe(
      Effect.map((router) => {
        const routed = router.asHttpEffect();
        return Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const authorized = authorize(request);
          if (!("id" in authorized) || !("role" in authorized)) return authorized;
          return yield* routed;
        }).pipe(
          Effect.catch((error) => {
            if (error instanceof HttpServerError && error.reason._tag === "RouteNotFound") {
              return Effect.succeed(
                controlJson(404, {
                  error: { code: "not_found", message: "control route not found" }
                })
              );
            }
            reportError(error, { requestId: "unknown" });
            return Effect.succeed(
              controlJson(500, { error: { code: "internal", message: "control request failed" } })
            );
          })
        );
      })
    );
    const nodeHandler = yield* createNodeHttpHandlerEffect(httpEffect);
    const server = createServer((req, res) => {
      nodeHandler.handle(req, res);
    });
    yield* Effect.tryPromise({
      try: () =>
        new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(input.port ?? 0, host, () => {
            server.off("error", reject);
            resolve();
          });
        }),
      catch: toRouteKitFailure
    });
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : (input.port ?? 0);
    const retireDone = Deferred.makeUnsafe<void, Error>();
    let retireStarted = false;
    const retire = (graceMs = 2_000): Effect.Effect<void, Error> =>
      Effect.suspend(() => {
        if (retireStarted) return Deferred.await(retireDone);
        retireStarted = true;
        const program = Effect.gen(function* () {
          const closed = Deferred.makeUnsafe<void, Error>();
          yield* Effect.sync(() =>
            server.close((error) =>
              Deferred.doneUnsafe(
                closed,
                error === undefined ? Effect.void : Effect.fail(toRouteKitFailure(error))
              )
            )
          );
          server.closeIdleConnections();
          yield* Effect.raceFirst(Deferred.await(closed), Effect.sleep(`${graceMs} millis`));
          server.closeAllConnections();
          yield* Deferred.await(closed);
          yield* nodeHandler.close;
        });
        return Deferred.complete(retireDone, program).pipe(
          Effect.andThen(Deferred.await(retireDone))
        );
      });
    return {
      url: `http://${host === "::1" ? "[::1]" : host}:${port}`,
      token,
      port,
      retire,
      close: retire(2_000)
    };
  });
}

/** Promise adapter for standalone control-plane hosts. */
export async function startControlServer(
  input: ControlServerOptions
): Promise<RunningControlServer> {
  return runRouteKitEffect(startControlServerEffect(input));
}
