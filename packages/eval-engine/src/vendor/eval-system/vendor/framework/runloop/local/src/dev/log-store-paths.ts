import type { FileSystem, Path } from "effect";

import type {
  DevEventLogEntry,
  DevEventLogRecordType,
  DevLogRun,
} from "../../../../contracts/internal/src/runtime/dev-event-log.ts";

export const DEV_LOG_DIR_SEGMENTS = [".routekit-eval", "logs"] as const;
export const SESSIONS_DIR_SEGMENT = "sessions";
export const SESSION_METADATA_FILE = "metadata.json";
// Run files are named `<label>-<stamp>.jsonl`. `routekit-eval dev` writes `dev-…`,
// `routekit-eval start` writes `start-…`, and `routekit-eval code` writes `code-…`; the reader
// accepts any known label so a single `.routekit-eval/logs` directory (and `routekit-eval logs`)
// spans every runtime. `dev-` stays the default for back-compat with existing
// tooling and on-disk runs. `RunLabel` is derived from this list so the writer
// can only produce labels the reader recognizes.
const RUN_FILE_PREFIXES = ["dev-", "start-", "code-"] as const;
export type RunLabel =
  (typeof RUN_FILE_PREFIXES)[number] extends `${infer Label}-` ? Label : never;
export const DEFAULT_RUN_LABEL: RunLabel = "dev";
export const RUN_FILE_SUFFIX = ".jsonl";
export const LATEST_RUN_ID = "latest";
export const LINE_SEPARATOR = "\n";
export const EMPTY_COUNT = 0;
export const FALLBACK_SIZE = 0;
export const FOLLOW_POLL_MILLIS = 250;
export const KEPT_INCREMENT = 1;
const UNKNOWN_AGE_MILLIS = 0;
const MILLIS_PER_DAY = 86_400_000;
const BYTES_PER_MB = 1_048_576;
const DEFAULT_MAX_RUNS = 100;
const DEFAULT_MAX_AGE_DAYS = 30;
const DEFAULT_MAX_TOTAL_MB = 1024;

/**
 * Bounds for retaining `.routekit-eval/logs` runs. We own this policy (rather than leaning
 * on OS temp-dir cleaners or journald) so retention stays deterministic,
 * configurable, and identical across platforms. Units are millis/bytes so the
 * prune scan can compare directly; callers convert from friendlier env units.
 */
export interface DevLogRetentionPolicy {
  /** Keep at most this many of the newest runs. */
  readonly maxRuns: number;
  /** Delete runs whose start/modified time is older than this. */
  readonly maxAgeMillis: number;
  /** Delete the oldest runs until the kept set fits this byte budget. */
  readonly maxTotalBytes: number;
}

export const DEFAULT_DEV_LOG_RETENTION: DevLogRetentionPolicy = {
  maxAgeMillis: DEFAULT_MAX_AGE_DAYS * MILLIS_PER_DAY,
  maxRuns: DEFAULT_MAX_RUNS,
  maxTotalBytes: DEFAULT_MAX_TOTAL_MB * BYTES_PER_MB,
};

export interface PruneDevLogRunsOptions {
  /** The active run (just created); never a deletion candidate. */
  readonly keepRunId?: string;
  /** Defaults to {@link DEFAULT_DEV_LOG_RETENTION}. */
  readonly policy?: DevLogRetentionPolicy;
}

// `:` and `.` are awkward in filenames across shells/filesystems, so the writer
// flattens the ISO timestamp into a sortable, plain-ascii stamp
// (e.g. 2026-06-22T22-48-01-123Z). These mirror that transform so the writer
// (event-log-file.ts) and this reader agree on run-file names.
const FILENAME_TIMESTAMP_PATTERN = /[:.]/gu;
const FILENAME_TIMESTAMP_REPLACEMENT = "-";
const RUN_STAMP_TIME_PATTERN =
  /^(?<hour>\d{2})-(?<minute>\d{2})-(?<second>\d{2})-(?<milli>\d{3})Z$/u;

export interface ReadDevLogRunOptions {
  /** Tail the file for appended records instead of ending after the backlog. */
  readonly follow?: boolean;
  /** Keep only `runtime.event` records whose hoisted sessionId matches. */
  readonly sessionId?: string | undefined;
  /** Keep only records of this envelope type. */
  readonly type?: DevEventLogRecordType | undefined;
}

/**
 * The disk-access context every store helper threads: the `FileSystem` / `Path`
 * services plus the resolved `.routekit-eval/logs` directory. These three always travel
 * together (constructed once in `DevLogStoreLive`), so bundling them into one
 * object keeps each helper's own signature focused on its real input.
 */
export interface DevLogStoreContext {
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly logsDir: string;
}

export const devLogsDir = (path: Path.Path, workspaceRoot: string): string =>
  path.join(workspaceRoot, ...DEV_LOG_DIR_SEGMENTS);

/** `.routekit-eval/logs/sessions`, holding the per-session metadata sidecars. */
export const sessionsDir = (logsDir: string, path: Path.Path): string =>
  path.join(logsDir, SESSIONS_DIR_SEGMENT);

/** `.routekit-eval/logs/sessions/<sessionId>/metadata.json` for one session's sidecar. */
export const sessionMetadataFilePath = (
  logsDir: string,
  path: Path.Path,
  sessionId: string
): string =>
  path.join(sessionsDir(logsDir, path), sessionId, SESSION_METADATA_FILE);

/**
 * The append-only NDJSON file one runtime run writes. Named `<label>-<stamp>`
 * with a sortable, filesystem-safe stamp so `ls`-style listings are
 * chronological. `label` defaults to `dev`; `routekit-eval start` passes `start`. Shared
 * with the reader below so the writer and reader agree on names.
 */
export const eventLogFilePath = (
  path: Path.Path,
  workspaceRoot: string,
  run: {
    readonly timestampMillis: number;
    readonly label?: RunLabel | undefined;
  }
): string => {
  const stamp = new Date(run.timestampMillis)
    .toISOString()
    .replace(FILENAME_TIMESTAMP_PATTERN, FILENAME_TIMESTAMP_REPLACEMENT);
  return path.join(
    devLogsDir(path, workspaceRoot),
    `${run.label ?? DEFAULT_RUN_LABEL}-${stamp}${RUN_FILE_SUFFIX}`
  );
};

export const isRunFileName = (fileName: string): boolean =>
  fileName.endsWith(RUN_FILE_SUFFIX) &&
  RUN_FILE_PREFIXES.some((prefix) => fileName.startsWith(prefix));

// Strip whichever known `<label>-` prefix a run id carries, leaving the bare
// stamp. Length matters: the stamp itself begins with a year, so removing the
// wrong-length prefix would corrupt the recovered timestamp.
const stripRunLabel = (runId: string): string => {
  for (const prefix of RUN_FILE_PREFIXES) {
    if (runId.startsWith(prefix)) {
      return runId.slice(prefix.length);
    }
  }
  return runId;
};

export const runIdFromFileName = (fileName: string): string =>
  fileName.slice(0, fileName.length - RUN_FILE_SUFFIX.length);

export const runFileName = (runId: string): string =>
  runId.endsWith(RUN_FILE_SUFFIX) ? runId : `${runId}${RUN_FILE_SUFFIX}`;

// Refuse ids that could escape the logs directory (path traversal / separators).
export const isSafeRunId = (runId: string): boolean =>
  !runId.includes("/") && !runId.includes("\\") && !runId.includes("..");

export const runStartedAtIso = (runId: string): string | null => {
  const stamp = stripRunLabel(runId);
  const separatorIndex = stamp.indexOf("T");
  if (separatorIndex === -1) {
    return null;
  }
  const groups = RUN_STAMP_TIME_PATTERN.exec(
    stamp.slice(separatorIndex + 1)
  )?.groups;
  if (groups === undefined) {
    return null;
  }
  const iso = `${stamp.slice(0, separatorIndex)}T${groups.hour}:${groups.minute}:${groups.second}.${groups.milli}Z`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
};

export const runSortKey = (run: DevLogRun): string => run.startedAt ?? run.id;

export const runAgeMillis = (run: DevLogRun, nowMillis: number): number => {
  const iso = run.startedAt ?? run.modifiedAt;
  if (iso === null) {
    return UNKNOWN_AGE_MILLIS;
  }
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? UNKNOWN_AGE_MILLIS : nowMillis - parsed;
};

export const matchesFilters = (
  entry: DevEventLogEntry,
  options: ReadDevLogRunOptions
): boolean => {
  if (options.type !== undefined && entry.type !== options.type) {
    return false;
  }
  return (
    options.sessionId === undefined || entry.sessionId === options.sessionId
  );
};

// Split into complete (newline-terminated) records. The trailing element is
// always either "" (file ended with a newline) or a partially written line that
// is still being appended; neither is a complete record, so drop it.
export const completeLines = (contents: string): readonly string[] =>
  contents.split(LINE_SEPARATOR).slice(0, -1);
