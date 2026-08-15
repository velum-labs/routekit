import type { PlatformError } from "effect";

import {
  Clock,
  Effect,
  FileSystem,
  Path,
  Stream,
  SubscriptionRef,
} from "effect";

import type { DevEventLogRecord } from "../../../../contracts/internal/src/runtime/dev-event-log.ts";
import type { RuntimeJournalEntry } from "../../../../contracts/internal/src/runtime/journal-entry.ts";
import type { DaemonRuntime } from "../../../../runloop/local/src/daemon/server/server-types.ts";
import type {
  DevLogRetentionPolicy,
  RunLabel,
} from "../../../../runloop/local/src/dev/log-store.ts";
import type { DrainWatermark } from "./drain-watermark.ts";

import {
  RUNTIME_AUDIT_LINE_PREFIX,
  RUNTIME_EVENT_APPENDED_AUDIT_NAME,
} from "../../../../contracts/internal/src/runtime/audit-event.ts";
import { acquireDaemonStreams } from "../../../../runloop/local/src/daemon/streams/streams.ts";
import {
  DEFAULT_DEV_LOG_RETENTION,
  eventLogFilePath,
} from "../../../../runloop/local/src/dev/log-store.ts";
import { awaitDurableDrains } from "./drain-watermark.ts";
import { prepareDevLogStorage } from "./event-log-startup.ts";
import { readOptionalConfigString } from "./optional-config.ts";
import { startSessionMetadataSidecars } from "./session-metadata-file.ts";

const RECORD_SEPARATOR = "\n";
const textEncoder = new TextEncoder();
const RECORD_SEPARATOR_BYTES = textEncoder.encode(RECORD_SEPARATOR);

// A pi/Claude `raw.payload` can carry the entire re-sent conversation context
// (e.g. the full system prompt on every `item.started`), so persisting it
// verbatim makes `.ori/logs` run files grow ~O(turns * promptSize) instead of
// O(turns). That both wastes disk and makes a hot run file expensive to read
// (a `tail`/`grep` against it can itself become slow enough to look like a
// stalled runtime). The live in-memory journal keeps the untruncated payload
// for real-time debugging; only the on-disk copy is bounded, so `ori logs`
// readers see a `truncated` marker instead of megabytes of repeated prompt.
const MAX_RAW_PAYLOAD_BYTES = 4096;
// Defense in depth: even after truncating `raw.payload`, cap the fully
// serialized line so no other unbounded field (present or future) can make a
// single NDJSON line unboundedly large.
const MAX_LINE_BYTES = 262_144;

// Retention knobs for `.ori/logs`. We keep logs workspace-local and prune them
// ourselves so retention is deterministic and cross-platform (rather than
// relying on `/tmp` cleaners or systemd journald, neither of which is portable
// or workspace-scoped). Each bound accepts a runtime-neutral `ORI_LOG_*` env
// (the documented name for headless `ori start`) and the historical
// `ORI_DEV_LOG_*` alias; the dev-prefixed name wins when both are set so an
// existing `ori dev` setup keeps its behavior.
const ORI_LOG_MAX_RUNS_ENVS = [
  "ORI_DEV_LOG_MAX_RUNS",
  "ORI_LOG_MAX_RUNS",
] as const;
const ORI_LOG_MAX_AGE_DAYS_ENVS = [
  "ORI_DEV_LOG_MAX_AGE_DAYS",
  "ORI_LOG_MAX_AGE_DAYS",
] as const;
const ORI_LOG_MAX_TOTAL_MB_ENVS = [
  "ORI_DEV_LOG_MAX_TOTAL_MB",
  "ORI_LOG_MAX_TOTAL_MB",
] as const;
const MILLIS_PER_DAY = 86_400_000;
const BYTES_PER_MB = 1_048_576;
const DECIMAL_RADIX = 10;
const MIN_POSITIVE = 0;

// The daemon's audit log narrates every appended runtime event as a
// RUNTIME_EVENT_APPENDED_AUDIT_NAME line (see `makeRuntimeEventAuditEvent` in
// the runloop). Those carry the same entryId/eventId/sessionId we already
// persist structurally from the event journal, so keeping the audit narration
// too would duplicate every runtime event. Audit lines render as
// `<prefix> <ts> <LEVEL> <name> …`; the pattern is built from the shared
// prefix/name constants so a rename on the daemon side cannot silently break
// this filter and double-log every event.
const escapeRegExp = (value: string): string =>
  value.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
const RUNTIME_EVENT_APPENDED_LINE_PATTERN = new RegExp(
  String.raw`^${escapeRegExp(RUNTIME_AUDIT_LINE_PREFIX)} \S+ \S+ ${escapeRegExp(RUNTIME_EVENT_APPENDED_AUDIT_NAME)}(?:\s|$)`,
  "u"
);
const isRuntimeEventAppendedLine = (line: string): boolean =>
  RUNTIME_EVENT_APPENDED_LINE_PATTERN.test(line);

/**
 * Per-invocation retention overrides (friendly units) from `ori dev` flags.
 * Each takes precedence over the matching `ORI_DEV_LOG_*` env var, which in
 * turn falls back to {@link DEFAULT_DEV_LOG_RETENTION}.
 */
interface DevLogRetentionOverrides {
  readonly maxAgeDays?: number | undefined;
  readonly maxRuns?: number | undefined;
  readonly maxTotalMb?: number | undefined;
}

interface StartDevEventLogFileInput {
  readonly runtime: DaemonRuntime;
  readonly workspaceRoot: string;
  /** Surface the resolved path (split dev routes this into the events pane). */
  readonly publishLog?: (line: string) => void;
  /** Flag overrides for `.ori/logs` retention (flag > env > default). */
  readonly retention?: DevLogRetentionOverrides;
  /**
   * Run-file label, i.e. the `<label>-<stamp>.jsonl` prefix. Defaults to `dev`;
   * `ori start` passes `start` so its runs are distinguishable on disk while
   * `ori logs` still reads both.
   */
  readonly runLabel?: RunLabel | undefined;
}

interface DrainEventLogToFileInput {
  readonly eventEntries: Stream.Stream<RuntimeJournalEntry>;
  readonly file: FileSystem.File;
  readonly logLines: Stream.Stream<string>;
  readonly processedSequence?: DrainWatermark;
}

export interface DevEventLogFileHandle {
  readonly path: string;
  readonly flush: Effect.Effect<void>;
}

const toLogRecord = (line: string): DevEventLogRecord => ({
  line,
  sessionId: null,
  type: "log",
});

// Bound a single field's on-disk footprint: below the limit it round-trips
// unchanged, above it we swap in a small marker (never a half-cut JSON
// fragment) that still decodes as `Schema.Unknown` and records how large the
// original was, so a reader can tell truncation happened without needing the
// bytes we dropped. Sizes are measured in UTF-8 bytes (via `TextEncoder`), not
// `string.length`: the latter counts UTF-16 code units, so a CJK/emoji payload
// would undercount by up to ~3x and slip past a byte-denominated cap while
// occupying far more space on disk.
const truncateForDisk = (value: unknown, maxBytes: number): unknown => {
  if (value === undefined) {
    return value;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    return value;
  }
  const serializedBytes = textEncoder.encode(serialized);
  if (serializedBytes.byteLength <= maxBytes) {
    return value;
  }
  return {
    originalBytes: serializedBytes.byteLength,
    // A human-inspection hint only: the first `maxBytes` UTF-8 bytes of the
    // serialized JSON. `stream: true` drops a trailing partial multibyte char
    // instead of emitting U+FFFD, so the slice stays within the byte budget.
    // It can cut mid-token, so this is NOT parseable JSON — readers must treat
    // it as an opaque preview and never `JSON.parse` it.
    preview: new TextDecoder().decode(serializedBytes.subarray(0, maxBytes), {
      stream: true,
    }),
    truncated: true,
  };
};

// The journal already hands us decoded entries; hoist the event's sessionId to
// the top level so consumers can filter without reaching into `entry.event`.
// `raw.payload` is truncated for the on-disk copy only (see
// MAX_RAW_PAYLOAD_BYTES above) — the live journal a running `ori dev`/`ori
// start` session streams from still carries the untruncated event.
const toEventRecord = (entry: RuntimeJournalEntry): DevEventLogRecord => {
  const { raw } = entry.event;
  const boundedEntry: RuntimeJournalEntry =
    raw === undefined
      ? entry
      : {
          ...entry,
          event: {
            ...entry.event,
            raw: {
              ...raw,
              payload: truncateForDisk(raw.payload, MAX_RAW_PAYLOAD_BYTES),
            },
          },
        };
  return {
    entry: boundedEntry,
    sessionId: entry.event.sessionId ?? null,
    type: "runtime.event",
  };
};

// Concatenate the encoded line with the record separator in one buffer so the
// (large) serialized payload is encoded exactly once per write.
const withRecordSeparator = (lineBytes: Uint8Array): Uint8Array => {
  const out = new Uint8Array(
    lineBytes.byteLength + RECORD_SEPARATOR_BYTES.byteLength
  );
  out.set(lineBytes);
  out.set(RECORD_SEPARATOR_BYTES, lineBytes.byteLength);
  return out;
};

const writeRecord = Effect.fn("DevCommand.writeRecord")(function* (
  file: FileSystem.File,
  record: DevEventLogRecord
) {
  const ts = new Date(yield* Clock.currentTimeMillis).toISOString();
  // Byte-bounded NDJSON envelope serialization: the payload is measured against
  // MAX_LINE_BYTES below and truncated in-place, so we serialize the raw record
  // once here rather than round-tripping a schema. The emitted shape is asserted
  // against DevEventLogEntrySchema by the readers (`ori logs`, dev-log-store).
  // @effect-diagnostics-next-line preferSchemaOverJson:off
  const serialized = JSON.stringify({
    ts,
    ...record,
  });
  const serializedBytes = textEncoder.encode(serialized);
  // Defense in depth against any other unbounded field: never write a line
  // larger than MAX_LINE_BYTES (measured in UTF-8 bytes, matching the on-disk
  // footprint), even if `raw.payload` truncation above wasn't enough (e.g. a
  // very large `data`/`result` elsewhere on the event). Falls back to a
  // `"log"`-shaped record (rather than a truncated `"runtime.event"`) so the
  // emergency line still matches `DevEventLogEntrySchema` and readers
  // (`ori logs`, `dev-log-store.ts`) decode it instead of silently dropping it.
  if (serializedBytes.byteLength <= MAX_LINE_BYTES) {
    yield* file.write(withRecordSeparator(serializedBytes));
    return;
  }
  // Emergency fallback line for an oversized record; a fixed `"log"`-shaped
  // envelope that readers decode via DevEventLogEntrySchema. Same byte-bounded
  // serialization rationale as the primary write above.
  // @effect-diagnostics-next-line preferSchemaOverJson:off
  const fallback = JSON.stringify({
    line: `[ori-runtime] dropped oversized ${record.type} record (${serializedBytes.byteLength} bytes > ${MAX_LINE_BYTES} byte cap)`,
    sessionId: "sessionId" in record ? record.sessionId : null,
    ts,
    type: "log",
  });
  yield* file.write(withRecordSeparator(textEncoder.encode(fallback)));
});

/**
 * Merge the daemon's operational log and runtime event tails, wrap each into the
 * NDJSON envelope, and append to the open file until both streams end. The log
 * stream's `runtime.event.appended` narration is dropped so each runtime event
 * is persisted exactly once (as a structured `runtime.event` record). Exposed
 * (apart from `startDevEventLogFile`) so tests can drive it with in-memory
 * streams.
 */
const drainEventLogToFile = (
  input: DrainEventLogToFileInput
): Effect.Effect<void, PlatformError.PlatformError> =>
  Stream.merge(
    input.logLines.pipe(
      Stream.filter((line) => !isRuntimeEventAppendedLine(line)),
      Stream.map(toLogRecord)
    ),
    input.eventEntries.pipe(Stream.map(toEventRecord))
  ).pipe(
    Stream.mapEffect((record) =>
      writeRecord(input.file, record).pipe(
        Effect.andThen(
          "entry" in record && input.processedSequence !== undefined
            ? SubscriptionRef.set(
                input.processedSequence,
                record.entry.sequence
              )
            : Effect.void
        )
      )
    ),
    Stream.runDrain
  );

// Any `ConfigError` flows up to the caller, which falls back to the default
// retention.
const readFirstConfigString = Effect.fn("DevCommand.readFirstConfigString")(
  function* (names: readonly string[]) {
    for (const name of names) {
      const value = yield* readOptionalConfigString(name);
      if (value !== undefined) {
        return value;
      }
    }
  }
);
// Parse a present env value as a positive int; `undefined` means "unset or
// invalid" so the caller falls back to the default rather than crashing dev.
const parseOptionalPositiveInt = (
  value: string | undefined
): number | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(value, DECIMAL_RADIX);
  return Number.isInteger(parsed) && parsed > MIN_POSITIVE ? parsed : undefined;
};

// Treat a non-positive / non-integer flag value as "unset" so it falls through
// to the env var rather than producing a nonsensical (e.g. zero/negative) bound.
const positiveOverride = (value: number | undefined): number | undefined =>
  value !== undefined && Number.isInteger(value) && value > MIN_POSITIVE
    ? value
    : undefined;

// Exported so tests can drive the precedence/parse rules without opening a real
// daemon.
export const readDevLogRetentionPolicy = Effect.fn(
  "DevCommand.readDevLogRetentionPolicy"
)(function* (overrides: DevLogRetentionOverrides = {}) {
  return yield* Effect.gen(function* () {
    const maxRuns =
      positiveOverride(overrides.maxRuns) ??
      parseOptionalPositiveInt(
        yield* readFirstConfigString(ORI_LOG_MAX_RUNS_ENVS)
      ) ??
      DEFAULT_DEV_LOG_RETENTION.maxRuns;
    const maxAgeDays =
      positiveOverride(overrides.maxAgeDays) ??
      parseOptionalPositiveInt(
        yield* readFirstConfigString(ORI_LOG_MAX_AGE_DAYS_ENVS)
      );
    const maxTotalMb =
      positiveOverride(overrides.maxTotalMb) ??
      parseOptionalPositiveInt(
        yield* readFirstConfigString(ORI_LOG_MAX_TOTAL_MB_ENVS)
      );
    return {
      maxAgeMillis:
        maxAgeDays === undefined
          ? DEFAULT_DEV_LOG_RETENTION.maxAgeMillis
          : maxAgeDays * MILLIS_PER_DAY,
      maxRuns,
      maxTotalBytes:
        maxTotalMb === undefined
          ? DEFAULT_DEV_LOG_RETENTION.maxTotalBytes
          : maxTotalMb * BYTES_PER_MB,
    } satisfies DevLogRetentionPolicy;
  }).pipe(Effect.orElseSucceed(() => DEFAULT_DEV_LOG_RETENTION));
});

/**
 * Tee everything the `ori dev` events pane shows into an append-only NDJSON file
 * under `.ori/logs/`, copying Cursor's durable event-log model. The tails are
 * read straight from the in-process daemon (never via its own HTTP endpoints,
 * which would block graceful shutdown). The file handle is opened in the
 * caller's scope and the drain runs in a scoped fiber, so both are released when
 * the dev session ends; a dropped stream or write error is swallowed so it can
 * never take down the session. A headless one-shot awaits the returned flush
 * effect so both durable tails persist the terminal event before its scope
 * closes.
 */
export const startDevEventLogFile = Effect.fn("DevCommand.eventLogFile")(
  function* (input: StartDevEventLogFileInput) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const filePath = eventLogFilePath(path, input.workspaceRoot, {
      label: input.runLabel,
      timestampMillis: yield* Clock.currentTimeMillis,
    });
    const logsDir = path.dirname(filePath);
    yield* fs.makeDirectory(logsDir, { recursive: true });
    const file = yield* fs.open(filePath, { flag: "a" });

    yield* prepareDevLogStorage({
      filePath,
      fs,
      logsDir,
      path,
      policy: readDevLogRetentionPolicy(input.retention),
      publishLog: input.publishLog,
    });

    const streams = yield* acquireDaemonStreams(input.runtime);
    const processedSequence = yield* SubscriptionRef.make(0);
    yield* drainEventLogToFile({
      eventEntries: streams.eventEntries,
      file,
      logLines: streams.logLines,
      processedSequence,
    }).pipe(Effect.ignore, Effect.forkScoped);

    // Derive the per-session metadata sidecars from the same runtime-event
    // tail. This is a projection over the run file (a second consumer of the
    // journal, never a second writer over the same store): each drain
    // subscribes to the journal PubSub independently, so both the run-file tee
    // and the sidecar see every event. Best-effort — a sidecar failure never
    // takes down the session.
    const metadataHandle = yield* startSessionMetadataSidecars({
      eventEntries: streams.eventEntries,
      logsDir,
      latestEventSequence: streams.latestEventSequence,
    });

    input.publishLog?.(`[ori-runtime] writing event log to ${filePath}`);
    return {
      path: filePath,
      flush: awaitDurableDrains(
        processedSequence,
        streams.latestEventSequence,
        metadataHandle.flush
      ),
    } satisfies DevEventLogFileHandle;
  }
);

export { drainEventLogToFile };
export type {
  DevLogRetentionOverrides,
  StartDevEventLogFileInput,
  DrainEventLogToFileInput,
};
