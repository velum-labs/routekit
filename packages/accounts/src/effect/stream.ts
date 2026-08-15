import { routeKitError, withAbortSignal } from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";

import { readBoundedSubscriptionBody } from "../subscription-stream.js";

/**
 * Read a bounded provider body while tying lease release to the Effect scope.
 *
 * The existing decoder and buffer cap stay on `readBoundedSubscriptionBody`.
 * Interruption, AbortSignal abort, and success all release exactly once.
 */
export function readBoundedSubscriptionBodyEffect(
  body: ReadableStream<Uint8Array>,
  release: () => void,
  signal?: AbortSignal
): Effect.Effect<Uint8Array, Error> {
  return Effect.scoped(
    Effect.gen(function* () {
      let released = false;
      const releaseOnce = (): void => {
        if (released) return;
        released = true;
        release();
      };
      yield* Effect.acquireRelease(Effect.void, () => Effect.sync(releaseOnce));
      return yield* withAbortSignal(
        Effect.callback<Uint8Array, Error>((resume, interruptionSignal) => {
          const controller = new AbortController();
          const abort = (): void => {
            controller.abort(signal?.reason ?? interruptionSignal.reason);
          };
          if (signal?.aborted === true || interruptionSignal.aborted) abort();
          else {
            signal?.addEventListener("abort", abort, { once: true });
            interruptionSignal.addEventListener("abort", abort, { once: true });
          }
          void readBoundedSubscriptionBody(body, releaseOnce, controller.signal).then(
            (bytes) => resume(Effect.succeed(bytes)),
            (cause) => resume(Effect.fail(routeKitError(cause)))
          );
          return Effect.sync(() => {
            signal?.removeEventListener("abort", abort);
            if (!controller.signal.aborted) controller.abort();
          });
        }),
        signal
      );
    })
  );
}
