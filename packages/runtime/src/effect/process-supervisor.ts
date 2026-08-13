import { Effect, Option, PlatformError } from "effect";
import { ChildProcess } from "effect/unstable/process";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import { buildChildEnv } from "../environment.js";
import { type ExitInfo, type SuperviseSpawnOptions, terminateProcessGroup } from "../process.js";
import { registerCleanupEffect } from "./cleanup.js";

export type EffectSpawnOptions = Omit<SuperviseSpawnOptions, "signal">;

const DEFAULT_GRACE_MS = 5_000;

/**
 * Supervise a detached child as an Effect.
 *
 * The child runs in its own process group. Interruption, timeout, and scope
 * close terminate the whole group with SIGTERM → SIGKILL — Effect's default
 * child kill is not enough, because grandchildren would otherwise leak.
 */
export function superviseSpawnEffect(
  command: string,
  args: readonly string[],
  options: EffectSpawnOptions = {}
): Effect.Effect<ExitInfo, PlatformError.PlatformError, ChildProcessSpawner> {
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const env =
    options.env ?? buildChildEnv({ allow: options.envAllow ?? [], extra: options.extraEnv ?? {} });
  return Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* ChildProcess.make(command, [...args], {
        detached: true,
        env,
        extendEnv: false,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {})
      });
      const pid = Number(handle.pid);
      const killGroup = Effect.sync(() => {
        terminateProcessGroup(pid, graceMs);
      });
      yield* Effect.addFinalizer(() => killGroup);
      const unregister = yield* registerCleanupEffect(killGroup);

      const waited = yield* Effect.ensuring(
        options.timeoutMs === undefined
          ? handle.exitCode.pipe(Effect.map((code) => ({ timedOut: false, code })))
          : handle.exitCode.pipe(
              Effect.timeoutOption(options.timeoutMs),
              Effect.flatMap((opt) => {
                if (Option.isSome(opt)) {
                  return Effect.succeed({ timedOut: false, code: opt.value });
                }
                return killGroup.pipe(
                  Effect.andThen(handle.exitCode),
                  Effect.map((code) => ({ timedOut: true, code }))
                );
              })
            ),
        Effect.sync(() => {
          unregister();
        })
      );
      return {
        exitCode: Number(waited.code),
        signal: waited.timedOut ? ("SIGKILL" as const) : null,
        timedOut: waited.timedOut,
        aborted: false
      };
    })
  );
}
