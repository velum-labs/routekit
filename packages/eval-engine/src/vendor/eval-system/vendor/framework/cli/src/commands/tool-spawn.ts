import { Effect } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

/**
 * Exit code stood in for a process that never ran (the binary was missing, or
 * the spawn itself failed) as opposed to one that ran and reported a failure.
 * Callers distinguish the two so a missing toolchain gets an "install it" hint
 * rather than being reported as a tool-detected error.
 */
export const SPAWN_FAILURE_EXIT_CODE = -1;

/**
 * Run a command to completion and reduce it to a plain exit code, collapsing a
 * spawn-time failure to {@link SPAWN_FAILURE_EXIT_CODE}. The error channel is
 * discharged here so command flows can branch on a number instead of threading
 * a `PlatformError` they would only ever map to the same sentinel.
 */
export const spawnExitCode = Effect.fn("ToolSpawn.exitCode")(function* (
  command: ChildProcess.Command
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* spawner.exitCode(command).pipe(
    Effect.map(Number),
    Effect.orElseSucceed(() => SPAWN_FAILURE_EXIT_CODE)
  );
});

/**
 * Run a workspace tool with the terminal handed straight through, for tools
 * that stream their own diagnostics (`node --test`, oxlint, knip, …). Inheriting
 * all three streams is what keeps their output live and colourized, so the
 * surfaced failure stays terse and the tool's own reporting is the detail.
 */
export const spawnInheritedTool = Effect.fn("ToolSpawn.inheritedTool")(
  function* (input: {
    readonly args: readonly string[];
    readonly binPath: string;
    readonly cwd: string;
  }) {
    return yield* spawnExitCode(
      ChildProcess.make(input.binPath, input.args, {
        cwd: input.cwd,
        extendEnv: true,
        stderr: "inherit",
        stdin: "inherit",
        stdout: "inherit",
      })
    );
  }
);
