import { Effect, Schema, Stream } from "effect";

import { SelectedAdapterError } from "./inventory.ts";

interface InvalidationResources<Key> {
  readonly invalidate: (key: Key) => Effect.Effect<void>;
}

/**
 * Generic in the error channel so a stream that can also fail on ownership
 * persistence keeps that failure typed. Only a peer exit invalidates; every
 * other failure, including a wider one, passes through untouched.
 */
const invalidateOnPeerExit =
  <Output, Key, E>(params: {
    readonly key: Key;
    readonly resources: InvalidationResources<Key>;
  }) =>
  (stream: Stream.Stream<Output, E>): Stream.Stream<Output, E> =>
    stream.pipe(
      Stream.catchIf(
        (error): error is E & SelectedAdapterError =>
          Schema.is(SelectedAdapterError)(error) &&
          error.reason === "peer-exit",
        (error): Stream.Stream<never, E> =>
          Stream.unwrap(
            params.resources
              .invalidate(params.key)
              .pipe(
                Effect.flatMap(
                  (): Effect.Effect<never, E> => Effect.fail(error)
                )
              )
          )
      )
    );

export { invalidateOnPeerExit };
