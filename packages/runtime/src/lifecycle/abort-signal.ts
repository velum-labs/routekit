import { Effect } from "effect";

/**
 * Run an Effect with an external AbortSignal.
 *
 * The signal interrupts only this run. Shared work should be forked into a
 * longer-lived scope before calling this adapter.
 */
export function withAbortSignal<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  signal?: AbortSignal
): Effect.Effect<A, E, R> {
  if (signal === undefined) return effect;
  return Effect.raceFirst(
    effect,
    Effect.callback<never>((resume, interruptionSignal) => {
      const abort = (): void => resume(Effect.interrupt);
      signal.addEventListener("abort", abort, { once: true });
      interruptionSignal.addEventListener(
        "abort",
        () => signal.removeEventListener("abort", abort),
        { once: true }
      );
      if (signal.aborted) abort();
      return Effect.sync(() => signal.removeEventListener("abort", abort));
    })
  );
}
