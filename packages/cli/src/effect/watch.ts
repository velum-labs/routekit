import type { LiveFrameContent, Presenter } from "@velum-labs/routekit-cli-ui";
import { Cause, Effect, Exit } from "effect";

export type WatchEffectOptions = {
  errorFrame?: (error: unknown) => LiveFrameContent;
};

/** Poll one Effect on a single fiber until SIGINT interrupts the live frame. */
export function watchEffect<E, R>(
  presenter: Presenter,
  intervalSeconds: number,
  render: Effect.Effect<LiveFrameContent, E, R>,
  options: WatchEffectOptions = {}
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const frame = presenter.liveFrame();
      yield* Effect.addFinalizer(() => Effect.sync(() => frame.stop()));

      const stop = Effect.callback<void>((resume) => {
        const onSigint = (): void => resume(Effect.void);
        process.once("SIGINT", onSigint);
        return Effect.sync(() => process.removeListener("SIGINT", onSigint));
      });
      const tick = Effect.gen(function* () {
        const exit = yield* Effect.exit(render);
        if (Exit.isSuccess(exit)) {
          frame.render(exit.value);
        } else {
          const error = Cause.squash(exit.cause);
          const content = options.errorFrame?.(error) ?? [
            `error: ${error instanceof Error ? error.message : String(error)}`,
            `retrying in ${intervalSeconds}s`
          ];
          if (frame.renderError !== undefined) frame.renderError(content);
          else frame.render(content);
        }
        yield* Effect.sleep(`${Math.max(0.1, intervalSeconds)} seconds`);
      });
      yield* Effect.raceFirst(Effect.forever(tick), stop);
    })
  );
}
