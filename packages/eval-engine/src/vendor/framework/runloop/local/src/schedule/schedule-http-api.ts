import { Schema } from "effect";
import {
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
} from "effect/unstable/httpapi";

import {
  ScheduleDetailResponseSchema,
  ScheduleDispatchResponseSchema,
  ScheduleRunsResponseSchema,
  SchedulesResponseSchema,
} from "../../../../contracts/internal/src/runtime/schedule-introspection.ts";

const NOT_FOUND_STATUS = 404;
const INTERNAL_ERROR_STATUS = 500;

/** `:name` path parameter shared by the detail, runs, and trigger endpoints. */
const ScheduleNameParams = Schema.Struct({ name: Schema.String });

// HttpApi decodes query values as strings; the `[1,200]` clamp and default stay
// in the handler (`parseRunLimit`), so the wire contract keeps `?limit=` optional
// and free-form rather than encoding numeric bounds a client could trip over.
const ScheduleRunsQuery = Schema.Struct({
  limit: Schema.optional(Schema.String),
});

// Declared errors are plain structs, NOT `Schema.TaggedError`: the schedules
// wire contract is fixed and tag-free (`{error}` / `{availableScheduleIds,
// error}`), so a `_tag` on the body would change the bytes clients already
// parse. Field order is load-bearing too — JSON output follows struct field
// order, and the existing handler emits `availableScheduleIds` before `error`
// (alphabetical), so this struct must list them in that order for byte-identical
// parity with the raw route it replaces.
const UnknownScheduleError = Schema.Struct({
  availableScheduleIds: Schema.Array(Schema.String),
  error: Schema.String,
}).pipe(HttpApiSchema.status(NOT_FOUND_STATUS));

const ScheduleUnavailableError = Schema.Struct({
  error: Schema.String,
}).pipe(HttpApiSchema.status(INTERNAL_ERROR_STATUS));

const listEndpoint = HttpApiEndpoint.get("list", "/api/schedules", {
  error: [ScheduleUnavailableError],
  success: SchedulesResponseSchema,
});

const detailEndpoint = HttpApiEndpoint.get("detail", "/api/schedules/:name", {
  error: [UnknownScheduleError, ScheduleUnavailableError],
  params: ScheduleNameParams,
  success: ScheduleDetailResponseSchema,
});

const runsEndpoint = HttpApiEndpoint.get("runs", "/api/schedules/:name/runs", {
  error: [UnknownScheduleError, ScheduleUnavailableError],
  params: ScheduleNameParams,
  query: ScheduleRunsQuery,
  success: ScheduleRunsResponseSchema,
});

const triggerEndpoint = HttpApiEndpoint.post(
  "trigger",
  "/api/dev/schedules/:name",
  {
    error: [UnknownScheduleError, ScheduleUnavailableError],
    params: ScheduleNameParams,
    success: ScheduleDispatchResponseSchema,
  }
);

/**
 * The schedules group, composed into the daemon-level {@link DaemonHttpApi}
 * (daemon-http-api.ts) alongside sessions/logs/features/health rather than
 * standing as its own single-group API. The endpoints are unchanged from the
 * #1261 spike; only the composition site moved.
 */
export const scheduleGroup = HttpApiGroup.make("schedules")
  .add(listEndpoint)
  .add(detailEndpoint)
  .add(runsEndpoint)
  .add(triggerEndpoint);

export {
  ScheduleNameParams,
  ScheduleRunsQuery,
  UnknownScheduleError,
  ScheduleUnavailableError,
};

/** Domain-error body values the handlers `Effect.fail`, matching the fixed wire. */
export type UnknownScheduleErrorBody = typeof UnknownScheduleError.Type;
export type ScheduleUnavailableErrorBody = typeof ScheduleUnavailableError.Type;
