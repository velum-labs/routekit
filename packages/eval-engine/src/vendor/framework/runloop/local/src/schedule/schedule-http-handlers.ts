import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import { DaemonHttpApi } from "../daemon-http/api.ts";
import { DaemonHttpRequestContext } from "../daemon-http/request-context.ts";
import { dispatchBody } from "../daemon/server/server-dev-schedule.ts";
import {
  listSchedulesBody,
  parseRunLimit,
  scheduleDetailBody,
  scheduleRunsBody,
} from "./introspect-handlers.ts";

/**
 * Server handlers for the schedules group of the daemon HttpApi. Each delegates
 * to the shared body projection (single source of the domain logic) and returns
 * the success body or fails the tag-free domain-error struct; HttpApi encodes
 * each at its declared status. `FeatureRuntime` (read by the projections) and the
 * per-request {@link DaemonHttpRequestContext} flow from the fiber context the
 * mount provides per call.
 */
export const scheduleHttpHandlers = HttpApiBuilder.group(
  DaemonHttpApi,
  "schedules",
  (handlers) =>
    handlers
      .handle("list", () =>
        Effect.gen(function* () {
          const context = yield* DaemonHttpRequestContext;
          return yield* listSchedulesBody(context.featuresRoot);
        })
      )
      .handle("detail", ({ params }) =>
        Effect.gen(function* () {
          const context = yield* DaemonHttpRequestContext;
          return yield* scheduleDetailBody(context.featuresRoot, params.name);
        })
      )
      .handle("runs", ({ params, query }) =>
        Effect.gen(function* () {
          const context = yield* DaemonHttpRequestContext;
          return yield* scheduleRunsBody(
            context.featuresRoot,
            params.name,
            parseRunLimit(query.limit ?? null)
          );
        })
      )
      .handle("trigger", ({ params }) =>
        Effect.gen(function* () {
          const context = yield* DaemonHttpRequestContext;
          return yield* dispatchBody(params.name, context);
        })
      )
);
