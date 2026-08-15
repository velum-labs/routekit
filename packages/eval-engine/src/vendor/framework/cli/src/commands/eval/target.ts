// Turning what the caller named into the two directories `ori eval` needs. Split
// out of `command.ts` so the precedence rule, the existence check, and the
// file-vs-directory decision sit together in one testable place instead of being
// spread across the command and discovery.
import { Effect, FileSystem, Option, Path } from "effect";

import { CliFailureError } from "../../../../contracts/internal/src/errors.ts";
import { EVAL_SUFFIX } from "./discover.ts";

/**
 * Where to discover evals, and where to run `node --test` from.
 *
 * They are the same directory in the common case and differ for exactly one
 * input: a named single file. `node --test` receives absolute file paths, so it
 * only needs a working directory it can actually chdir into, and a file is not
 * one.
 */
export interface EvalTarget {
  readonly searchRoot: string;
  readonly workingDirectory: string;
}

/**
 * Resolve what the caller named, stat it once, and answer three questions with
 * that single syscall: does it exist, where do we discover from, and where does
 * the child process run.
 *
 * Keeping all three here is deliberate. Splitting the existence check from the
 * file-vs-directory check invites the two to disagree, and deciding the working
 * directory anywhere other than beside the search root means re-statting the same
 * path to re-learn something already known.
 *
 * Takes only the two fields it reads rather than the whole command config, so it
 * carries no dependency back on the command module.
 */
export const resolveEvalTarget = Effect.fn("EvalCommand.resolveTarget")(
  function* (requestedBy: {
    readonly path: Option.Option<string>;
    readonly target: Option.Option<string>;
  }) {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    // `--path` wins over the positional, so an explicit flag is never overridden
    // by a stray argument.
    const requested = Option.orElse(requestedBy.path, () => requestedBy.target);
    if (Option.isNone(requested)) {
      const current = path.resolve();
      return {
        searchRoot: current,
        workingDirectory: current,
      } satisfies EvalTarget;
    }

    const resolved = path.resolve(requested.value);
    const info = yield* fs.stat(resolved).pipe(Effect.option);
    if (Option.isNone(info)) {
      // A named target that does not exist is a failure, not an empty run.
      // Discovery reports "no files found" for an unreadable path, so a typo
      // would otherwise read as a clean pass that quietly ran nothing.
      return yield* new CliFailureError({
        detail: `No such file or directory: ${resolved}`,
        hint: `Pass a path to a ${EVAL_SUFFIX} file or a directory containing one, or omit it to search the current directory.`,
      });
    }

    // Decided by stat rather than by the filename: a directory named
    // `something.eval.ts` is legal, and treating it as a file would hand
    // `node --test` its parent and silently widen the run.
    const isFile = info.value.type === "File";
    if (isFile && !resolved.endsWith(EVAL_SUFFIX)) {
      // Same rule as a missing target, one step further along: an explicitly
      // named file that cannot contain evals runs nothing, and reporting that as
      // a pass hides a typo. A directory holding no evals is still fine, because
      // "nothing to run here" is a legitimate answer for a directory.
      return yield* new CliFailureError({
        detail: `Not an eval file: ${resolved}`,
        hint: `\`ori eval\` only runs ${EVAL_SUFFIX} files. Name one of those, or a directory containing them.`,
      });
    }

    return {
      searchRoot: resolved,
      workingDirectory: isFile ? path.dirname(resolved) : resolved,
    } satisfies EvalTarget;
  }
);
