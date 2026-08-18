import { Effect, FileSystem, Path, PlatformError } from "effect";

import { randomId } from "../runtime-timing.js";
import { trimSurroundingSlashes } from "../network/url.js";

export type EffectFileLock = {
  readonly path: string;
  readonly release: Effect.Effect<void, PlatformError.PlatformError>;
};

function isAlreadyExists(error: PlatformError.PlatformError): boolean {
  return error.reason._tag === "AlreadyExists";
}

/**
 * Atomically replace a UTF-8 file by writing a sibling temporary first.
 *
 * Uses the Effect `FileSystem` and `Path` ports so callers can substitute a
 * test file system, while keeping RouteKit's sibling-temp + rename policy.
 */
export function writeFileAtomicEffect(
  path: string,
  content: string,
  options: { mode?: number } = {}
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const temporary = paths.join(
      paths.dirname(path),
      `${paths.basename(path)}.${process.pid}.${randomId(8)}.tmp`
    );
    yield* Effect.ensuring(
      Effect.gen(function* () {
        yield* fs.writeFileString(temporary, content, {
          ...(options.mode !== undefined ? { mode: options.mode } : {})
        });
        yield* fs.rename(temporary, path);
      }),
      fs.remove(temporary, { force: true }).pipe(Effect.ignore)
    );
  });
}

/**
 * Acquire an exclusive lock file. Creation is atomic (`wx`); callers own retry
 * policy and must release the returned handle. Contended locks return
 * `undefined` rather than failing.
 */
export function tryAcquireFileLockEffect(
  path: string
): Effect.Effect<EffectFileLock | undefined, PlatformError.PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const created = yield* fs.writeFileString(path, "", { flag: "wx" }).pipe(
      Effect.as(true as const),
      Effect.catchIf(isAlreadyExists, () => Effect.succeed(false as const))
    );
    if (!created) return undefined;
    let released = false;
    return {
      path,
      release: Effect.suspend(() => {
        if (released) return Effect.void;
        released = true;
        return fs.remove(path, { force: true });
      })
    };
  });
}

/**
 * Create an output directory. When it lives under a caller-owned data-directory
 * segment, drop a self-ignoring `.gitignore` so generated artifacts never
 * pollute the user's working tree.
 */
export function ensureRunOutputDirEffect(
  dir: string,
  options: { dataDirectoryNames?: readonly string[] } = {}
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    yield* fs.makeDirectory(dir, { recursive: true });
    const normalized = dir.split(paths.sep).join("/");
    const inManagedDirectory = (options.dataDirectoryNames ?? []).some((name) => {
      const segment = trimSurroundingSlashes(name.split(paths.sep).join("/"));
      return segment.length > 0 && `/${normalized}/`.includes(`/${segment}/`);
    });
    if (inManagedDirectory) {
      const ignorePath = paths.join(dir, ".gitignore");
      if (!(yield* fs.exists(ignorePath))) {
        yield* fs.writeFileString(ignorePath, "*\n");
      }
    }
    return dir;
  });
}
