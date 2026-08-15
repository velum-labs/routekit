import { Array as Arr, Effect, Option, Result, Schema } from "effect";

import type { AgentFailure } from "../../../../contracts/author/src/errors/agent-failure.ts";
import type { FeatureLogger } from "../../../../contracts/author/src/feature-logger.ts";
import type { StateStore } from "../../../../contracts/author/src/stores.ts";
import type { ScheduleRunRecord } from "../../../../contracts/internal/src/runtime/schedule-introspection.ts";

import { agentFailure } from "../../../../contracts/author/src/errors/agent-failure.ts";
import { AgentFailureSchema } from "../../../../contracts/internal/src/author-schemas/agent-runtime-event.ts";
import { scheduleRunFields } from "../../../../contracts/internal/src/runtime/schedule-introspection.ts";
import { formatUnknownError } from "../../../../utils/core/src/error-formatting.ts";

// Run history lives in the project StateStore so it survives daemon restarts; the
// table name is namespaced to avoid colliding with handler-authored data.
const MAX_RUNS_PER_SCHEDULE = 200;

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS ori_schedule_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_id TEXT NOT NULL,
  fired_at TEXT NOT NULL,
  status TEXT NOT NULL,
  session_ids TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  error TEXT
)`;

const CREATE_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS ori_schedule_runs_by_schedule
ON ori_schedule_runs (schedule_id, id DESC)`;

const INSERT_RUN_SQL = `
INSERT INTO ori_schedule_runs (schedule_id, fired_at, status, session_ids, duration_ms, error)
VALUES (?, ?, ?, ?, ?, ?)`;

const PRUNE_RUNS_SQL = `
DELETE FROM ori_schedule_runs
WHERE schedule_id = ?
  AND id NOT IN (
    SELECT id FROM ori_schedule_runs WHERE schedule_id = ? ORDER BY id DESC LIMIT ?
  )`;

const LIST_RUNS_SQL = `
SELECT schedule_id, fired_at, status, session_ids, duration_ms, error
FROM ori_schedule_runs
WHERE schedule_id = ?
ORDER BY id DESC
LIMIT ?`;

const LATEST_RUNS_SQL = `
SELECT t.schedule_id, t.fired_at, t.status, t.session_ids, t.duration_ms, t.error
FROM ori_schedule_runs t
JOIN (
  SELECT schedule_id, MAX(id) AS max_id FROM ori_schedule_runs GROUP BY schedule_id
) latest ON t.schedule_id = latest.schedule_id AND t.id = latest.max_id`;

// The persisted row, decoded rather than trusted. `store.query<Row>` is a generic
// hint with no runtime check behind it, so every column arrives as `unknown` in
// practice: a row written by an older build, a hand-edited database, or a partial
// write can hold anything the column type allows. Decoding here is what makes an
// unknown `status` a decode failure instead of a silent success.
//
// `session_ids` stays `Schema.String` and is parsed separately: a corrupt JSON
// payload there costs the fire's session list, not the whole record, so it keeps
// the lenient read while the load-bearing fields are strict.
//
// The column schemas are the contract's own field schemas, not re-declarations of
// them: the snake_case row and the camelCase record must accept exactly the same
// values, and spelling `NonNegativeInt`/`IsoInstant` again here would be the same
// parallel-definition drift the decode exists to catch.
const StoredScheduleFailureJson = Schema.fromJsonString(AgentFailureSchema);
const decodeStoredScheduleFailure = Schema.decodeUnknownOption(
  StoredScheduleFailureJson
);

/**
 * Project the stored `error` column into an `AgentFailure`.
 *
 * Rows written before the structured standard hold free text, and they are
 * projected here at read time rather than rewritten in place. That text is the
 * whole value of old history: a migration that overwrites it destroys the
 * answer to "why did last week's run fail" as a side effect of looking for it.
 */
const storedScheduleFailure = (error: string): AgentFailure =>
  Option.getOrElse(decodeStoredScheduleFailure(error), () =>
    agentFailure({
      code: "ORI_LEGACY_SCHEDULE_FIRE_FAILED",
      message: error,
      stage: "runtime",
    })
  );

const scheduleRunRowFields = {
  duration_ms: scheduleRunFields.durationMs,
  fired_at: scheduleRunFields.firedAt,
  schedule_id: scheduleRunFields.scheduleId,
  session_ids: Schema.String,
} as const;
const ScheduleRunRowSchema = Schema.Union([
  Schema.Struct({
    ...scheduleRunRowFields,
    error: Schema.Null,
    status: Schema.Literal("ok"),
  }),
  Schema.Struct({
    ...scheduleRunRowFields,
    error: Schema.String,
    status: Schema.Literal("error"),
  }),
]).pipe(Schema.toTaggedUnion("status"));

// A Result, which is exactly what `Array.filterMap` consumes, and whose failure
// side is a `SchemaError` naming the offending field for the drop breadcrumb.
const decodeScheduleRunRow = Schema.decodeUnknownResult(ScheduleRunRowSchema);

/**
 * A run-history operation that never reached the store.
 *
 * The Promise boundary is crossed exactly once, here, so a caller gets an Effect
 * with a named failure instead of wrapping `store.exec` in its own
 * `Effect.tryPromise` and inheriting the opaque global `Error` channel. Every
 * caller recovers immediately (`Effect.ignore` on the write, `orElseSucceed` on
 * the reads), so this failure never escapes the schedule modules — naming it is
 * what keeps those recoveries honest and carries the driver's own rejection
 * through to the breadcrumb.
 */
export class ScheduleRunStoreError extends Schema.TaggedError<ScheduleRunStoreError>()(
  "ScheduleRunStoreError",
  {
    cause: Schema.Defect(),
    operation: Schema.String,
  }
) {
  override get message(): string {
    return `Failed while ${this.operation}: ${formatUnknownError(this.cause)}`;
  }
}

const CREATE_OPERATION = "creating the schedule run-history table";
const READ_OPERATION = "reading schedule run history";
const WRITE_OPERATION = "writing schedule run history";

// One options object rather than four positional parameters: `operation` varies
// per call (a DDL failure on a read path must not report itself as a write) and
// `max-params` caps arrow functions at three.
const execute = (input: {
  readonly operation: string;
  readonly params?: readonly unknown[];
  readonly sql: string;
  readonly store: StateStore;
}): Effect.Effect<void, ScheduleRunStoreError> =>
  Effect.tryPromise({
    catch: (cause) =>
      new ScheduleRunStoreError({
        cause,
        operation: input.operation,
      }),
    try: () => input.store.exec(input.sql, input.params),
  });

const queryRows = (
  store: StateStore,
  sql: string,
  params?: readonly unknown[]
): Effect.Effect<readonly unknown[], ScheduleRunStoreError> =>
  Effect.tryPromise({
    catch: (cause) =>
      new ScheduleRunStoreError({
        cause,
        operation: READ_OPERATION,
      }),
    try: () => store.query(sql, params),
  });

// The write half of `decodeSessionIds` below, and deliberately as lenient: the
// element schema is `Unknown`, so a session id the record contract does not admit
// still round-trips instead of failing. `Result` rather than `Sync` for the same
// reason the read side returns one: a throw inside the generator below would be a
// defect, and the `Effect.ignore` this write runs under only swallows the typed
// channel, so an unencodable id would take the whole fire down with it.
const encodeSessionIds = Schema.encodeUnknownResult(
  Schema.fromJsonString(Schema.Array(Schema.Unknown))
);

const encodeStoredScheduleError = Schema.encodeUnknownResult(
  StoredScheduleFailureJson
);

/** Create the run-history table and its lookup index if they do not yet exist. */
const ensureScheduleRunsTable = Effect.fn("ScheduleRunStore.ensureTable")(
  function* (store: StateStore) {
    yield* execute({
      operation: CREATE_OPERATION,
      sql: CREATE_TABLE_SQL,
      store,
    });
    yield* execute({
      operation: CREATE_OPERATION,
      sql: CREATE_INDEX_SQL,
      store,
    });
  }
);

/** Append a fire record, then prune to the most recent {@link MAX_RUNS_PER_SCHEDULE}. */
const recordScheduleRun = Effect.fn("ScheduleRunStore.record")(function* (
  store: StateStore,
  record: ScheduleRunRecord
) {
  yield* ensureScheduleRunsTable(store);
  const sessionIds = yield* Effect.fromResult(
    encodeSessionIds(record.sessionIds)
  ).pipe(
    Effect.mapError(
      (cause) =>
        new ScheduleRunStoreError({
          cause,
          operation: WRITE_OPERATION,
        })
    )
  );
  const storedError =
    record.status === "ok"
      ? null
      : yield* Effect.fromResult(
          encodeStoredScheduleError(record.failure)
        ).pipe(
          Effect.mapError(
            (cause) =>
              new ScheduleRunStoreError({
                cause,
                operation: WRITE_OPERATION,
              })
          )
        );
  yield* execute({
    operation: WRITE_OPERATION,
    params: [
      record.scheduleId,
      record.firedAt,
      record.status,
      sessionIds,
      record.durationMs,
      storedError,
    ],
    sql: INSERT_RUN_SQL,
    store,
  });
  yield* execute({
    operation: WRITE_OPERATION,
    params: [record.scheduleId, record.scheduleId, MAX_RUNS_PER_SCHEDULE],
    sql: PRUNE_RUNS_SQL,
    store,
  });
});

// A corrupt row (bad JSON, or a non-array value) decodes to None and yields no
// sessions, while a partial array keeps its string elements — matching the prior
// lenient read.
const decodeSessionIds = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.Unknown))
);

const parseSessionIds = (raw: string): readonly string[] =>
  Option.match(decodeSessionIds(raw), {
    onNone: () => [],
    onSome: (values) =>
      values.filter((value): value is string => typeof value === "string"),
  });

/**
 * Project one decoded row into the wire record.
 *
 * Total, because the row is already decoded: every field is the type the contract
 * declares, so there is nothing left to coerce or default. `status` is carried
 * verbatim — the coercion this replaced reported every unrecognised value as `ok`.
 */
const toScheduleRunRecord = (
  row: typeof ScheduleRunRowSchema.Type
): ScheduleRunRecord => {
  const base = {
    durationMs: row.duration_ms,
    firedAt: row.fired_at,
    scheduleId: row.schedule_id,
    sessionIds: parseSessionIds(row.session_ids),
  };
  return row.status === "ok"
    ? {
        ...base,
        status: "ok",
      }
    : {
        ...base,
        failure: storedScheduleFailure(row.error),
        status: "error",
      };
};

/**
 * Decode the rows a read returned, dropping any that fail the contract.
 *
 * A row that does not decode is unreportable: its `status` is not a status, or its
 * `fired_at` is not an instant callers can do date arithmetic on. Dropping it is
 * the honest read — the previous code coerced such a row to `status: "ok"`, which
 * reported a failed or unknown fire as a success. Omitting it means run history is
 * visibly short rather than quietly wrong.
 *
 * Each drop logs a breadcrumb when a logger is available, because a silent drop is
 * indistinguishable from a schedule that never fired.
 */
const decodeScheduleRunRows = (
  rows: readonly unknown[],
  logger: Option.Option<FeatureLogger>
): readonly ScheduleRunRecord[] => {
  // Not point-free: `Array#map` would pass the index into the decoder's
  // `ParseOptions` slot.
  const decoded = rows.map((row) => decodeScheduleRunRow(row));
  if (Option.isSome(logger)) {
    for (const result of decoded) {
      if (Result.isFailure(result)) {
        logger.value.warn("schedule run-history row failed to decode", {
          detail: result.failure.message,
        });
      }
    }
  }
  return Arr.filterMap(decoded, (result) =>
    result.pipe(Result.map(toScheduleRunRecord))
  );
};

/**
 * Recent fires for one schedule, newest first. Rows that fail the contract are
 * omitted, and each omission is logged when `logger` is supplied.
 */
export const listScheduleRuns = Effect.fn("ScheduleRunStore.list")(function* (
  store: StateStore,
  query: {
    readonly limit: number;
    readonly logger?: Option.Option<FeatureLogger>;
    readonly scheduleId: string;
  }
) {
  yield* ensureScheduleRunsTable(store);
  const rows = yield* queryRows(store, LIST_RUNS_SQL, [
    query.scheduleId,
    query.limit,
  ]);
  return decodeScheduleRunRows(rows, query.logger ?? Option.none());
});

/**
 * The single most recent fire for every schedule that has one, keyed by schedule id.
 *
 * A newest row that fails the contract drops out, which leaves the schedule absent
 * from the map — catch-up then reads it as "never fired". That is why the drop is
 * logged: the breadcrumb is the only trace such a row leaves.
 */
export const latestRunsByScheduleId = Effect.fn("ScheduleRunStore.latest")(
  function* (
    store: StateStore,
    logger: Option.Option<FeatureLogger> = Option.none()
  ) {
    yield* ensureScheduleRunsTable(store);
    const rows = yield* queryRows(store, LATEST_RUNS_SQL);
    // Annotated, not inferred: the Promise signature this replaced declared
    // `ReadonlyMap` and `Effect.fn` has no return type to carry that, so without
    // the annotation every caller would receive a mutable `Map`. It also supplies
    // the `Map` type arguments `.map` needs to stay a tuple.
    const latest: ReadonlyMap<string, ScheduleRunRecord> = new Map(
      decodeScheduleRunRows(rows, logger).map((record) => [
        record.scheduleId,
        record,
      ])
    );
    return latest;
  }
);

export { ensureScheduleRunsTable, recordScheduleRun };
