import type { FileSystem } from "effect";

import { Option } from "effect";

/** A modification time of 0 stands in for "unknown", sorting before any real mtime. */
export const DEFAULT_MTIME_MS = 0;

/**
 * The file's modification time in epoch milliseconds, falling back to
 * {@link DEFAULT_MTIME_MS} when the platform did not report one.
 */
export const mtimeMs = (info: FileSystem.File.Info): number =>
  info.mtime.pipe(
    Option.map((mtime) => mtime.getTime()),
    Option.getOrElse(() => DEFAULT_MTIME_MS)
  );
