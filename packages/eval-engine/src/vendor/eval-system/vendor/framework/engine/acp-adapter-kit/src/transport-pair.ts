import type { Schema } from "effect";

import { Deferred, Effect, Queue, Ref, Stream } from "effect";

import type { AcpTransportShape } from "../../acp-client/src/transport.ts";

const ACP_WIRE_CAPACITY = 64;

/**
 * The two ends of an in-memory ACP wire plus their shared lifecycle. The `agent`
 * end is bound to the `AcpTransport` tag inside the adapter's connection graph;
 * the `client` end is handed back to whoever drives the peer.
 */
export interface AcpTransportPair {
  readonly agent: AcpTransportShape;
  readonly client: AcpTransportShape;
  readonly close: Effect.Effect<void>;
}

/**
 * A bounded, bidirectional ACP transport pair: each end's `send` offers onto the
 * other end's incoming queue, and one shared `close` shuts both queues down and
 * settles the exit deferred.
 *
 * `close` is idempotent by construction — the `getAndSet` on `closed` admits
 * exactly one caller — because both ends expose it and an adapter's terminate
 * path can race its own transport teardown.
 */
export const makeAcpTransportPair = Effect.gen(function* () {
  const clientIncoming = yield* Queue.bounded<unknown>(ACP_WIRE_CAPACITY);
  const agentIncoming = yield* Queue.bounded<unknown>(ACP_WIRE_CAPACITY);
  const exited = yield* Deferred.make<{ readonly code?: number }>();
  const closed = yield* Ref.make(false);
  const close = Ref.getAndSet(closed, true).pipe(
    Effect.flatMap((wasClosed) =>
      wasClosed
        ? Effect.void
        : Queue.shutdown(clientIncoming).pipe(
            Effect.andThen(Queue.shutdown(agentIncoming)),
            Effect.andThen(Deferred.succeed(exited, { code: 0 })),
            Effect.asVoid
          )
    )
  );
  return {
    agent: {
      close,
      exit: Deferred.await(exited),
      incoming: Stream.fromQueue(agentIncoming),
      send: (message: Schema.Json): Effect.Effect<void> =>
        Queue.offer(clientIncoming, message).pipe(Effect.asVoid),
    },
    client: {
      close,
      exit: Deferred.await(exited),
      incoming: Stream.fromQueue(clientIncoming),
      send: (message: Schema.Json): Effect.Effect<void> =>
        Queue.offer(agentIncoming, message).pipe(Effect.asVoid),
    },
    close,
  } satisfies AcpTransportPair;
});
