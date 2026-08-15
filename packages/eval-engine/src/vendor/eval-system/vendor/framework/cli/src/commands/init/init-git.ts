import { Effect } from "effect";
import { ChildProcess } from "effect/unstable/process";

import type { CliIo } from "../../../../contracts/internal/src/cli/cli-io.ts";

import {
  SPAWN_FAILURE_EXIT_CODE,
  spawnExitCode,
} from "../tool-spawn.ts";

const GIT_SUCCESS_EXIT_CODE = 0;

const INITIAL_COMMIT_MESSAGE = "Initial commit";

// Used only as a fallback when the machine has no configured git identity, so a
// fresh intern still gets its first commit without the user touching git.
const GIT_FALLBACK_AUTHOR = [
  "-c",
  "user.name=RouteKitEval",
  "-c",
  "user.email=routekit-eval@users.noreply.github.com",
] as const;

export const runGitInit = Effect.fn("ProjectInit.gitInit")(function* (input: {
  readonly cliIo: CliIo["Service"];
  readonly cwd: string;
}) {
  const exitCode = yield* spawnExitCode(
    ChildProcess.make("git", ["init"], {
      cwd: input.cwd,
      stderr: "ignore",
      stdout: "ignore",
    })
  );

  if (exitCode !== GIT_SUCCESS_EXIT_CODE) {
    const detail =
      exitCode === SPAWN_FAILURE_EXIT_CODE
        ? "git was not available on PATH"
        : `git init exited with code ${exitCode}`;
    yield* input.cliIo.writeStderr(
      `\nCould not initialize Git (${detail}). Continuing without Git or an initial commit.\n`
    );
    return false;
  }

  return true;
});

const runGitCommand = Effect.fn("runGitCommand")(function* (
  cwd: string,
  args: readonly string[]
) {
  return yield* spawnExitCode(
    ChildProcess.make("git", args, {
      cwd,
      stderr: "ignore",
      stdout: "ignore",
    })
  );
});

/**
 * Stage everything and record an "Initial commit" so the generated workspace
 * starts from a clean, committed baseline without the user running git. Entirely
 * best-effort: if git is unavailable or the commit fails for any reason, the
 * scaffold is left in place untouched. The plain commit runs first so the user's
 * own git identity is used when configured, falling back to a generic identity
 * only on machines that have none.
 */
export const createInitialCommit = Effect.fn("ProjectInit.initialCommit")(
  function* (projectRoot: string) {
    const staged = yield* runGitCommand(projectRoot, ["add", "-A"]);
    if (staged !== GIT_SUCCESS_EXIT_CODE) {
      return;
    }

    const committed = yield* runGitCommand(projectRoot, [
      "commit",
      "-m",
      INITIAL_COMMIT_MESSAGE,
    ]);
    if (committed === GIT_SUCCESS_EXIT_CODE) {
      return;
    }

    yield* runGitCommand(projectRoot, [
      ...GIT_FALLBACK_AUTHOR,
      "commit",
      "-m",
      INITIAL_COMMIT_MESSAGE,
    ]);
  }
);
