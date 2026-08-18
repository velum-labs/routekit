import { Effect, Stream } from "effect";

import type { ScheduleDispatchResponse } from "../../../../../contracts/internal/src/runtime/schedule-introspection.ts";
import type { DaemonRequestContext } from "./server-types.ts";
import type {
  ScheduleUnavailableErrorBody,
  UnknownScheduleErrorBody,
} from "../../schedule/schedule-http-api.ts";

import { RuntimeServerError } from "../../../../../contracts/internal/src/errors.ts";
import {
  INTERNAL_ERROR_STATUS,
  makeJsonResponse,
  NOT_FOUND_STATUS,
} from "../core/http-response.ts";
import { FeatureRuntime } from "../../feature-runtime/service.ts";
import { featureLoggerFromContext } from "../../logging/support.ts";
import {
  fireScheduleDetachedEffect,
  streamScheduleFire,
} from "../../schedule/fire.ts";
import { makeScheduleRuntime } from "../../schedule/runner.ts";
import { formatUnknownError } from "../../../../../utils/core/src/error-formatting.ts";

type DevScheduleError = ScheduleUnavailableErrorBody | UnknownScheduleErrorBody;

const FEATURES_SUFFIX = "/features";

/**
 * Dev-only schedule dispatch (RFC 0008): fire a single schedule once by its
 * path-derived name. `ori dev` does not auto-fire schedules unless started with
 * `--enable-schedules`, so this is how a developer triggers one on demand. The
 * non-stream fire is detached — it returns as soon as the session id(s) are
 * known and lets the run finish in the background — so a slow agent run never
 * holds the HTTP response open; its outcome lands in run history.
 */
interface ResolvedDevSchedule {
  readonly definition: Parameters<
    typeof fireScheduleDetachedEffect
  >[0]["definition"];
  readonly featureId: string;
  readonly scheduleRuntime: ReturnType<typeof makeScheduleRuntime>;
}

/** Pipe a schedule fire's agent events to an NDJSON response, one event per line. */
const makeScheduleEventStreamResponse = (
  target: Parameters<typeof streamScheduleFire>[0]
): Response => {
  const { name } = target;
  const body = Stream.fromAsyncIterable(
    // Close this per-request runtime's MCP connections once the fire completes
    // (the shared cron runtime closes when the session scope releases instead).
    streamScheduleFire(target, () => {
      void target.runtime.closeMcp();
    }),
    (cause) =>
      new RuntimeServerError({
        cause,
        detail: `Schedule "${name}" stream failed: ${formatUnknownError(cause)}`,
        operation: "streaming schedule fire",
      })
  ).pipe(
    Stream.map((event) => `${JSON.stringify(event)}\n`),
    Stream.encodeText
  );

  return new Response(Stream.toReadableStream(body), {
    headers: {
      "cache-control": "no-cache",
      "content-type": "application/x-ndjson; charset=utf-8",
    },
  });
};

export const deriveWorkspaceRoot = (featuresRoot: string): string => {
  const trimmed = featuresRoot.endsWith("/")
    ? featuresRoot.slice(0, -1)
    : featuresRoot;
  return trimmed.endsWith(FEATURES_SUFFIX)
    ? trimmed.slice(0, -FEATURES_SUFFIX.length)
    : trimmed;
};

const unavailableError = (error: string): ScheduleUnavailableErrorBody => ({
  error,
});

/**
 * Resolve the prerequisites for a dev fire (features root, boot, schedule
 * definition, state store) and build the schedule runtime. Fails with the
 * tag-free domain-error struct (unavailable 500 / unknown-schedule 404) so both
 * the HttpApi `trigger` handler and the raw `?stream` path share one source of
 * the precondition checks; each caller maps the failure to its wire shape.
 */
const resolveDevScheduleDispatch = Effect.fn(
  "RuntimeHttp.resolveDevScheduleDispatch"
)(function* (
  name: string,
  context: DaemonRequestContext
): Effect.fn.Return<ResolvedDevSchedule, DevScheduleError, FeatureRuntime> {
  if (context.featuresRoot === undefined) {
    return yield* Effect.fail(
      unavailableError("No features root is configured for this runtime.")
    );
  }

  const featureRuntime = yield* FeatureRuntime;
  const boot = yield* featureRuntime
    .inspect(context.featuresRoot)
    .pipe(Effect.option);
  if (boot._tag === "None") {
    return yield* Effect.fail(
      unavailableError("Feature runtime is unavailable.")
    );
  }

  const scheduleEntry = boot.value.scheduleRegistry.entries.find(
    (entry) => entry.name === name
  );
  if (scheduleEntry === undefined) {
    return yield* Effect.fail({
      availableScheduleIds: boot.value.scheduleRegistry.entries.map(
        (entry) => entry.name
      ),
      error: `Unknown schedule "${name}".`,
    });
  }

  const store = yield* boot.value.dbRegistry.default.pipe(Effect.option);
  if (store._tag === "None") {
    return yield* Effect.fail(unavailableError("No state store is available."));
  }

  const effectContext = yield* Effect.context();
  const scheduleRuntime = makeScheduleRuntime({
    cwd: deriveWorkspaceRoot(context.featuresRoot),
    featuresRoot: context.featuresRoot,
    host: context.host,
    logger: featureLoggerFromContext(effectContext, `schedule:${name}`),
    port: context.port,
    store: store.value,
    useFor: (featureId) => boot.value.apiRegistry.contextFor(featureId).use,
  });

  return {
    definition: scheduleEntry.value,
    featureId: scheduleEntry.featureId,
    scheduleRuntime,
  };
});

const fireTarget = (
  name: string,
  resolved: ResolvedDevSchedule
): Parameters<typeof streamScheduleFire>[0] => ({
  definition: resolved.definition,
  featureId: resolved.featureId,
  name,
  runtime: resolved.scheduleRuntime,
});

/**
 * `POST /api/dev/schedules/:name` (non-stream) body: fire the schedule once and
 * return the started session id(s). Fails with the same domain-error structs as
 * {@link resolveDevScheduleDispatch}, which the HttpApi `trigger` endpoint
 * encodes at their declared statuses. The fire is detached — it returns as soon
 * as the session id(s) are known and lets the run finish in the background.
 */
export const dispatchBody = Effect.fn("RuntimeHttp.dispatchBody")(function* (
  name: string,
  context: DaemonRequestContext
): Effect.fn.Return<
  ScheduleDispatchResponse,
  DevScheduleError,
  FeatureRuntime
> {
  const resolved = yield* resolveDevScheduleDispatch(name, context);
  const target = fireTarget(name, resolved);
  // The detached fire can fail before the session ids are known. The raw route
  // let that `RuntimeServerError` escape to the daemon envelope wrapper (500);
  // the HttpApi endpoint declares only the domain structs, so map it to the
  // unavailable struct (also 500) to keep the error channel declared rather than
  // letting an undeclared error `orDie` into a defect the fall-through can't
  // recover.
  //
  // Close this per-request runtime's MCP connections once the fire completes.
  // The fire outlives this response (it resolves at first session), so teardown
  // is deferred to fire completion, not tied to the HTTP response.
  const sessionIds = yield* fireScheduleDetachedEffect(target, () => {
    void target.runtime.closeMcp();
  }).pipe(Effect.mapError((cause) => unavailableError(cause.message)));
  return {
    scheduleId: name,
    sessionIds,
  };
});

const devErrorResponse = (error: DevScheduleError): Response =>
  "availableScheduleIds" in error
    ? makeJsonResponse(error, NOT_FOUND_STATUS)
    : makeJsonResponse(error, INTERNAL_ERROR_STATUS);

/**
 * Raw `?stream` dispatch: fire the schedule and stream its agent events as
 * NDJSON. Kept out of the HttpApi mount because HttpApi v4 has no NDJSON stream
 * schema (only SSE / `Uint8Array`), and the wire format must not change (RFC
 * 0008). Precondition failures map to the same JSON status bodies the mount
 * emits, so the stream and unary surfaces stay wire-identical on error.
 */
export const handleDevScheduleStreamResponse = Effect.fn(
  "RuntimeHttp.devScheduleStream"
)(function* (name: string, context: DaemonRequestContext) {
  const resolved = yield* Effect.result(
    resolveDevScheduleDispatch(name, context)
  );
  if (resolved._tag === "Failure") {
    return devErrorResponse(resolved.failure);
  }
  return makeScheduleEventStreamResponse(fireTarget(name, resolved.success));
});
