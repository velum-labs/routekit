import type { Schema } from "effect";

import { Deferred, Effect, Queue, Ref, Stream } from "effect";

import type {
  ConnectionState,
  Enqueue,
  OfferCancellation,
  OutboundItem,
  Terminate,
} from "./internal.ts";
import type { AcpConnectionError } from "../errors.ts";
import type { AcpTransportShape } from "../transport.ts";

import { settleAcknowledgement } from "./acknowledgement.ts";
import { transportError } from "./protocol.ts";
import {
  AcpConnectionClosedError,
  AcpOutboundCapacityError,
} from "../errors.ts";

const removeAcknowledgement = (
  state: Ref.Ref<ConnectionState>,
  acknowledgement: Deferred.Deferred<true, AcpConnectionError>
): Effect.Effect<void> =>
  Ref.update(state, (current) => {
    const next = new Set(current.outboundAcknowledgements);
    next.delete(acknowledgement);
    return {
      ...current,
      outboundAcknowledgements: next,
    };
  });

export const makeEnqueue = (
  outbound: Queue.Queue<OutboundItem>,
  state: Ref.Ref<ConnectionState>
): Enqueue =>
  Effect.fn("AcpConnection.enqueue")((message: Schema.Json) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const acknowledgement = yield* Deferred.make<
          true,
          AcpConnectionError
        >();
        const accepted = yield* restore(
          Queue.offer(outbound, {
            acknowledgement,
            message,
          })
        );
        if (!accepted) {
          return yield* new AcpConnectionClosedError({
            reason: "outbound queue closed",
          });
        }
        const closed = yield* Ref.modify(state, (current) =>
          current.closed === undefined
            ? ([
                undefined,
                {
                  ...current,
                  outboundAcknowledgements: new Set([
                    ...current.outboundAcknowledgements,
                    acknowledgement,
                  ]),
                },
              ] as const)
            : ([current.closed, current] as const)
        );
        if (closed !== undefined) {
          return yield* closed;
        }
        return yield* restore(Deferred.await(acknowledgement)).pipe(
          Effect.ensuring(removeAcknowledgement(state, acknowledgement))
        );
      })
    )
  );

export const makeCancellationOffer = (
  outbound: Queue.Queue<OutboundItem>,
  capacity: number
): OfferCancellation =>
  Effect.fn("AcpConnection.offerCancellation")((message: Schema.Json) =>
    Effect.sync(() => Queue.offerUnsafe(outbound, { message })).pipe(
      Effect.flatMap(
        (accepted): Effect.Effect<void, AcpConnectionError> =>
          accepted ? Effect.void : new AcpOutboundCapacityError({ capacity })
      )
    )
  );

export const makeWriter = (
  outbound: Queue.Queue<OutboundItem>,
  transport: AcpTransportShape,
  terminate: Terminate
): Effect.Effect<void> =>
  Stream.fromQueue(outbound).pipe(
    Stream.runForEach((item) =>
      settleAcknowledgement(
        transport
          .send(item.message)
          .pipe(Effect.mapError((cause) => transportError("send", cause))),
        item,
        terminate
      )
    )
  );
