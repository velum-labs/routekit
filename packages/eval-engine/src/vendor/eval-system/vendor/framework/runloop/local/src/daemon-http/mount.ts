import type { HttpServerError } from "effect/unstable/http";

import { Effect, FileSystem, Layer, Option, Path } from "effect";
import {
  Etag,
  HttpPlatform,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import type { RuntimeEventJournal } from "../../../../engine/events/src/event-journal-service.ts";
import type { AgentSessionStore } from "../../../../engine/session/src/session-store-service.ts";
import type { DaemonRequestContext } from "../daemon/server/server-types.ts";
import type { DevLogStore } from "../dev/log-store.ts";
import type { FeatureRuntime } from "../feature-runtime/service.ts";

import { DaemonHttpApi } from "./api.ts";
import {
  eventsHttpHandlers,
  featuresHttpHandlers,
  healthHttpHandlers,
  logsHttpHandlers,
  sessionsHttpHandlers,
} from "./handlers.ts";
import { DaemonHttpRequestContext } from "./request-context.ts";
import { scheduleHttpHandlers } from "../schedule/schedule-http-handlers.ts";

/**
 * The ambient daemon services the mounted handlers read from the fiber context
 * the daemon runtime provides per request. NONE of these is baked into the
 * build-time `appLayer` (below): a build-time context value silently shadows the
 * per-request/ambient value on a key collision, so every per-request or singleton
 * service stays ambient. All four are `DaemonRuntimeServices` members, so
 * `runtime.runPromise` in `daemon-server` discharges them for free.
 */
type DaemonHttpAmbient =
  | AgentSessionStore
  | DevLogStore
  | FeatureRuntime
  | RuntimeEventJournal;

// The platform services `HttpApiBuilder.layer` requires to build its router.
// All stateless (posix Path, weak Etag, no-op FileSystem), so the built router
// holds no scoped resources — which is why it can be built once and reused
// across requests even after the build scope closes (see `builtRoute`).
const PlatformLive = Layer.mergeAll(
  HttpPlatform.layer,
  Path.layer,
  Etag.layerWeak
).pipe(Layer.provideMerge(FileSystem.layerNoop({})));

// The mount's app layer: every group's handlers plus the platform services. It
// deliberately does NOT provide the ambient daemon services, `Logger`, or the
// per-request `DaemonHttpRequestContext` — a build-time context value silently
// shadows the per-request/ambient value on a key collision, so every per-request
// service must be provided per call, never baked in here (the #1261 hard rule).
const appLayer = HttpApiBuilder.layer(DaemonHttpApi).pipe(
  Layer.provide(scheduleHttpHandlers),
  Layer.provide(sessionsHttpHandlers),
  Layer.provide(eventsHttpHandlers),
  Layer.provide(logsHttpHandlers),
  Layer.provide(featuresHttpHandlers),
  Layer.provide(healthHttpHandlers),
  Layer.provide(PlatformLive)
);

// Build the router ONCE and reuse it for every request. `toHttpEffect` builds
// the router via `Layer.build` and yields an inner effect that reads the
// request from its fiber context on each run; `Effect.cached` memoizes that
// build so the daemon shares a single router across all requests. Safe because
// the app layer is stateless (above).
const builtRoute = Effect.runSync(
  Effect.cached(HttpRouter.toHttpEffect(appLayer))
);

/**
 * Try to serve one request through the daemon HttpApi mount. Returns the
 * `Response` on a route match, or `undefined` on no match so the daemon
 * fall-through can try its remaining raw route groups.
 *
 * The unary read surface (schedules, sessions, events list, log-runs list,
 * features introspection, health) lives here; every stream stays raw in
 * `daemon-server` and is matched BEFORE this mount, because HttpApi v4 has no
 * NDJSON/text stream schema and those wire formats must not change.
 * `HttpServerRequest` and the per-request `DaemonHttpRequestContext` are provided
 * per call; the ambient daemon services stay ambient from the daemon runtime. On
 * no match the router fails with `HttpServerError` whose `reason._tag` is
 * `"RouteNotFound"` (the outer tag is `HttpServerError`, NOT a top-level
 * `RouteNotFound`) — caught here and turned into `undefined`; any other
 * `HttpServerError` re-fails to the daemon's error envelope.
 */
export const matchDaemonHttpApiRoute = (
  request: Request,
  context: DaemonRequestContext
): Effect.Effect<
  Response | undefined,
  HttpServerError.HttpServerError,
  DaemonHttpAmbient
> =>
  builtRoute.pipe(
    Effect.flatMap((route) =>
      route.pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(request)
        ),
        Effect.provideService(DaemonHttpRequestContext, context)
      )
    ),
    Effect.map((response) => Option.some(HttpServerResponse.toWeb(response))),
    Effect.catchTag("HttpServerError", (error) =>
      error.reason._tag === "RouteNotFound"
        ? Effect.succeedNone
        : Effect.fail(error)
    ),
    Effect.scoped,
    Effect.map(Option.getOrUndefined)
  );
