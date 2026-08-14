import type { IncomingMessage } from "node:http";

import { routeKitError, toRouteKitFailure } from "@velum-labs/routekit-runtime/effect";
import { Effect, Scope } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import * as HttpEffect from "effect/unstable/http/HttpEffect";
import { HttpServerError } from "effect/unstable/http/HttpServerError";

import { parsePrincipalHeader, ROUTEKIT_PRINCIPAL_HEADER } from "./auth.js";
import type {
  EndpointContext,
  EndpointModelCall,
  GatewayEndpoint
} from "./endpoints/endpoint-module.js";
import { gatewayErrorResponse } from "./gateway-errors.js";
import { NO_BODY, readJson } from "./http-request.js";
import { handleModelCall, type ModelCallRoute, streamFetchResponse } from "./model-call-service.js";
import type { ProvenanceSink } from "./provenance.js";

export type GatewayHttpState = {
  draining: () => boolean;
  endpoints: readonly Pick<GatewayEndpoint<string>, "matches" | "handle">[];
  provenance: ProvenanceSink | undefined;
};

function jsonResponse(
  status: number,
  value: unknown,
  headers: Readonly<Record<string, string>> = {}
): HttpServerResponse.HttpServerResponse {
  return HttpServerResponse.jsonUnsafe(value, { status, headers });
}

function incomingRequest(request: HttpServerRequest.HttpServerRequest): IncomingMessage {
  return request.source as IncomingMessage;
}

function capturedTransport(nodeReq: IncomingMessage): {
  context: (method: string, url: URL) => EndpointContext;
  finish: (
    provenance: ProvenanceSink | undefined,
    principal?: ModelCallRoute["principal"]
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, never, Scope.Scope>;
} {
  const headers: Record<string, string> = {};
  let json: { status: number; value: unknown } | undefined;
  let piped: Response | undefined;
  let dispatched: EndpointModelCall | undefined;
  const transport = {
    readJson: async () => {
      const body = await readJson(nodeReq, (status, value) => {
        json = { status, value };
      });
      return body === NO_BODY ? undefined : body;
    },
    writeJson: (status: number, value: unknown) => {
      json = { status, value };
    },
    setHeader: (name: string, value: string) => {
      headers[name] = value;
    },
    pipe: async (upstream: Response) => {
      piped = upstream;
    },
    dispatch: async (call: EndpointModelCall) => {
      dispatched = call;
    }
  };
  return {
    context: (method, url) => ({
      method,
      url,
      headers: nodeReq.headers,
      transport
    }),
    finish: (provenance, principal) => {
      if (json !== undefined) return Effect.succeed(jsonResponse(json.status, json.value, headers));
      if (piped !== undefined) {
        const upstream = piped;
        return Effect.sync(() =>
          HttpEffect.scopeTransferToStream(streamFetchResponse(upstream, headers))
        );
      }
      if (dispatched !== undefined) {
        return handleModelCall(
          provenance,
          {
            ...dispatched,
            ...(principal !== undefined ? { principal } : {})
          },
          headers
        );
      }
      return Effect.succeed(HttpServerResponse.empty({ status: 204 }));
    }
  };
}

function serveEndpoint(
  endpoint: Pick<GatewayEndpoint<string>, "handle">,
  request: HttpServerRequest.HttpServerRequest,
  provenance: ProvenanceSink | undefined
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, Scope.Scope> {
  const nodeReq = incomingRequest(request);
  const url = new URL(request.url, "http://localhost");
  const captured = capturedTransport(nodeReq);
  const headerPrincipal = parsePrincipalHeader(
    typeof nodeReq.headers[ROUTEKIT_PRINCIPAL_HEADER] === "string"
      ? nodeReq.headers[ROUTEKIT_PRINCIPAL_HEADER]
      : undefined
  );
  const principal =
    headerPrincipal === undefined
      ? undefined
      : { token_id: headerPrincipal.id, label: headerPrincipal.label };
  return Effect.tryPromise({
    try: () => endpoint.handle(captured.context(request.method, url)),
    catch: (error) => toRouteKitFailure(error)
  }).pipe(
    Effect.flatMap(() => captured.finish(provenance, principal)),
    Effect.catch((error) => Effect.succeed(gatewayErrorResponse(routeKitError(error))))
  );
}

const GATEWAY_ROUTES: ReadonlyArray<{
  method: "GET" | "POST";
  path: `/${string}`;
}> = [
  { method: "GET", path: "/usage" },
  { method: "GET", path: "/models" },
  { method: "GET", path: "/backend-api/codex/models" },
  { method: "GET", path: "/v1/cursor/models" },
  { method: "GET", path: "/v1/models/*" },
  { method: "POST", path: "/v1/chat/completions" },
  { method: "POST", path: "/chat/completions" },
  { method: "POST", path: "/v1/cursor/chat/completions" },
  { method: "POST", path: "/v1/embeddings" },
  { method: "POST", path: "/v1/messages" },
  { method: "POST", path: "/v1/messages/count_tokens" },
  { method: "POST", path: "/v1/responses" },
  { method: "POST", path: "/backend-api/codex/responses" }
];

export function buildGatewayHttpEffect(state: GatewayHttpState) {
  return Effect.gen(function* () {
    const router = yield* HttpRouter.make;
    for (const route of GATEWAY_ROUTES) {
      yield* router.add(route.method, route.path, (request) => {
        const url = new URL(request.url, "http://localhost");
        const endpoint = state.endpoints.find((candidate) =>
          candidate.matches(request.method, url.pathname)
        );
        if (endpoint === undefined) {
          return Effect.succeed(
            jsonResponse(404, {
              error: {
                message: `no route for ${request.method} ${url.pathname}`,
                type: "not_found"
              }
            })
          );
        }
        return serveEndpoint(endpoint, request, state.provenance);
      });
    }
    return router;
  }).pipe(
    Effect.map((router) => {
      const routed = router.asHttpEffect();
      return Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        if (url.pathname === "/health") {
          return jsonResponse(state.draining() ? 503 : 200, {
            status: state.draining() ? "draining" : "ok"
          });
        }
        if (state.draining()) {
          return jsonResponse(503, {
            error: { message: "gateway is draining", type: "unavailable" }
          });
        }
        return yield* routed;
      }).pipe(
        Effect.catch((error) => {
          if (error instanceof HttpServerError && error.reason._tag === "RouteNotFound") {
            const url = new URL(error.request.url, "http://localhost");
            return Effect.succeed(
              jsonResponse(404, {
                error: {
                  message: `no route for ${error.request.method} ${url.pathname}`,
                  type: "not_found"
                }
              })
            );
          }
          return Effect.succeed(gatewayErrorResponse(error));
        })
      );
    })
  );
}
