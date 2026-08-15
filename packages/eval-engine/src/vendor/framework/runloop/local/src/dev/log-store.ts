import type { Path } from "effect";

import {
  Clock,
  Context,
  Duration,
  Effect,
  Layer,
  Option,
  Ref,
  Stream,
} from "effect";

import type { RuntimeServerError } from "../../../../contracts/internal/src/errors.ts";
import type {
  DevEventLogEntry,
  DevLogRun,
} from "../../../../contracts/internal/src/runtime/dev-event-log.ts";
import type { SessionMetadata } from "../../../../contracts/internal/src/runtime/session-metadata.ts";
import type {
  DevLogRetentionPolicy,
  DevLogStoreContext,
  PruneDevLogRunsOptions,
  ReadDevLogRunOptions,
  RunLabel,
} from "./log-store-paths.ts";

import { decodeDevEventLogEntryLineCompat } from "../../../../contracts/internal/src/runtime/dev-event-log.ts";
import { decodeSessionMetadata } from "../../../../contracts/internal/src/runtime/session-metadata.ts";
import {
  completeLines,
  DEFAULT_DEV_LOG_RETENTION,
  devLogsDir,
  EMPTY_COUNT,
  eventLogFilePath,
  FALLBACK_SIZE,
  FOLLOW_POLL_MILLIS,
  isRunFileName,
  isSafeRunId,
  KEPT_INCREMENT,
  LATEST_RUN_ID,
  matchesFilters,
  runAgeMillis,
  runFileName,
  runIdFromFileName,
  runSortKey,
  runStartedAtIso,
  RUN_FILE_SUFFIX,
  sessionMetadataFilePath,
  sessionsDir,
} from "./log-store-paths.ts";

const readRunFileNames = Effect.fn("DevLogStore.readRunFileNames")(function* (
  context: DevLogStoreContext
) {
  const { fs, logsDir } = context;
  const exists = yield* fs
    .exists(logsDir)
    .pipe(Effect.orElseSucceed(() => false));
  if (!exists) {
    return [];
  }
  const entries = yield* fs
    .readDirectory(logsDir)
    .pipe(Effect.orElseSucceed(() => [] as readonly string[]));
  return entries.filter(isRunFileName);
});

const describeRun = Effect.fn("DevLogStore.describeRun")(function* (
  context: DevLogStoreContext,
  fileName: string
) {
  const { fs, path, logsDir } = context;
  const id = runIdFromFileName(fileName);
  const info = yield* fs.stat(path.join(logsDir, fileName)).pipe(Effect.option);
  return {
    id,
    modifiedAt: info.pipe(
      Option.flatMap((value) => value.mtime),
      Option.map((mtime) => mtime.toISOString()),
      Option.getOrNull
    ),
    sizeBytes: info.pipe(
      Option.map((value) => Number(value.size)),
      Option.getOrElse(() => FALLBACK_SIZE)
    ),
    startedAt: runStartedAtIso(id),
  } satisfies DevLogRun;
});

/** List persisted run files under `logsDir`, newest first. */
const listDevLogRuns = Effect.fn("DevLogStore.listDevLogRuns")(function* (
  context: DevLogStoreContext
) {
  const fileNames = yield* readRunFileNames(context);
  const runs = yield* Effect.forEach(
    fileNames,
    (fileName) => describeRun(context, fileName),
    {
      concurrency: "unbounded",
    }
  );
  return runs.toSorted((left, right) =>
    runSortKey(right).localeCompare(runSortKey(left))
  );
});

/** The run id (e.g. `dev-…Z`) for a run file path, for callers holding a path. */
const devLogRunIdFromPath = (path: Path.Path, filePath: string): string =>
  runIdFromFileName(path.basename(filePath));

/**
 * Best-effort retention for `.ori/logs`: walk runs newest-first and delete any
 * that fall outside the policy — beyond `maxRuns`, older than `maxAgeMillis`,
 * or past the cumulative `maxTotalBytes` budget (each bound is monotonic in
 * newest-first order, so one pass keeps the most-recent contiguous set). The
 * active run (`keepRunId`) is never deleted and per-file delete errors are
 * swallowed, so a busy/locked logs dir can never take down the dev session.
 * Returns the run ids removed.
 */
const pruneDevLogRuns = Effect.fn("DevLogStore.pruneDevLogRuns")(function* (
  context: DevLogStoreContext,
  options: PruneDevLogRunsOptions = {}
) {
  const { fs, path, logsDir } = context;
  const policy = options.policy ?? DEFAULT_DEV_LOG_RETENTION;
  const runs = yield* listDevLogRuns(context);
  const nowMillis = yield* Clock.currentTimeMillis;

  const toDelete: string[] = [];
  let keptCount = EMPTY_COUNT;
  let keptBytes = FALLBACK_SIZE;
  for (const run of runs) {
    const keepActive = run.id === options.keepRunId;
    const withinCount = keptCount < policy.maxRuns;
    const withinAge = runAgeMillis(run, nowMillis) <= policy.maxAgeMillis;
    const withinBudget = keptBytes + run.sizeBytes <= policy.maxTotalBytes;
    if (keepActive || (withinCount && withinAge && withinBudget)) {
      keptCount += KEPT_INCREMENT;
      keptBytes += run.sizeBytes;
    } else {
      toDelete.push(run.id);
    }
  }

  yield* Effect.forEach(
    toDelete,
    (id) => fs.remove(path.join(logsDir, runFileName(id))).pipe(Effect.ignore),
    {
      concurrency: "unbounded",
    }
  );
  return toDelete;
});

/**
 * Resolve a caller-supplied run id (or the `latest` alias / empty string) to a
 * concrete on-disk run id, or `None` when nothing matches. Used by the daemon
 * route to answer 404 before opening a stream.
 */
const resolveDevLogRunId = Effect.fn("DevLogStore.resolveDevLogRunId")(
  function* (context: DevLogStoreContext, runId: string) {
    const { fs, path, logsDir } = context;
    if (runId === LATEST_RUN_ID || runId.length === EMPTY_COUNT) {
      const runs = yield* listDevLogRuns(context);
      const latest = runs.at(0);
      return latest === undefined ? Option.none() : Option.some(latest.id);
    }
    if (!isSafeRunId(runId)) {
      return Option.none();
    }
    const id = runId.endsWith(RUN_FILE_SUFFIX)
      ? runIdFromFileName(runId)
      : runId;
    const exists = yield* fs
      .exists(path.join(logsDir, runFileName(id)))
      .pipe(Effect.orElseSucceed(() => false));
    return exists ? Option.some(id) : Option.none();
  }
);

/**
 * Read one session's persisted sidecar (`sessions/<id>/metadata.json`), or
 * `None` when unknown / missing / unparseable. Reads go through the disk reader
 * (not the in-memory registry), so it works after the daemon exits. Ids that
 * could escape the sessions directory (separators / `..`) are refused up front.
 */
const readSessionMetadata = Effect.fn("DevLogStore.readSessionMetadata")(
  function* (context: DevLogStoreContext, sessionId: string) {
    const { fs, path, logsDir } = context;
    if (!isSafeRunId(sessionId) || sessionId.length === EMPTY_COUNT) {
      return Option.none<SessionMetadata>();
    }
    const filePath = sessionMetadataFilePath(logsDir, path, sessionId);
    const contents = yield* fs.readFileString(filePath).pipe(Effect.option);
    return Option.isNone(contents)
      ? Option.none<SessionMetadata>()
      : yield* decodeSessionMetadata(contents.value).pipe(Effect.option);
  }
);

const decodeMatching = (
  lines: readonly string[],
  options: ReadDevLogRunOptions
): Effect.Effect<readonly DevEventLogEntry[]> =>
  Effect.forEach(
    lines,
    (line) => decodeDevEventLogEntryLineCompat(line).pipe(Effect.option),
    {
      concurrency: "unbounded",
    }
  ).pipe(
    Effect.map((decoded) =>
      decoded.flatMap((entry) =>
        Option.isSome(entry) && matchesFilters(entry.value, options)
          ? [entry.value]
          : []
      )
    )
  );

const readContents = (
  context: DevLogStoreContext,
  id: string
): Effect.Effect<string> =>
  context.fs
    .readFileString(context.path.join(context.logsDir, runFileName(id)))
    .pipe(Effect.orElseSucceed(() => ""));

/** Decode a run file's complete records (no filters); shared with the sidecar retention pass. */
const readRunEntries = (
  context: DevLogStoreContext,
  runId: string
): Effect.Effect<readonly DevEventLogEntry[]> =>
  readContents(context, runId).pipe(
    Effect.flatMap((contents) => decodeMatching(completeLines(contents), {}))
  );

const makeFollowRunStream = Effect.fn("DevLogStore.makeFollowRunStream")(
  function* (
    context: DevLogStoreContext,
    id: string,
    options: ReadDevLogRunOptions
  ) {
    const processed = yield* Ref.make(EMPTY_COUNT);
    const poll = Effect.gen(function* () {
      const lines = completeLines(yield* readContents(context, id));
      const seen = yield* Ref.getAndSet(processed, lines.length);
      return yield* decodeMatching(lines.slice(seen), options);
    });
    const backlog = Stream.fromIterable(yield* poll);
    const live = Stream.tick(Duration.millis(FOLLOW_POLL_MILLIS)).pipe(
      Stream.mapEffect(() => poll),
      Stream.flatMap((entries) => Stream.fromIterable(entries))
    );
    return Stream.concat(backlog, live);
  }
);

const followRunStream = (
  context: DevLogStoreContext,
  id: string,
  options: ReadDevLogRunOptions
): Stream.Stream<DevEventLogEntry> =>
  Stream.unwrap(makeFollowRunStream(context, id, options));

const makeRunStream = (
  context: DevLogStoreContext,
  id: string,
  options: ReadDevLogRunOptions
): Stream.Stream<DevEventLogEntry> =>
  options.follow === true
    ? followRunStream(context, id, options)
    : Stream.fromIterableEffect(
        readContents(context, id).pipe(
          Effect.flatMap((contents) =>
            decodeMatching(completeLines(contents), options)
          )
        )
      );

/**
 * Stream decoded records from a run file. Unknown / `latest` ids resolve via
 * {@link resolveDevLogRunId}; an unresolved id yields an empty stream. With
 * `follow`, the file is polled for appended records (post-mortem-friendly,
 * daemon-independent) after the existing backlog is emitted.
 */
export const readDevLogRun = (
  context: DevLogStoreContext,
  runId: string,
  options: ReadDevLogRunOptions
): Stream.Stream<DevEventLogEntry> =>
  Stream.unwrap(
    resolveDevLogRunId(context, runId).pipe(
      Effect.map((resolved) =>
        Option.match(resolved, {
          onNone: () => Stream.empty,
          onSome: (id) => makeRunStream(context, id, options),
        })
      )
    )
  );

export interface DevLogStoreShape {
  readonly list: () => Effect.Effect<readonly DevLogRun[]>;
  readonly read: (
    runId: string,
    options: ReadDevLogRunOptions
  ) => Stream.Stream<DevEventLogEntry, RuntimeServerError>;
  readonly resolve: (runId: string) => Effect.Effect<Option.Option<string>>;
  /** Read one session's persisted sidecar metadata; `None` when unknown. */
  readonly readSession: (
    sessionId: string
  ) => Effect.Effect<Option.Option<SessionMetadata>>;
  readonly listPersistedSessions?: () => Effect.Effect<
    readonly SessionMetadata[]
  >;
}

/**
 * Daemon-side reader over the on-disk `.ori/logs` directory: the port the HTTP
 * log routes read persisted runs and session sidecars through. This is a pure
 * port — the effectful adapter that resolves a real logs directory and probes
 * the filesystem lives in `DevLogStoreLive` (`dev-log-store-live.ts`);
 * {@link DevLogStore.layerTest} provides an inert stand-in for tests.
 */
export class DevLogStore extends Context.Service<
  DevLogStore,
  DevLogStoreShape
>()("ori/runtime/DevLogStore") {
  /**
   * Test seam: a `DevLogStore` that behaves as if no workspace logs directory is
   * configured — empty listings, no resolved run, no session metadata, and an
   * empty read stream. Override only the fields a case needs; the effectful live
   * implementation that reads real `.ori/logs` files lives in the
   * `DevLogStoreLive` adapter (`dev-log-store-live.ts`).
   */
  static readonly layerTest = (
    impl: Partial<DevLogStoreShape>
  ): Layer.Layer<DevLogStore> =>
    Layer.succeed(DevLogStore)(
      DevLogStore.of({
        list: () => Effect.succeed([]),
        read: () => Stream.empty,
        resolve: () => Effect.succeedNone,
        readSession: () => Effect.succeedNone,
        listPersistedSessions: () => Effect.succeed([]),
        ...impl,
      })
    );
}

export {
  DEFAULT_DEV_LOG_RETENTION,
  devLogsDir,
  eventLogFilePath,
  listDevLogRuns,
  devLogRunIdFromPath,
  pruneDevLogRuns,
  resolveDevLogRunId,
  readRunEntries,
  readSessionMetadata,
  sessionMetadataFilePath,
  sessionsDir,
};
export type {
  DevLogRetentionPolicy,
  PruneDevLogRunsOptions,
  ReadDevLogRunOptions,
  DevLogStoreContext,
  RunLabel,
};
