import { Effect, Schema, Tuple } from "effect";

import { AgentRuntimeEventTag } from "../../../author/src/agent-event.ts";
import { MAX_AGENT_FAILURE_TEXT_LENGTH } from "../../../author/src/errors/agent-failure.ts";
import { AGENT_FAILURE_CODES } from "../../../author/src/errors/agent-failure-codes.ts";
import { decodeJsonLine, decodeJsonString } from "../json.ts";
import { RuntimeJournalEntrySchema } from "./journal-entry.ts";

import { NonNegativeInt } from "./schema-primitives.ts";

/**
 * The two record kinds a dev event-log line can carry. This is the single
 * source for the `type` discriminator on both record arms below and for the
 * reader-side filters (`ori logs --type`, the daemon's log routes), so a new
 * kind cannot be added to one and forgotten in the other.
 */
const DevEventLogRecordTypeSchema = Schema.Literals(["log", "runtime.event"]);
const [LogRecordType, RuntimeEventRecordType] =
  DevEventLogRecordTypeSchema.members;

const DevEventLogRuntimeEventRecordSchema = Schema.Struct({
  entry: RuntimeJournalEntrySchema,
  sessionId: Schema.NullOr(Schema.String),
  type: RuntimeEventRecordType,
});

const DevEventLogLineRecordSchema = Schema.Struct({
  line: Schema.String,
  sessionId: Schema.NullOr(Schema.String),
  type: LogRecordType,
});

/**
 * The discriminated body of a dev event-log record, before the writer stamps it
 * with the on-disk `ts`. `runtime.event` mirrors a journal entry (with the
 * event's `sessionId` hoisted to the top level for easy filtering); `log`
 * carries one operational log line.
 *
 * The writer
 * ([event-log-file.ts](framework/cli/src/commands/dev/event-log-file.ts))
 * serializes these by hand rather than encoding through this schema, because it
 * measures and truncates the line against a byte cap. This schema types that
 * writer and backs test arbitraries; it is not on the write hot path.
 */
const DevEventLogRecordSchema = Schema.Union([
  DevEventLogRuntimeEventRecordSchema,
  DevEventLogLineRecordSchema,
]);

/**
 * One on-disk NDJSON line written by the `ori dev` event-log file: a
 * {@link DevEventLogRecordSchema} plus the write-time ISO `ts`. The envelope
 * mirrors Cursor's `stream-json` shape: a top-level `type` discriminator plus a
 * hoisted `sessionId`, so consumers can slice per session without splitting
 * files (`jq 'select(.sessionId=="…")'`). Shared by the writer and the reader
 * (`dev-log-store.ts`) so both agree on the format.
 */
const DevEventLogEntrySchema = DevEventLogRecordSchema.mapMembers(
  Tuple.map(Schema.fieldsAssign({ ts: Schema.String }))
);

const decodeDevEventLogEntry = Schema.decodeUnknownEffect(
  DevEventLogEntrySchema
);

const decodeDevEventLogEntryLine = decodeJsonLine(DevEventLogEntrySchema);

/**
 * The shape of a terminal failure line written before `payload.failure` existed.
 *
 * Used as a guard, not a decoder: narrowing lets the upgrade spread the rest of
 * the record through untouched, where decoding would strip every field this
 * shallow shape does not mention.
 *
 * Gated on the event type for the same reason the diagnostic arm below is:
 * relabelling any line that merely happens to carry a string `error` would turn
 * an older build's non-terminal event into a terminal failure.
 *
 * The text itself is optional. A terminal event that recorded no reason still
 * needs the upgrade, because the strict decode below requires `failure` and
 * would otherwise drop the one line that says the run ended at all.
 */
const LegacyFailureLineShape = Schema.Struct({
  entry: Schema.Struct({
    event: Schema.Struct({
      payload: Schema.Struct({
        error: Schema.optionalKey(Schema.String),
        failure: Schema.optionalKey(Schema.Unknown),
      }),
      type: Schema.Literals([
        AgentRuntimeEventTag.TurnFailed,
        AgentRuntimeEventTag.SessionFailed,
      ]),
    }),
  }),
});

const isLegacyFailureLine = Schema.is(LegacyFailureLineShape);

/**
 * The event types that carried their failure text under `payload.message`.
 *
 * `message` is gated on the type because it is still a live field on events
 * that never failed — `runtime.warning` carries one — so an ungated upgrade
 * would rewrite a warning into a failure.
 */
const LegacyDiagnosticLineShape = Schema.Struct({
  entry: Schema.Struct({
    event: Schema.Struct({
      payload: Schema.Struct({
        failure: Schema.optionalKey(Schema.Unknown),
        message: Schema.optionalKey(Schema.String),
      }),
      type: Schema.Literals([
        AgentRuntimeEventTag.RuntimeError,
        AgentRuntimeEventTag.CompactionFailed,
        AgentRuntimeEventTag.RetryFailed,
      ]),
    }),
  }),
});

const isLegacyDiagnosticLine = Schema.is(LegacyDiagnosticLineShape);

const legacyFailure = (
  code: "ORI_LEGACY_TURN_FAILED" | "ORI_LEGACY_RUNTIME_DIAGNOSTIC",
  text: string | undefined
): Record<string, unknown> => ({
  code,
  kind: "unknown",
  message: (text ?? AGENT_FAILURE_CODES[code].summary).slice(
    0,
    MAX_AGENT_FAILURE_TEXT_LENGTH
  ),
  stage: "runtime",
});

const withUpgradedPayload = (
  value: { readonly entry: { readonly event: object } },
  payload: Record<string, unknown>
): unknown => ({
  ...value,
  entry: {
    ...value.entry,
    event: {
      ...value.entry.event,
      payload,
    },
  },
});

/**
 * Upgrade a pre-standard failure line so old runs stay readable.
 *
 * Without this, `ori logs <run from before the upgrade>` renders every event
 * except the failure, and the run looks like it simply stopped. Dropping the
 * one line that says why a run died is worse than showing it with a
 * placeholder code, so the original text is preserved as the message.
 *
 * Two shapes existed. Terminal events (`turn.failed`, `session.failed`) wrote
 * `payload.error`; mid-run diagnostics wrote `payload.message`. The event type
 * already tells a reader whether a turn or a session ended, so the codes here
 * only separate a run's terminal reason from a diagnostic along the way.
 *
 * A record that already carries `failure` is current and passes through: the
 * arms key on the event type rather than on the old text field, so that check
 * is what keeps them off a line this standard already wrote.
 */
const upgradeLegacyFailureLine = (value: unknown): unknown => {
  if (isLegacyFailureLine(value)) {
    const { error, failure, ...payload } = value.entry.event.payload;
    return failure === undefined
      ? withUpgradedPayload(value, {
          ...payload,
          failure: legacyFailure("ORI_LEGACY_TURN_FAILED", error),
        })
      : value;
  }
  if (isLegacyDiagnosticLine(value)) {
    const { failure, message, ...payload } = value.entry.event.payload;
    return failure === undefined
      ? withUpgradedPayload(value, {
          ...payload,
          failure: legacyFailure("ORI_LEGACY_RUNTIME_DIAGNOSTIC", message),
        })
      : value;
  }
  return value;
};

const decodeJsonValueLine = decodeJsonLine(Schema.Unknown);

/**
 * Decode one on-disk line, upgrading pre-standard failure records first.
 * Readers of persisted history must use this; live in-process paths decode
 * against the strict schema.
 */
const decodeDevEventLogEntryLineCompat = (
  line: string
): Effect.Effect<DevEventLogEntry, Schema.SchemaError> =>
  decodeJsonValueLine(line).pipe(
    Effect.flatMap((value) =>
      decodeDevEventLogEntry(upgradeLegacyFailureLine(value))
    )
  );

/** Metadata describing one persisted `ori dev` run file under `.ori/logs/`. */
const DevLogRunSchema = Schema.Struct({
  /** Filename stem (e.g. `dev-2026-06-22T22-48-01-123Z`); the read addressable id. */
  id: Schema.String,
  /** File mtime as an ISO string, or null when it could not be stat'd. */
  modifiedAt: Schema.NullOr(Schema.String),
  sizeBytes: NonNegativeInt,
  /** Run start parsed from the filename stamp, or null when it could not be parsed. */
  startedAt: Schema.NullOr(Schema.String),
});

export const DevLogRunsResponseSchema = Schema.Struct({
  runs: Schema.Array(DevLogRunSchema),
});

export const decodeDevLogRunsResponse = decodeJsonString(
  DevLogRunsResponseSchema
);

type DevEventLogRecordType = typeof DevEventLogRecordTypeSchema.Type;
type DevEventLogRecord = typeof DevEventLogRecordSchema.Type;
type DevEventLogEntry = typeof DevEventLogEntrySchema.Type;
type DevLogRun = typeof DevLogRunSchema.Type;

export {
  DevEventLogRecordTypeSchema,
  DevEventLogRecordSchema,
  DevEventLogEntrySchema,
  decodeDevEventLogEntry,
  decodeDevEventLogEntryLine,
  decodeDevEventLogEntryLineCompat,
  DevLogRunSchema,
};
export type {
  DevEventLogRecordType,
  DevEventLogRecord,
  DevEventLogEntry,
  DevLogRun,
};
