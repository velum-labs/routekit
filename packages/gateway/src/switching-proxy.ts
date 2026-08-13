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

import { assertAuthenticatedBind, trimTrailingSlashes } from "@velum-labs/routekit-runtime";
import {
  createNodeHttpHandler,
  fetchViaHttpClient,
  runRouteKitEffect
} from "@velum-labs/routekit-runtime/effect";
import { Effect, Stream } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import * as HttpEffect from "effect/unstable/http/HttpEffect";
import {
  authorizedRequest,
  type GatewayPrincipal,
  ROUTEKIT_PRINCIPAL_HEADER,
  resolvePrincipal
} from "./auth.js";

const MAX_BODY_BYTES = 16 * 1024 * 1024;
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
  waitForTargetIdle(target: string, graceMs: number): Promise<boolean>;
  retire(graceMs?: number): Promise<void>;
  drain(graceMs?: number): Promise<void>;
  close(): Promise<void>;
};

function requestHeaders(headers: IncomingHttpHeaders, principal?: GatewayPrincipal): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (
      value === undefined ||
      HOP_BY_HOP.has(lower) ||
      lower === "host" ||
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
  }
  return result;
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

export async function startSwitchingGatewayProxy(input: {
  target: string;
  host?: string;
  port?: number;
  authToken?: string;
  /** Resolve a named data-plane principal; preferred over `authToken` alone. */
  resolveDataPrincipal?: (presented: string) => GatewayPrincipal | undefined;
}): Promise<SwitchingGatewayProxy> {
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
  let draining = false;
  let retiring = false;
  let inflight = 0;
  const httpEffect = await runRouteKitEffect(
    Effect.gen(function* () {
      const router = yield* HttpRouter.make;
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
          const selected = active;
          selected.leases += 1;
          const releaseLease = (): void => {
            selected.leases -= 1;
            if (selected.leases === 0) {
              for (const resolve of selected.waiters) resolve();
              selected.waiters.clear();
              if (selected !== active) generations.delete(selected.url);
            }
          };
          const aborter = yield* Effect.acquireRelease(
            Effect.sync(() => new AbortController()),
            (controller) =>
              Effect.sync(() => {
                controller.abort(new Error("gateway client disconnected"));
                releaseLease();
              })
          );
          const proxied = yield* Effect.tryPromise({
            try: async () => {
              const body = await requestBody(nodeReq);
              return await fetchViaHttpClient(`${selected.url}${path}`, {
                method: nodeReq.method ?? "GET",
                headers: requestHeaders(nodeReq.headers, principal),
                ...(body !== undefined ? { body } : {}),
                signal: AbortSignal.any([aborter.signal, AbortSignal.timeout(10 * 60 * 1000)])
              });
            },
            catch: (error) => error
          }).pipe(
            Effect.map((upstream) =>
              HttpEffect.scopeTransferToStream(proxyResponse(upstream, retiring))
            ),
            Effect.catch(() =>
              Effect.succeed(
                jsonResponse(502, {
                  error: { message: "router generation unavailable", type: "upstream_error" }
                })
              )
            )
          );
          return proxied;
        })
      );
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
  const nodeHandler = await createNodeHttpHandler(httpEffect);
  const server = createServer((req, res) => {
    if (retiring) {
      res.shouldKeepAlive = false;
      res.setHeader("connection", "close");
    }
    inflight += 1;
    res.once("close", () => {
      inflight -= 1;
    });
    nodeHandler.handle(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(input.port ?? 0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : (input.port ?? 0);
  let drainRun: Promise<void> | undefined;
  let retireRun: Promise<void> | undefined;
  const waitForInflight = async (graceMs: number): Promise<void> => {
    const deadline = Date.now() + graceMs;
    while (inflight > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  const closeRetiringListener = async (graceMs: number): Promise<void> => {
    server.closeIdleConnections();
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    await waitForInflight(graceMs);
    if (inflight > 0) server.closeAllConnections();
    await closed;
    await nodeHandler.close();
  };
  const retire = (graceMs = 0): Promise<void> => {
    retireRun ??= (async () => {
      retiring = true;
      await closeRetiringListener(graceMs);
    })();
    return retireRun;
  };
  const drain = (graceMs = 0): Promise<void> => {
    drainRun ??= (async () => {
      draining = true;
      server.closeIdleConnections();
      await waitForInflight(graceMs);
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
      await nodeHandler.close();
    })();
    return drainRun;
  };
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
    async waitForTargetIdle(url, graceMs) {
      const generation = generations.get(trimTrailingSlashes(url));
      if (generation === undefined || generation.leases === 0) return true;
      let timer: NodeJS.Timeout | undefined;
      const idle = new Promise<boolean>((resolve) => {
        const done = (): void => {
          if (timer !== undefined) clearTimeout(timer);
          resolve(true);
        };
        generation.waiters.add(done);
        timer = setTimeout(() => {
          generation.waiters.delete(done);
          resolve(false);
        }, graceMs);
      });
      const result = await idle;
      if (generation !== active && generation.leases === 0) generations.delete(generation.url);
      return result;
    },
    retire,
    drain,
    close: async () => await drain(0)
  };
}
