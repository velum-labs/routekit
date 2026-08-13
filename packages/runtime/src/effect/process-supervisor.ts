import { Effect } from "effect";

import { type ExitInfo, type SuperviseSpawnOptions, superviseSpawn } from "../process.js";

export type EffectSpawnOptions = Omit<SuperviseSpawnOptions, "signal">;

/**
 * Effect adapter for RouteKit's process-group supervisor.
 *
 * Interruption terminates the complete detached process group through the
 * existing RouteKit policy; it does not rely on a generic child finalizer.
 */
export function superviseSpawnEffect(
  command: string,
  args: readonly string[],
  options: EffectSpawnOptions = {}
): Effect.Effect<ExitInfo, unknown> {
  return Effect.callback((resume, interruptionSignal) => {
    const spawned = superviseSpawn(command, args, {
      ...options,
      signal: interruptionSignal
    });
    spawned.done.then(
      (info) => resume(Effect.succeed(info)),
      (cause) => resume(Effect.fail(cause))
    );
    return Effect.sync(() => spawned.kill());
  });
}
