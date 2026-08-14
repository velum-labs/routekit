/**
 * Adapted from Ori's eval discovery implementation.
 *
 * Ori source:
 * framework/cli/src/commands/eval/discover.ts
 */
import { Effect, FileSystem, Option, Path } from "effect";

import { EvalDiscoveryError, type EvalDiscovery, type EvalTargetOptions } from "../model.js";

export const EVAL_SUFFIX = ".eval.ts";

const IGNORED_SEGMENTS = new Set(["node_modules", ".ori", ".git"]);

const isEvalFile = (relativePath: string): boolean =>
  relativePath.endsWith(EVAL_SUFFIX) &&
  !relativePath.split(/[\\/]/u).some((segment) => IGNORED_SEGMENTS.has(segment));

export const discoverEvalFiles = Effect.fn("EvalEngine.discover")(function* (
  options: EvalTargetOptions
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = path.resolve(options.target);
  const info = yield* fs.stat(target).pipe(Effect.option);

  if (Option.isSome(info) && info.value.type === "File") {
    return {
      searchRoot: target,
      workingDirectory: options.workingDirectory
        ? path.resolve(options.workingDirectory)
        : path.dirname(target),
      files: target.endsWith(EVAL_SUFFIX) ? [target] : []
    } satisfies EvalDiscovery;
  }

  const entries = yield* fs.readDirectory(target, { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new EvalDiscoveryError({
          path: target,
          cause
        })
    )
  );

  return {
    searchRoot: target,
    workingDirectory: options.workingDirectory ? path.resolve(options.workingDirectory) : target,
    files: entries
      .filter(isEvalFile)
      .sort((left, right) => left.localeCompare(right))
      .map((relativePath) => path.join(target, relativePath))
  } satisfies EvalDiscovery;
});
