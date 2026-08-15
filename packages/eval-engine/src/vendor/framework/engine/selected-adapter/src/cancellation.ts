import { Effect, Ref, Stream } from "effect";

import type { SelectedAdapterEvent } from "./inventory.ts";

const interruptOnCancel = <A, E>(
  updates: Stream.Stream<A, E>,
  cancellation: {
    readonly signal: Effect.Effect<unknown> | undefined;
    readonly state: Ref.Ref<boolean> | undefined;
  },
  cancel: Effect.Effect<void>
): Stream.Stream<A, E> =>
  cancellation.signal === undefined
    ? updates
    : updates.pipe(
        Stream.interruptWhen(cancellation.signal),
        Stream.ensuring(
          Effect.uninterruptible(
            Effect.gen(function* () {
              if (
                cancellation.state !== undefined &&
                (yield* Ref.get(cancellation.state))
              ) {
                yield* cancel;
              }
            })
          )
        )
      );

const toSessionUpdate = <T>(
  update: T
): { readonly type: "session-update"; readonly update: T } => ({
  type: "session-update",
  update,
});

const isRuntimeEvent = (
  event: SelectedAdapterEvent
): event is Extract<SelectedAdapterEvent, { readonly type: "runtime-event" }> =>
  "type" in event && event.type === "runtime-event";

export { interruptOnCancel, isRuntimeEvent, toSessionUpdate };
