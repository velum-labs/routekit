import { Effect, Result } from "effect";

import type { ApiRouteContext } from "../../../../../contracts/author/src/index.ts";
import type { ApiContribution } from "../../../../../contracts/internal/src/author-schemas/api.ts";
import type { RouteTable } from "../../api/route-match.ts";
import type { DaemonRequestContext } from "../server/server-types.ts";
import type { FeatureBootResult } from "../../feature-boot/types.ts";

import { RuntimeServerError } from "../../../../../contracts/internal/src/errors.ts";
import { encodeDaemonErrorEnvelope } from "../../../../../contracts/internal/src/runtime/daemon-error.ts";
import { matchApiRoute } from "../../api/route-match.ts";
import { makeAuthorStoreResolver } from "../../author/store-resolver.ts";
import {
  INTERNAL_ERROR_STATUS,
  makeJsonResponse,
  METHOD_NOT_ALLOWED_STATUS,
} from "../core/http-response.ts";
import { FeatureRuntime } from "../../feature-runtime/service.ts";
import { featureLoggerFromContext } from "../../logging/support.ts";
import { formatUnknownError } from "../../../../../utils/core/src/error-formatting.ts";

type ApiRouteHandlerValue = NonNullable<ApiContribution["routes"]>[string];

/** A registered route handler paired with the feature that owns it. */
interface OwnedRouteHandler {
  readonly featureId: string;
  readonly handler: ApiRouteHandlerValue;
}

/**
 * Inspect the live feature boot, mirroring `introspect-handlers.ts`. Returns
 * `None` when no features root is bound (feature routes unavailable).
 */
const inspectFeatureBoot = Effect.fn("RuntimeHttp.apiInspectBoot")(function* (
  featuresRoot: string | undefined
) {
  if (featuresRoot === undefined) {
    return yield* Effect.succeedNone;
  }
  const featureRuntime = yield* FeatureRuntime;
  return yield* featureRuntime.inspect(featuresRoot).pipe(Effect.option);
});

/**
 * Aggregate every feature's `api.routes` into one daemon-root table, pairing
 * each handler with its owning feature id. Routes are served verbatim at the
 * daemon root (RFC 0002 api.md), so the table spans features; inter-feature
 * collisions were already resolved at registration (earlier boot order wins),
 * so a plain first-wins merge cannot silently drop a live route.
 */
const aggregateFeatureRoutes = (
  boot: FeatureBootResult
): RouteTable<OwnedRouteHandler> => {
  const table: Record<string, OwnedRouteHandler> = {};
  for (const entry of boot.apiRegistry.entries) {
    for (const [key, handler] of Object.entries(entry.api.routes ?? {})) {
      table[key] ??= {
        featureId: entry.featureId,
        handler,
      };
    }
  }
  return table;
};

/**
 * `405` with an `Allow` header listing the methods that DO match this path
 * (RFC 0002 api.md). Built directly rather than via `makeJsonResponse` so the
 * extra header rides along on the same response.
 */
const methodNotAllowedResponse = (allow: readonly string[]): Response =>
  Response.json(
    { error: "Method not allowed" },
    {
      headers: { allow: allow.join(", ") },
      status: METHOD_NOT_ALLOWED_STATUS,
    }
  );

/**
 * Invoke a feature route handler, bridging its (host, outside-Effect) execution
 * back into the Effect world. A thrown/rejected handler becomes a
 * `RuntimeServerError` so the daemon's standard 500 envelope + `logger.error`
 * apply — handler failures never crash the daemon (RFC 0002 api.md).
 */
const runRouteHandler = Effect.fn("RuntimeHttp.apiRouteHandler")(function* (
  handler: ApiRouteHandlerValue,
  request: Request,
  handlerContext: ApiRouteContext
) {
  return yield* Effect.tryPromise({
    catch: (cause) =>
      new RuntimeServerError({
        cause,
        detail: `Feature "${handlerContext.featureId}" route handler failed: ${formatUnknownError(cause)}`,
        operation: "handling feature api route",
      }),
    try: () => Promise.resolve(handler(request, handlerContext)),
  });
});

/** Build the standard daemon 500 envelope for a failed handler + log it. */
const handlerErrorResponse = Effect.fn("RuntimeHttp.apiRouteError")(function* (
  error: RuntimeServerError,
  handlerContext: ApiRouteContext
) {
  handlerContext.logger.error("api route handler failed", error);
  const envelope = yield* encodeDaemonErrorEnvelope(error);
  return makeJsonResponse(envelope, INTERNAL_ERROR_STATUS);
});

/**
 * Dispatch a request against the aggregated feature route table, served
 * verbatim at the daemon root (RFC 0002 api.md). Called LAST in the daemon's
 * route chain — after every built-in — so a feature can never shadow the
 * daemon's own surface ("built-ins win").
 *
 * Segment-exact matching with literal-first precedence and percent-decoded
 * `:name` params; `405` + `Allow` for a method miss, `500` (daemon envelope)
 * + `logger.error` for a throwing handler, and the handler's `Response`
 * passed through untouched otherwise.
 *
 * Returns `undefined` when no feature route's path matches, so the caller
 * falls through to its final 404, mirroring `matchScheduleHttpApiRoute`.
 */
export const matchFeatureApiRoute = Effect.fn("RuntimeHttp.featureApiRoute")(
  function* (request: Request, url: URL, context: DaemonRequestContext) {
    const boot = yield* inspectFeatureBoot(context.featuresRoot);
    if (boot._tag === "None") {
      return;
    }

    const routes = aggregateFeatureRoutes(boot.value);
    const result = matchApiRoute(routes, request.method, url.pathname);
    if (result.kind === "NotFound") {
      return;
    }
    if (result.kind === "MethodNotAllowed") {
      return methodNotAllowedResponse(result.allow);
    }

    const owned = result.match.handler;
    const effectContext = yield* Effect.context();
    // Routes always run in-daemon, so a resolved default store is expected;
    // resolve optionally so a project without a `db` contribution leaves
    // `stores` undefined rather than failing the route (RFC 0005).
    const state = yield* boot.value.dbRegistry.default.pipe(Effect.option);
    const handlerContext: ApiRouteContext = {
      featureId: owned.featureId,
      logger: featureLoggerFromContext(effectContext, `api:${owned.featureId}`),
      params: result.match.params,
      remoteAddress: context.remoteAddress,
      stores:
        state._tag === "Some"
          ? makeAuthorStoreResolver(effectContext, boot.value, state.value)
          : undefined,
      use: boot.value.apiRegistry.contextFor(owned.featureId).use,
    };

    const outcome = yield* runRouteHandler(
      owned.handler,
      request,
      handlerContext
    ).pipe(Effect.result);

    if (Result.isFailure(outcome)) {
      return yield* handlerErrorResponse(outcome.failure, handlerContext);
    }
    return outcome.success;
  }
);
