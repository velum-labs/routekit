import { Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import type { CliIo } from "../../../../contracts/internal/src/cli/cli-io.ts";

const SPAWN_FAILURE_EXIT_CODE = -1;

export interface CommandResult {
  readonly exitCode: number;
  readonly output: string;
}

/**
 * Spawn a command in `cwd`, buffering stdout/stderr so successful setup stays
 * concise. Expected platform spawn/stream failures resolve to a sentinel exit
 * code instead of aborting init.
 */
export const runBufferedCommand = Effect.fn("runBufferedCommand")(function* (
  cwd: string,
  command: string,
  args: readonly string[]
) {
  return yield* Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    return yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make(command, args, {
            cwd,
            stderr: "pipe",
            stdin: "ignore",
            stdout: "pipe",
          })
        );
        const [exitCode, stdout, stderr] = yield* Effect.all(
          [
            handle.exitCode,
            handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
            handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
          ],
          { concurrency: "unbounded" }
        );
        return {
          exitCode: Number(exitCode),
          output: `${stdout}${stderr}`,
        };
      })
    );
  }).pipe(
    Effect.catchTag("PlatformError", () =>
      Effect.succeed({
        exitCode: SPAWN_FAILURE_EXIT_CODE,
        output: "",
      })
    )
  );
});

export const writeCommandOutput = Effect.fn("ProjectInit.writeCommandOutput")(
  function* (cliIo: CliIo["Service"], output: string) {
    const trimmed = output.trim();
    if (trimmed === "") {
      return;
    }

    yield* cliIo.writeStderr(`\n${trimmed}\n`);
  }
);
