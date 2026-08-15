import type { Scope } from "effect";

import { Effect, Schema, Stream } from "effect";
import { Stdio } from "effect/Stdio";

import type {
  DaemonRequestContext,
  DaemonRuntime,
} from "./server-types.ts";

import {
  RuntimeServerError,
  RuntimeValidationError,
} from "../../../../../contracts/internal/src/errors.ts";
import { encodeDaemonErrorEnvelope } from "../../../../../contracts/internal/src/runtime/daemon-error.ts";
import { AgentInvokeCell } from "../../agent/invoke-cell.ts";
import { matchDaemonHttpApiRoute } from "../../daemon-http/mount.ts";
import { DaemonAddress } from "../core/address.ts";
import {
  BAD_REQUEST_STATUS,
  INTERNAL_ERROR_STATUS,
  makeJsonResponse,
  NOT_FOUND_STATUS,
} from "../core/http-response.ts";
import {
  handleInvokeRequest,
  matchCancelRequest,
} from "../invoke/invoke-route.ts";
import {
  matchEventStreamRoute,
  matchLogRunTailRoute,
  matchLogStreamRoute,
} from "../logging/log-routes.ts";
import { matchFeatureApiRoute } from "../routes/api-feature-routes.ts";
import { handleInteractionResponseRequest } from "../routes/interaction-route.ts";
import {
  deriveWorkspaceRoot,
  handleDevScheduleStreamResponse,
} from "./server-dev-schedule.ts";
import { FeatureRuntime } from "../../feature-runtime/service.ts";
import { makeScheduleRuntime } from "../../schedule/runner.ts";
import { formatUnknownError } from "../../../../../utils/core/src/error-formatting.ts";
import {
  serve,
  type NodeHttpServer,
} from "../../../../../../../runtime/node-http.ts";

const DEV_SCHEDULE_PREFIX = "/api/dev/schedules/";

// Streamed `/api/invoke` turns can idle >10s between bytes; a 10s idleTimeout
// would sever them mid-turn. 0 disables it — turns end with the stream.
const DISABLE_IDLE_TIMEOUT = 0;

/**
 * Give this daemon's hook handlers an agent `invoke` on the first request that
 * can supply one. Runs on every request, so an already-published cell is the
 * "already established" signal — a second runtime here would be a wasted build
 * whose `invoke` displaced the live one.
 *
 * Builds the runtime directly rather than through `acquireScheduleRuntime`
 * because the published `invoke` has to outlive the request that established
 * it. That helper binds MCP teardown to the ambient scope, and the only scope
 * this path could offer is the per-request one, which would close the
 * connections while the cell is still handing the invoke out.
 */
export const establishAgentInvokeHost = Effect.fn(
  "RuntimeHttp.establishAgentInvokeHost"
)(function* (context: DaemonRequestContext) {
  const agentInvoke = yield* AgentInvokeCell;
  if (agentInvoke.read() !== undefined) {
    return;
  }
  if (context.featuresRoot === undefined) {
    return;
  }

  const featureRuntime = yield* FeatureRuntime;
  const boot = yield* featureRuntime
    .inspect(context.featuresRoot)
    .pipe(Effect.option);
  if (boot._tag === "None") {
    return;
  }

  const store = yield* boot.value.dbRegistry.default.pipe(Effect.option);
  if (store._tag === "None") {
    return;
  }

  const runtime = makeScheduleRuntime({
    cwd: deriveWorkspaceRoot(context.featuresRoot),
    featuresRoot: context.featuresRoot,
    host: context.host,
    port: context.port,
    store: store.value,
    useFor: (featureId) => boot.value.apiRegistry.contextFor(featureId).use,
  });
  yield* agentInvoke.publish(runtime.invoke);
});

interface DaemonServerOptions {
  /** Expose dev-only routes such as `POST /api/dev/schedules/:name`. */
  readonly enableDevRoutes?: boolean | undefined;
  readonly featuresRoot?: string | undefined;
  readonly host: string;
  readonly makeRuntime: () => DaemonRuntime;
  readonly port: number;
  /** See {@link shouldLogDaemonBootLine}. */
  readonly suppressBootLine?: boolean | undefined;
}

/**
 * Whether the daemon prints its `[routekit-eval-runtime] listening …` boot line to stdout.
 * Suppressed only by `routekit-eval code` (inline/main-screen TUI), where a boot line on
 * stdout is painted over into a stray `[`. Kept everywhere else — `routekit-eval dev`/`routekit-eval
 * start` have no TUI, and the split session's alternate-screen TUI lets it
 * scroll into pre-alt scrollback (an integration test asserts it surfaces).
 * Distinct from `suppressAuditStdout`, which the split session also sets.
 */
const shouldLogDaemonBootLine = (options: {
  readonly suppressBootLine?: boolean | undefined;
}): boolean => options.suppressBootLine !== true;

const acquireDaemonRuntime = (
  options: DaemonServerOptions
): Effect.Effect<DaemonRuntime, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => options.makeRuntime()),
    (runtime) => Effect.promise(() => runtime.dispose()).pipe(Effect.orDie)
  );

/**
 * Map a wildcard bind address to a connectable loopback address. A daemon bound
 * to `0.0.0.0`/`::` listens on all interfaces, but those are not valid *connect*
 * targets on every platform — clients (the request context, the schedule runner)
 * must dial `127.0.0.1` instead.
 */
const loopbackHost = (hostname: string): string =>
  hostname === "0.0.0.0" || hostname === "::" ? "127.0.0.1" : hostname;

const logDaemonServer = Effect.fn("RuntimeHttp.logServer")(function* (
  hostname: string,
  port: number
) {
  const stdio = yield* Stdio;
  yield* Stream.succeed(
    `[routekit-eval-runtime] listening on http://${hostname}:${port}\n`
  ).pipe(Stream.run(stdio.stdout({ endOnDone: false })), Effect.ignore);
});

/**
 * Match the always-on raw STREAM routes that the daemon HttpApi mount cannot
 * model (the live event NDJSON tail and the text/plain log tail). Matched before
 * the mount so a streaming path never reaches it. Returns `undefined` for
 * non-matching requests so the caller can fall through.
 */
const matchCoreStreamRoute = Effect.fn("RuntimeHttp.coreStreamRoute")(
  function* (request: Request, url: URL) {
    if (request.method !== "GET") {
      return;
    }

    const eventStream = yield* matchEventStreamRoute(url);
    if (eventStream !== undefined) {
      return eventStream;
    }

    return yield* matchLogStreamRoute(url);
  }
);

/**
 * How the schedules surface should route one request, decided before any I/O so
 * the dev-route gate is unit-testable in isolation:
 * - `"stream"`: the raw NDJSON dispatch (dev routes on, `?stream`), matched
 *   before the HttpApi mount because HttpApi v4 cannot model NDJSON.
 * - `"mount"`: the unary HttpApi mount (all GET reads, plus the bare dev POST
 *   `trigger` ONLY when dev routes are enabled).
 * - `"skip"`: bypass both — a dev POST while dev routes are disabled, so it must
 *   fall through to the final 404 rather than reach the unconditional mount
 *   (`routekit-eval start`/`routekit-eval eval` keep refusing `POST /api/dev/schedules/:name`).
 */
const classifyScheduleRouting = (
  method: string,
  url: URL,
  enableDevRoutes: boolean
): "stream" | "mount" | "skip" => {
  const isDevSchedulePost =
    method === "POST" && url.pathname.startsWith(DEV_SCHEDULE_PREFIX);
  if (!isDevSchedulePost) {
    return "mount";
  }
  if (!enableDevRoutes) {
    return "skip";
  }
  return url.searchParams.has("stream") ? "stream" : "mount";
};

const matchAgentWriteRoute = Effect.fn("RuntimeHttp.agentWriteRoute")(
  function* (request: Request, url: URL) {
    if (request.method !== "POST") {
      return;
    }
    if (url.pathname === "/api/invoke") {
      return yield* handleInvokeRequest(request);
    }
    const cancelResponse = yield* matchCancelRequest(request, url);
    if (cancelResponse !== undefined) {
      return cancelResponse;
    }
    if (url.pathname === "/api/interactions/respond") {
      return yield* handleInteractionResponseRequest(request);
    }
  }
);

const handleRuntimeRequest = Effect.fn("RuntimeHttp.handleRequest")(function* (
  request: Request,
  context: DaemonRequestContext
) {
  const url = new URL(request.url);

  const routing = classifyScheduleRouting(
    request.method,
    url,
    context.enableDevRoutes
  );
  if (routing === "stream") {
    return yield* handleDevScheduleStreamResponse(
      decodeURIComponent(url.pathname.slice(DEV_SCHEDULE_PREFIX.length)),
      context
    );
  }

  // Raw stream routes are matched BEFORE the mount: HttpApi v4 cannot model
  // NDJSON/text tails, so they must never reach the mount. `/api/events/stream`
  // and `/api/logs/stream` sit next to `/api/events` and `/api/logs/runs` (both
  // moved into the mount), so a mismatched prefix here would otherwise be a
  // silent regression.
  const streamResponse = yield* matchCoreStreamRoute(request, url);
  if (streamResponse !== undefined) {
    return streamResponse;
  }

  // The consolidated daemon HttpApi mount: every unary read (health, sessions,
  // events list, log-runs list, features introspection) plus the dev-only
  // schedule trigger POST. `skip` (a dev POST while dev routes are disabled)
  // bypasses the mount so the unconditional `trigger` endpoint never serves it,
  // falling through to the final 404 — `routekit-eval start`/`routekit-eval eval` keep refusing it.
  if (routing === "mount") {
    const mountResponse = yield* matchDaemonHttpApiRoute(request, context);
    if (mountResponse !== undefined) {
      return mountResponse;
    }
  }

  // The per-run NDJSON tail stays raw; its `:id` form does not match the mount's
  // exact `/api/logs/runs` list endpoint, so it cleanly falls through to here.
  const logTailResponse = yield* matchLogRunTailRoute(request.method, url);
  if (logTailResponse !== undefined) {
    return logTailResponse;
  }

  const agentWriteResponse = yield* matchAgentWriteRoute(request, url);
  if (agentWriteResponse !== undefined) {
    return agentWriteResponse;
  }

  // Feature routes match last so they cannot shadow the daemon's own surface.
  const featureApiResponse = yield* matchFeatureApiRoute(request, url, context);
  if (featureApiResponse !== undefined) {
    return featureApiResponse;
  }

  return makeJsonResponse(
    {
      error: "Not found",
    },
    NOT_FOUND_STATUS
  );
});

const handleRuntimeFetch = Effect.fn("Daemon.handleRuntimeFetch")(function* (
  request: Request,
  context: DaemonRequestContext
) {
  return yield* Effect.gen(function* () {
    yield* establishAgentInvokeHost(context);
    return yield* handleRuntimeRequest(request, context);
  }).pipe(
    Effect.catch((error) =>
      encodeDaemonErrorEnvelope(error).pipe(
        Effect.map((envelope) =>
          makeJsonResponse(
            envelope,
            Schema.is(RuntimeValidationError)(error)
              ? BAD_REQUEST_STATUS
              : INTERNAL_ERROR_STATUS
          )
        )
      )
    )
  );
});

const startDaemonHttpServer = (
  runtime: DaemonRuntime,
  options: DaemonServerOptions
): Effect.Effect<NodeHttpServer, RuntimeServerError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.tryPromise({
      catch: (cause) =>
        new RuntimeServerError({
          cause,
          detail: formatUnknownError(cause),
          operation: "starting server",
        }),
      try: () =>
        serve({
          fetch: (request, server) =>
            runtime.runPromise(
              handleRuntimeFetch(request, {
                enableDevRoutes: options.enableDevRoutes ?? false,
                featuresRoot: options.featuresRoot,
                host: loopbackHost(server.hostname ?? options.host),
                port: server.port ?? options.port,
                remoteAddress: server.requestIP(request)?.address,
              })
            ),
          hostname: options.host,
          idleTimeout: DISABLE_IDLE_TIMEOUT,
          port: options.port,
        }),
    }),
    (server) =>
      Effect.sync(() => {
        server.stop(true);
      }).pipe(Effect.orDie)
  );

export const runDaemonServer = Effect.fn("RuntimeHttp.runDaemonServer")(
  function* (options: DaemonServerOptions) {
    const runtime = yield* acquireDaemonRuntime(options);
    const server = yield* startDaemonHttpServer(runtime, options);

    const hostname = server.hostname ?? options.host;
    const port = server.port ?? options.port;

    // Publish the connectable base URL into the runtime so daemon-side
    // consumers (the rollover seed prompt) can hand out absolute API links;
    // the port may be ephemeral, so it is only knowable here.
    yield* Effect.promise(() =>
      runtime.runPromise(
        Effect.gen(function* () {
          const address = yield* DaemonAddress;
          yield* address.set(`http://${loopbackHost(hostname)}:${port}`);
        })
      )
    );

    if (shouldLogDaemonBootLine(options)) {
      yield* logDaemonServer(hostname, port);
    }

    return {
      hostname,
      port,
      server,
    };
  }
);

export { shouldLogDaemonBootLine, loopbackHost, classifyScheduleRouting };
export type { DaemonRuntime, DaemonServerOptions };
