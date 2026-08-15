import { Deferred, Effect } from "effect";

/**
 * How an outbound ACP frame's write is reported back to whoever enqueued it.
 *
 * Both sides of the connection — the client half and the agent half — settle a
 * write the same way, because it is one wire contract rather than two: a frame
 * that failed to send fails its waiter *and* tears the connection down (a
 * half-written JSON-RPC stream cannot be recovered from), while a frame that
 * went out resolves its waiter and leaves the connection alone. An item with no
 * acknowledgement is fire-and-forget, so a failure only terminates.
 *
 * The two writers are otherwise unrelated — one races a cancellation queue
 * under `Effect.forever`, the other drains a single queue as a stream — so this
 * is deliberately just the settle step, generic over each half's own error
 * type.
 */
export const settleAcknowledgement = <E>(
  write: Effect.Effect<unknown, E>,
  item: { readonly acknowledgement?: Deferred.Deferred<true, E> },
  terminate: (error: E) => Effect.Effect<void>
): Effect.Effect<void> =>
  write.pipe(
    Effect.matchEffect({
      onFailure: (error) =>
        item.acknowledgement === undefined
          ? terminate(error)
          : Deferred.fail(item.acknowledgement, error).pipe(
              Effect.andThen(terminate(error))
            ),
      onSuccess: () =>
        item.acknowledgement === undefined
          ? Effect.void
          : Deferred.succeed(item.acknowledgement, true),
    }),
    Effect.asVoid
  );
