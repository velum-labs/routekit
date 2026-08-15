import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import { DaemonHttpApi } from "./api.ts";
import { featuresIntrospectionBody } from "./features-body.ts";
import { DaemonHttpRequestContext } from "./request-context.ts";
import {
  listLogRunsBody,
  listPersistedSessionsBody,
  listRuntimeEventsBody,
  listSessionsBody,
  sessionDetailBody,
  sessionEventsBody,
  sessionLineageBody,
} from "./session-bodies.ts";

const DAEMON_SERVICE_NAME = "routekit-eval-runtime";

/**
 * Sessions group handlers. `list`, `persisted`, and `lineage`/`detail`/`events`
 * all read ambient daemon services (the in-memory registry, the disk log store),
 * so none touches the per-request context. HttpApi percent-decodes each `:id`
 * before the handler sees it, so a session id with a space arrives decoded.
 */
export const sessionsHttpHandlers = HttpApiBuilder.group(
  DaemonHttpApi,
  "sessions",
  (handlers) =>
    handlers
      .handle("list", () => listSessionsBody)
      .handle("persisted", () => listPersistedSessionsBody)
      .handle("detail", ({ params }) => sessionDetailBody(params.id))
      .handle("events", ({ params }) => sessionEventsBody(params.id))
      .handle("lineage", ({ params }) => sessionLineageBody(params.id))
);

/**
 * Events group handler: the unary `GET /api/events` journal read (the `?stream`
 * NDJSON tail stays raw). The optional `?sessionId=` filter arrives as a query
 * string; an absent filter returns every entry.
 */
export const eventsHttpHandlers = HttpApiBuilder.group(
  DaemonHttpApi,
  "events",
  (handlers) =>
    handlers.handle("list", ({ query }) =>
      listRuntimeEventsBody(query.sessionId)
    )
);

/** Logs group handler: the `GET /api/logs/runs` list (the `:id` tail stays raw). */
export const logsHttpHandlers = HttpApiBuilder.group(
  DaemonHttpApi,
  "logs",
  (handlers) => handlers.handle("runs", () => listLogRunsBody)
);

/**
 * Features group handler: `GET /api/features` introspection. Reads the
 * per-request {@link DaemonHttpRequestContext} for the features root, then the
 * ambient `FeatureRuntime` inside the body projection.
 */
export const featuresHttpHandlers = HttpApiBuilder.group(
  DaemonHttpApi,
  "features",
  (handlers) =>
    handlers.handle("list", () =>
      Effect.gen(function* () {
        const context = yield* DaemonHttpRequestContext;
        return yield* featuresIntrospectionBody(context.featuresRoot);
      })
    )
);

/** Health group handler: the daemon liveness probe, a constant body. */
export const healthHttpHandlers = HttpApiBuilder.group(
  DaemonHttpApi,
  "health",
  (handlers) =>
    handlers.handle("check", () =>
      Effect.succeed({
        ok: true,
        service: DAEMON_SERVICE_NAME,
      })
    )
);
