/**
 * Stable data-plane front door whose internal router generation can be
 * replaced atomically.
 *
 * A singleton daemon keeps this listener for its whole lifetime. Reload builds
 * a complete router on an ephemeral loopback port, calls `swapTarget`, then
 * drains the old router. Requests accepted before the swap stay attached to
 * the old generation; later requests immediately use the new one.
 */

import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { createServer } from "node:http";

import {
  EVAL_ATTRIBUTION_HEADER,
  EVAL_POLICY_BYPASS_HEADER,
  isForbiddenEvalModel
} from "@velum-labs/routekit-eval-contracts";
import { assertAuthenticatedBind, trimTrailingSlashes } from "@velum-labs/routekit-runtime/network";
import {
  createNodeHttpHandlerEffect,
  executeWebRequest,
  type RouteKitPlatform,
  RouteKitLive,
  toRouteKitFailure
} from "@velum-labs/routekit-runtime/effect";
import { Context, Deferred, Effect, Layer, ManagedRuntime, Stream } from "effect";
import {
  HttpClient,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse
} from "effect/unstable/http";
import * as HttpEffect from "effect/unstable/http/HttpEffect";
import {
  authorizedRequest,
  type GatewayPrincipal,
  ROUTEKIT_PRINCIPAL_HEADER,
  resolvePrincipal
} from "./http/auth.js";
import { gatewayTryPromise } from "./effect/gateway.js";

const MAX_BODY_BYTES = 16 * 1024 * 1024;
const DEFAULT_UPSTREAM_HEADERS_TIMEOUT_MS = 10 * 60 * 1000;
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

export type SwitchingGatewayProxy = {
  url(): string;
  port(): number;
  target(): string;
  swapTarget(target: string): string;
  waitForTargetIdle(target: string, graceMs: number): Effect.Effect<boolean>;
  retire(graceMs?: number): Effect.Effect<void, Error>;
  drain(graceMs?: number): Effect.Effect<void, Error>;
  readonly close: Effect.Effect<void, Error>;
};

class SwitchingGatewayRuntime extends Context.Service<
  SwitchingGatewayRuntime,
  SwitchingGatewayProxy
>()("@velum-labs/routekit-gateway/SwitchingGatewayRuntime") {}

function requestHeaders(headers: IncomingHttpHeaders, principal?: GatewayPrincipal): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (
      value === undefined ||
      HOP_BY_HOP.has(lower) ||
      lower === "host" ||
      lower === EVAL_ATTRIBUTION_HEADER ||
      lower === EVAL_POLICY_BYPASS_HEADER ||
      // Never forward a client-supplied principal; the proxy is the only
      // trusted source of identity for the inner gateway.
      lower === ROUTEKIT_PRINCIPAL_HEADER
    ) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const entry of value) result.append(name, entry);
    } else {
      result.set(name, value);
    }
  }
  if (principal !== undefined) {
    result.set(ROUTEKIT_PRINCIPAL_HEADER, JSON.stringify(principal));
    if (principal.role === "eval" && principal.evalSession !== undefined) {
      result.set(EVAL_POLICY_BYPASS_HEADER, "1");
      const attribution = headers[EVAL_ATTRIBUTION_HEADER];
      const value = Array.isArray(attribution) ? attribution[0] : attribution;
      if (typeof value === "string") result.set(EVAL_ATTRIBUTION_HEADER, value);
    }
  }
  return result;
}

type EvalAdmissionRejection = {
  status: number;
  message: string;
};

function requestedOutputTokens(body: Record<string, unknown>): number | undefined {
  for (const key of ["max_output_tokens", "max_completion_tokens", "max_tokens"] as const) {
    const value = body[key];
    if (value !== undefined) {
      return typeof value === "number" && Number.isSafeInteger(value) && value > 0
        ? value
        : undefined;
    }
  }
  return undefined;
}

function evalAdmissionRejection(
  principal: GatewayPrincipal | undefined,
  method: string | undefined,
  path: string,
  body: Buffer | undefined
): EvalAdmissionRejection | undefined {
  const session = principal?.evalSession;
  if (principal?.role !== "eval" || session === undefined || method !== "POST") return undefined;
  if (body === undefined) return { status: 400, message: "eval request body is required" };
  let value: unknown;
  try {
    value = JSON.parse(body.toString("utf8"));
  } catch {
    return { status: 400, message: "eval request body must be valid JSON" };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { status: 400, message: "eval request body must be a JSON object" };
  }
  const record = value as Record<string, unknown>;
  const model = record.model;
  if (
    typeof model !== "string" ||
    isForbiddenEvalModel(model) ||
    !session.allowedModels.includes(model)
  ) {
    return {
      status: 400,
      message: "eval requests must name a model allowed by the eval session"
    };
  }
  const producesTokens = path !== "/v1/embeddings" && path !== "/v1/messages/count_tokens";
  const maximum = producesTokens ? requestedOutputTokens(record) : 0;
  if (
    maximum === undefined ||
    (session.perCallOutputTokens !== undefined && maximum > session.perCallOutputTokens)
  ) {
    return {
      status: 400,
      message:
        session.perCallOutputTokens === undefined
          ? "eval session has no output-token limit"
          : `eval requests must set an output-token limit no greater than ${session.perCallOutputTokens}`
    };
  }
  // A UTF-8 byte is a conservative upper bound for one input token. Reserving
  // the full request-body size keeps the session input-token failsafe active
  // without parsing or retaining prompt content.
  const admitted = session.admit?.(model, body.byteLength, maximum);
  if (admitted === undefined) {
    return { status: 401, message: "eval session cannot admit model calls" };
  }
  if (!admitted.admitted) {
    const message =
      admitted.reason === "expired"
        ? "eval session expired"
        : admitted.reason === "closed"
          ? "eval session is closed"
          : admitted.reason === "call_limit"
            ? "eval session call limit reached"
            : admitted.reason === "input_limit"
              ? "eval session input-token limit reached"
              : "eval session output-token limit reached";
    return { status: 429, message };
  }
  return undefined;
}
async function requestBody(req: IncomingMessage): Promise<Buffer | undefined> {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const value of req) {
    const chunk = value as Buffer;
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new Error("proxy request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function jsonResponse(status: number, value: unknown): HttpServerResponse.HttpServerResponse {
  return HttpServerResponse.jsonUnsafe(value, { status });
}

function proxyResponse(
  upstream: Response,
  closeConnection: boolean
): HttpServerResponse.HttpServerResponse {
  const headers: Record<string, string> = {};
  for (const [name, value] of upstream.headers) {
    if (!HOP_BY_HOP.has(name.toLowerCase()) && name.toLowerCase() !== "content-length") {
      headers[name] = value;
    }
  }
  if (closeConnection) headers.connection = "close";
  const body = upstream.body;
  if (body === null) {
    return HttpServerResponse.empty({ status: upstream.status, headers });
  }
  return HttpServerResponse.stream(
    Stream.fromReadableStream({
      evaluate: () => body,
      onError: (error) => (error instanceof Error ? error : new Error(String(error)))
    }),
    { status: upstream.status, headers }
  );
}

export type SwitchingGatewayProxyOptions = {
  target: string;
  host?: string;
  port?: number;
  authToken?: string;
  /** Maximum wait for the active generation to return response headers. */
  upstreamHeadersTimeoutMs?: number;
  /** Resolve a named data-plane principal; preferred over `authToken` alone. */
  resolveDataPrincipal?: (presented: string) => GatewayPrincipal | undefined;
};

const startSwitchingGatewayProxyOperation = Effect.fn("SwitchingGatewayProxy.start")(function* (
  input: SwitchingGatewayProxyOptions
): Effect.fn.Return<SwitchingGatewayProxy, Error, RouteKitPlatform> {
  const host = input.host ?? "127.0.0.1";
  assertAuthenticatedBind(host, input.authToken);
  const authEnabled = input.resolveDataPrincipal !== undefined || input.authToken !== undefined;
  type TargetGeneration = {
    url: string;
    leases: number;
    waiters: Set<() => void>;
  };
  let active: TargetGeneration = {
    url: trimTrailingSlashes(input.target),
    leases: 0,
    waiters: new Set()
  };
  const generations = new Map<string, TargetGeneration>([[active.url, active]]);
  const requestTargets = new WeakMap<IncomingMessage, TargetGeneration>();
  let draining = false;
  let retiring = false;
  let inflight = 0;
  const httpEffect = yield* Effect.gen(function* () {
    const router = yield* HttpRouter.make;
    const httpClient = yield* HttpClient.HttpClient;
    yield* router.add("*", "*", (request) =>
      Effect.gen(function* () {
        const nodeReq = request.source as IncomingMessage;
        const path = nodeReq.url ?? "/";
        let principal: GatewayPrincipal | undefined;
        if (authEnabled) {
          principal =
            input.resolveDataPrincipal === undefined
              ? undefined
              : resolvePrincipal(nodeReq, input.resolveDataPrincipal);
          if (principal === undefined) {
            if (
              input.resolveDataPrincipal === undefined &&
              input.authToken !== undefined &&
              authorizedRequest(nodeReq, input.authToken)
            ) {
              principal = { id: "default", label: "default", role: "owner" };
            } else {
              return jsonResponse(401, {
                error: { message: "unauthorized", type: "auth_error" }
              });
            }
          }
        }
        const selected = requestTargets.get(nodeReq) ?? active;
        const aborter = yield* Effect.acquireRelease(
          Effect.sync(() => new AbortController()),
          (controller) =>
            Effect.sync(() => {
              controller.abort(new Error("gateway client disconnected"));
            })
        );
        const proxied = yield* Effect.gen(function* () {
          const body = yield* Effect.tryPromise({
            try: () => requestBody(nodeReq),
            catch: (error) => toRouteKitFailure(error)
          });
          const rejection = evalAdmissionRejection(principal, nodeReq.method, path, body);
          if (rejection !== undefined) {
            return jsonResponse(rejection.status, {
              error: { message: rejection.message, type: "invalid_request_error" }
            });
          }
          const headersTimeout = new AbortController();
          const timeout = setTimeout(
            () =>
              headersTimeout.abort(
                new Error(
                  `gateway generation did not return headers within ${
                    input.upstreamHeadersTimeoutMs ?? DEFAULT_UPSTREAM_HEADERS_TIMEOUT_MS
                  }ms`
                )
              ),
            input.upstreamHeadersTimeoutMs ?? DEFAULT_UPSTREAM_HEADERS_TIMEOUT_MS
          );
          const upstream = yield* executeWebRequest(`${selected.url}${path}`, {
            method: nodeReq.method ?? "GET",
            headers: requestHeaders(nodeReq.headers, principal),
            ...(body !== undefined ? { body } : {}),
            signal: AbortSignal.any([aborter.signal, headersTimeout.signal])
          }).pipe(Effect.ensuring(Effect.sync(() => clearTimeout(timeout))));
          return HttpEffect.scopeTransferToStream(proxyResponse(upstream, retiring));
        }).pipe(
          Effect.orElseSucceed(() =>
            jsonResponse(502, {
              error: { message: "router generation unavailable", type: "upstream_error" }
            })
          )
        );
        return proxied;
      }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient))
    );
    return router;
  }).pipe(
    Effect.map((router) => {
      const routed = router.asHttpEffect();
      return Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const path = new URL(request.url, "http://localhost").pathname;
        if (path === "/health") {
          return jsonResponse(draining ? 503 : 200, {
            status: draining ? "draining" : "ok"
          });
        }
        if (draining) {
          return jsonResponse(503, {
            error: { message: "gateway is draining", type: "unavailable" }
          });
        }
        return yield* routed;
      });
    })
  );
  const nodeHandler = yield* createNodeHttpHandlerEffect(httpEffect);
  const server = createServer((req, res) => {
    const selected = active;
    selected.leases += 1;
    requestTargets.set(req, selected);
    if (retiring) {
      res.shouldKeepAlive = false;
      res.setHeader("connection", "close");
    }
    inflight += 1;
    res.once("close", () => {
      inflight -= 1;
      requestTargets.delete(req);
      selected.leases -= 1;
      if (selected.leases === 0) {
        for (const resolve of selected.waiters) resolve();
        selected.waiters.clear();
        if (selected !== active) generations.delete(selected.url);
      }
    });
    nodeHandler.handle(req, res);
  });
  yield* gatewayTryPromise(
    () =>
      new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(input.port ?? 0, host, () => {
          server.off("error", reject);
          resolve();
        });
      })
  );
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : (input.port ?? 0);
  const waitForInflight = (graceMs: number) =>
    Effect.gen(function* () {
      const deadline = Date.now() + graceMs;
      while (inflight > 0 && Date.now() < deadline) {
        yield* Effect.sleep("50 millis");
      }
    });
  const closeRetiringListener = (graceMs: number) =>
    Effect.gen(function* () {
      server.closeIdleConnections();
      const closed = gatewayTryPromise(
        () => new Promise<void>((resolve) => server.close(() => resolve()))
      );
      yield* waitForInflight(graceMs);
      if (inflight > 0) server.closeAllConnections();
      yield* closed;
      yield* nodeHandler.close;
    });
  const retireDone = Deferred.makeUnsafe<void, Error>();
  let retireStarted = false;
  const retire = (graceMs = 0): Effect.Effect<void, Error> =>
    Effect.suspend(() => {
      if (retireStarted) return Deferred.await(retireDone);
      retireStarted = true;
      const program = Effect.sync(() => {
        retiring = true;
      }).pipe(Effect.andThen(closeRetiringListener(graceMs)));
      return Deferred.complete(retireDone, program).pipe(
        Effect.andThen(Deferred.await(retireDone))
      );
    });
  const drainDone = Deferred.makeUnsafe<void, Error>();
  let drainStarted = false;
  const drain = (graceMs = 0): Effect.Effect<void, Error> =>
    Effect.suspend(() => {
      if (drainStarted) return Deferred.await(drainDone);
      drainStarted = true;
      const program = Effect.gen(function* () {
        draining = true;
        server.closeIdleConnections();
        yield* waitForInflight(graceMs);
        const closed = gatewayTryPromise(
          () => new Promise<void>((resolve) => server.close(() => resolve()))
        );
        server.closeAllConnections();
        yield* closed;
        yield* nodeHandler.close;
      });
      return Deferred.complete(drainDone, program).pipe(Effect.andThen(Deferred.await(drainDone)));
    });
  return {
    url: () => `http://${host.includes(":") ? `[${host}]` : host}:${port}`,
    port: () => port,
    target: () => active.url,
    swapTarget(next) {
      const previous = active.url;
      const url = trimTrailingSlashes(next);
      active = generations.get(url) ?? { url, leases: 0, waiters: new Set() };
      generations.set(url, active);
      return previous;
    },
    waitForTargetIdle(url, graceMs) {
      return Effect.suspend(() => {
        const generation = generations.get(trimTrailingSlashes(url));
        if (generation === undefined || generation.leases === 0) return Effect.succeed(true);
        return Effect.callback<boolean>((resume) => {
          let timer: NodeJS.Timeout | undefined;
          const done = (): void => {
            if (timer !== undefined) clearTimeout(timer);
            if (generation !== active && generation.leases === 0) {
              generations.delete(generation.url);
            }
            resume(Effect.succeed(true));
          };
          generation.waiters.add(done);
          timer = setTimeout(() => {
            generation.waiters.delete(done);
            resume(Effect.succeed(false));
          }, graceMs);
          return Effect.sync(() => {
            if (timer !== undefined) clearTimeout(timer);
            generation.waiters.delete(done);
          });
        });
      });
    },
    retire,
    drain,
    close: drain(0)
  };
});

export function startSwitchingGatewayProxyEffect(
  input: SwitchingGatewayProxyOptions
): Effect.Effect<SwitchingGatewayProxy, Error, RouteKitPlatform> {
  return startSwitchingGatewayProxyOperation(input);
}

function switchingGatewayLive(
  input: SwitchingGatewayProxyOptions
): Layer.Layer<SwitchingGatewayRuntime, Error> {
  return Layer.effect(
    SwitchingGatewayRuntime,
    Effect.acquireRelease(startSwitchingGatewayProxyEffect(input), (proxy) =>
      proxy.close.pipe(Effect.ignore)
    )
  ).pipe(Layer.provide(RouteKitLive));
}

/** Promise adapter for the singleton daemon host. */
export async function startSwitchingGatewayProxy(
  input: SwitchingGatewayProxyOptions
): Promise<SwitchingGatewayProxy> {
  const runtime = ManagedRuntime.make(switchingGatewayLive(input));
  try {
    const proxy = await runtime.runPromise(SwitchingGatewayRuntime);
    let closeRun: Promise<void> | undefined;
    const disposeRuntime = Effect.tryPromise({
      try: () => {
        closeRun ??= runtime.dispose();
        return closeRun;
      },
      catch: toRouteKitFailure
    }).pipe(Effect.ignore);
    const close = proxy.close.pipe(Effect.ensuring(disposeRuntime));
    return { ...proxy, close };
  } catch (error) {
    await runtime.dispose().catch(() => undefined);
    throw error;
  }
}
