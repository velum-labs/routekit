import { Context } from "effect";

import type { DaemonRequestContext } from "../daemon/server/server-types.ts";

/**
 * The per-request daemon context (features root, host, port, remote address),
 * delivered to the HttpApi handlers as a service the mount `provideService`s per
 * call. It is NOT baked into the mount's build-time `appLayer`: a build-time
 * context value silently shadows any per-request value on a key collision, so
 * anything that varies per request (this context, `FeatureRuntime`, `Logger`)
 * must stay ambient / per-request (the hard rule proven in #1261).
 *
 * Only the schedules and features handlers actually read it (both need the
 * features root); the sessions/events/logs handlers read ambient daemon
 * services instead. One shared service still gets provided per call regardless,
 * so the mount has a single per-request seam rather than one per group.
 */
export class DaemonHttpRequestContext extends Context.Service<
  DaemonHttpRequestContext,
  DaemonRequestContext
>()("routekit-eval/runtime/DaemonHttpRequestContext") {}
