import type { FileSystem, Path, Ref } from "effect";

import {
  Cause,
  Duration,
  Effect,
  HashMap,
  HashSet,
  Option,
  Schedule,
  Stream,
} from "effect";

import type { CliIoShape } from "../../../../contracts/internal/src/cli/cli-io.ts";
import type { DaemonRuntime } from "../../../../runloop/local/src/daemon/server/server-types.ts";
import type { FeatureBootResult } from "../../../../runloop/local/src/feature-boot/types.ts";
import type { AppliedDevReload } from "./reload-observer.ts";

import { formatWarning } from "../../../../contracts/internal/src/cli/cli-messages.ts";
import { mtimeMs } from "./fs-mtime.ts";
import { onSnapshotError } from "./reload-watcher-diagnostics.ts";
import { rootPersonaChangeStream } from "./root-persona-watch.ts";
import { formatUnknownError } from "../../../../utils/core/src/error-formatting.ts";

const EMPTY_COUNT = 0;

const RELOAD_POLL_INTERVAL_MS = 500;

const SNAPSHOT_STAT_CONCURRENCY = 32;

interface DevReloadWatcherOptions {
  readonly onAppliedReload?:
    | ((reload: AppliedDevReload) => Effect.Effect<void>)
    | undefined;
}

type DaemonContext =
  DaemonRuntime["contextEffect"] extends Effect.Effect<
    infer Success,
    unknown,
    unknown
  >
    ? Success
    : never;

// The resolved dependencies every reload helper closes over. Captured once at
// the top of `startDevReloadWatcher` and threaded explicitly so each helper can
// live at module scope instead of nesting inside the watcher.
interface WatcherDeps {
  readonly cliIo: CliIoShape;
  readonly daemonContext: DaemonContext;
  readonly featuresRoot: string;
  readonly fs: FileSystem.FileSystem;
  readonly ignorePatterns: readonly string[];
  readonly lastGoodBoot: Ref.Ref<Option.Option<FeatureBootResult>>;
  readonly options: DevReloadWatcherOptions;
  readonly path: Path.Path;
  readonly pending: Ref.Ref<HashSet.HashSet<string>>;
}

// `watchEvents` emits one path per change; `pollingEvents` and the root-persona
// stream emit a batch of changed paths per tick. Normalize both shapes to the
// set of individual candidate paths added to `pending`.
const addCandidates =
  (candidate: string | readonly string[]) =>
  (set: HashSet.HashSet<string>): HashSet.HashSet<string> => {
    const paths = typeof candidate === "string" ? [candidate] : candidate;
    let next = set;
    for (const value of paths) {
      next = HashSet.add(next, value);
    }
    return next;
  };

const normalizeReloadPath = (candidate: string): string =>
  candidate.replaceAll("\\", "/");

const presentEntries = (
  stats: readonly Option.Option<readonly [string, number]>[]
): readonly (readonly [string, number])[] =>
  stats.flatMap((entry) => (Option.isSome(entry) ? [entry.value] : []));

const diffSnapshots = (
  previous: HashMap.HashMap<string, number>,
  current: HashMap.HashMap<string, number>
): readonly string[] => {
  const changed: string[] = [];
  for (const [candidate, mtime] of HashMap.toEntries(current)) {
    const previousMtime = HashMap.get(previous, candidate);
    if (Option.isNone(previousMtime) || previousMtime.value !== mtime) {
      changed.push(candidate);
    }
  }
  for (const candidate of HashMap.keys(previous)) {
    if (!HashMap.has(current, candidate)) {
      changed.push(candidate);
    }
  }
  return changed;
};

const snapshotReloadFiles = Effect.fn("DevReloadWatcher.snapshotReloadFiles")(
  function* (deps: WatcherDeps) {
    const entries = yield* deps.fs
      .readDirectory(deps.featuresRoot, { recursive: true })
      .pipe(
        Effect.catchCause(
          onSnapshotError(
            deps.cliIo,
            `failed to read ${deps.featuresRoot}`,
            [] as readonly string[]
          )
        )
      );
    const stats = yield* Effect.forEach(
      entries,
      (entry) =>
        deps.fs.stat(deps.path.join(deps.featuresRoot, entry)).pipe(
          Effect.map((info) =>
            info.type === "File"
              ? Option.some([
                  normalizeReloadPath(entry),
                  mtimeMs(info),
                ] as const)
              : Option.none<readonly [string, number]>()
          ),
          Effect.catchCause(
            onSnapshotError(
              deps.cliIo,
              `failed to stat ${entry}`,
              Option.none<readonly [string, number]>()
            )
          )
        ),
      { concurrency: SNAPSHOT_STAT_CONCURRENCY }
    );
    return HashMap.fromIterable(presentEntries(stats));
  }
);

// A poll stream that diffs each tick against a running baseline seeded from
// `initialBaseline`. Extracted so both the pure-polling mode and the watch→poll
// fallback can share the diffing loop while seeding the baseline differently.
const pollFrom = (
  deps: WatcherDeps,
  initialBaseline: Effect.Effect<HashMap.HashMap<string, number>>
): Stream.Stream<string> =>
  Stream.unwrap(
    initialBaseline.pipe(
      Effect.map((initial) =>
        Stream.fromSchedule(
          Schedule.spaced(Duration.millis(RELOAD_POLL_INTERVAL_MS))
        ).pipe(
          Stream.mapEffect(() => snapshotReloadFiles(deps)),
          Stream.mapAccum(
            () => initial,
            (previous, current) =>
              [current, diffSnapshots(previous, current)] as const
          )
        )
      )
    )
  );

// Build the merged change-event stream: feature events (fs.watch with a polling
// fallback, or polling outright when `usePolling`) merged with the separately
// polled root-persona stream.
//
// The whole stream is `unwrap`ped from an effect so it can capture a single
// baseline snapshot at subscription time. `fs.watch` is event-driven and keeps
// no snapshot of its own, so when it fails at runtime and we fall back to
// polling, there is no "last-known" baseline to diff against — the naive fix
// re-snapshots fresh, which bakes any edit saved in the gap between the last
// watch event and the fallback into the new baseline and never reports it until
// the *next* edit. Instead we cache the baseline taken at subscription (before
// any watch event flows) and seed the fallback poll with it, so a gap edit is
// still detected. The cost is that the first fallback poll may re-report edits
// already applied via watch events; those coalesce (100ms debounce) into a
// single reconciling reload and the running baseline advances so later polls are
// quiet — a bounded, self-correcting over-report, not a flood.
const buildReloadEventStream = (
  deps: WatcherDeps,
  usePolling: boolean
): Stream.Stream<string> =>
  Stream.unwrap(
    Effect.gen(function* () {
      // Memoize the baseline so it is computed once and reused, and force it now
      // — at subscription, before watch events flow — so the fallback reuses this
      // pre-failure snapshot rather than snapshotting fresh at fallback time.
      const baseline = yield* Effect.cached(snapshotReloadFiles(deps));
      yield* baseline;

      const watchEvents = deps.fs.watch(deps.featuresRoot).pipe(
        Stream.map((event) => normalizeReloadPath(event.path)),
        Stream.filter((candidate) => candidate.length !== EMPTY_COUNT)
      );

      // `ori.md` (RFC 0002 root-persona.md) lives above `featuresRoot`; watch it separately and
      // feed its changes through the same pending/drain pipeline (see
      // root-persona-watch.ts for why this is a poll, not an fs.watch).
      const rootPersonaEvents = rootPersonaChangeStream(
        deps.fs,
        deps.path,
        deps.featuresRoot
      );

      const featureEvents = usePolling
        ? pollFrom(deps, baseline)
        : watchEvents.pipe(
            Stream.catchCause((cause) =>
              Stream.unwrap(
                deps.cliIo
                  .writeStderr(
                    `${formatWarning(`reload: file watch failed (${formatUnknownError(Cause.squash(cause))}); falling back to polling`)}\n`
                  )
                  .pipe(Effect.ignore, Effect.as(pollFrom(deps, baseline)))
              )
            )
          );

      return Stream.merge(featureEvents, rootPersonaEvents);
    })
  );

export {
  addCandidates,
  buildReloadEventStream,
  diffSnapshots,
  normalizeReloadPath,
  presentEntries,
  snapshotReloadFiles,
};
export type { DaemonContext, DevReloadWatcherOptions, WatcherDeps };
