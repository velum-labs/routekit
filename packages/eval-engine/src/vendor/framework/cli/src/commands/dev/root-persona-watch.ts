import type { FileSystem, Path } from "effect";

import { Duration, Effect, Option, Schedule, Stream } from "effect";

import { ROOT_PERSONA_FILE } from "../../../../runloop/local/src/contributions/root-persona.ts";
import { workspaceRootFromFeaturesRoot } from "../../../../runloop/local/src/dev/descriptor.ts";
import { mtimeMs } from "./fs-mtime.ts";

const EMPTY_COUNT = 0;
const ROOT_PERSONA_POLL_INTERVAL_MS = 500;

const sameMtime = (
  previous: Option.Option<number>,
  current: Option.Option<number>
): boolean => {
  if (Option.isNone(previous) && Option.isNone(current)) {
    return true;
  }
  if (Option.isSome(previous) && Option.isSome(current)) {
    return previous.value === current.value;
  }
  return false;
};

/**
 * The root persona `ori.md` (RFC 0002 root-persona.md) lives at the workspace root, ABOVE
 * `featuresRoot`, so neither the feature-root watch nor its polling snapshot
 * observe it. This stream watches it on its own and emits `[ori.md]` whenever
 * the file is created, changed, or deleted.
 *
 * The persona is re-read on every boot (see `feature-boot/index.ts`), so feeding this
 * path through the watcher's existing pending/drain pipeline is enough to
 * refresh it — no feature is "affected", which carries every feature's
 * contributions forward unchanged while the root persona is re-imported.
 *
 * We POLL the single file (existence + mtime) rather than `fs.watch` it: a
 * per-file `fs.watch` errors when the file is absent (it stats first), whereas a
 * 1-stat-per-tick poll handles create, change, and delete uniformly and at the
 * same latency as the watcher's polling fallback.
 */
export const rootPersonaChangeStream = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  featuresRoot: string
): Stream.Stream<string> => {
  const workspaceRoot = workspaceRootFromFeaturesRoot(path, featuresRoot);
  const rootPersonaAbsolute = path.join(workspaceRoot, ROOT_PERSONA_FILE);
  const snapshot = fs.stat(rootPersonaAbsolute).pipe(
    Effect.map((info) =>
      info.type === "File" ? Option.some(mtimeMs(info)) : Option.none<number>()
    ),
    Effect.catchCause(() => Effect.succeed(Option.none<number>()))
  );

  return Stream.unwrap(
    snapshot.pipe(
      Effect.map((initial) =>
        Stream.fromSchedule(
          Schedule.spaced(Duration.millis(ROOT_PERSONA_POLL_INTERVAL_MS))
        ).pipe(
          Stream.mapEffect(() => snapshot),
          Stream.mapAccum(
            () => initial,
            (previous, current) =>
              [
                current,
                sameMtime(previous, current) ? [] : [ROOT_PERSONA_FILE],
              ] as const
          ),
          Stream.filter((changed) => changed.length !== EMPTY_COUNT)
        )
      )
    )
  );
};
