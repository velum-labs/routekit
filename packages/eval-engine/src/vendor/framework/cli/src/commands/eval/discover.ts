// Kept separate from the command so it can be unit-tested without spawning
// `node --test`. Returns absolute paths so the runner can hand them to
// `node --test` regardless of `cwd`.
import { Effect, FileSystem, Option, Path } from "effect";

export const EVAL_SUFFIX = ".eval.ts";
// A scaffolded workspace keeps its `ori` SDK cache and installed deps here; an
// eval file would never live under them, and walking them is slow and noisy.
const IGNORED_SEGMENTS = new Set(["node_modules", ".ori", ".git"]);

const isEvalFile = (relativePath: string): boolean =>
  relativePath.endsWith(EVAL_SUFFIX) &&
  !relativePath.split("/").some((segment) => IGNORED_SEGMENTS.has(segment));

export const discoverEvalFiles = Effect.fn("EvalCommand.discover")(function* (
  searchRoot: string
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const info = yield* fs.stat(searchRoot).pipe(Effect.option);
  if (Option.isSome(info) && info.value.type === "File") {
    return searchRoot.endsWith(EVAL_SUFFIX) ? [searchRoot] : [];
  }

  const entries = yield* fs
    .readDirectory(searchRoot, { recursive: true })
    .pipe(Effect.catchCause(() => Effect.succeed<readonly string[]>([])));

  return entries
    .filter(isEvalFile)
    .toSorted((left, right) => left.localeCompare(right))
    .map((relativePath) => path.join(searchRoot, relativePath));
});
