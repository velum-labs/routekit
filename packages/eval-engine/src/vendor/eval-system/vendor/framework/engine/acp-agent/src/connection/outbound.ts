/* oxlint-disable typescript/explicit-function-return-type -- preserve Effect inference */
/* oxlint-disable eslint/max-params -- writer dependencies are explicit connection resources */
import type { Schema } from "effect";

import { Deferred, Effect, Option, Queue, Ref } from "effect";

import type { ConnectionState, OutboundItem } from "./internal.ts";
import type { AcpAgentConnectionError } from "../errors.ts";
import type { AcpTransportFault } from "../../../acp-client/src/transport.ts";

import {
  AcpAgentConnectionClosedError,
  AcpAgentOutboundCapacityError,
  AcpAgentTransportError,
} from "../errors.ts";
import { settleAcknowledgement } from "../../../acp-client/src/connection/acknowledgement.ts";

export type Enqueue = (
  message: Schema.Json,
  onAccepted?: Effect.Effect<void>
) => Effect.Effect<void, AcpAgentConnectionError>;

const removeAcknowledgement = (
  state: Ref.Ref<ConnectionState>,
  acknowledgement: Deferred.Deferred<true, AcpAgentConnectionError>
) =>
  Ref.update(state, (current) => {
    const acknowledgements = new Set(current.outboundAcknowledgements);
    acknowledgements.delete(acknowledgement);
    return {
      ...current,
      outboundAcknowledgements: acknowledgements,
    };
  });

export const makeEnqueue = (
  outbound: Queue.Queue<OutboundItem>,
  state: Ref.Ref<ConnectionState>
): Enqueue =>
  Effect.fn("AcpAgentConnection.enqueue")(
    (message: Schema.Json, onAccepted?: Effect.Effect<void>) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const acknowledgement = yield* Deferred.make<
            true,
            AcpAgentConnectionError
          >();
          const closed = yield* Ref.modify(state, (current) =>
            current.closed === undefined
              ? [
                  undefined,
                  {
                    ...current,
                    outboundAcknowledgements: new Set([
                      ...current.outboundAcknowledgements,
                      acknowledgement,
                    ]),
                  },
                ]
              : [current.closed, current]
          );
          if (closed !== undefined) {
            return yield* closed;
          }
          return yield* Effect.gen(function* () {
            const accepted = yield* restore(
              Queue.offer(outbound, {
                acknowledgement,
                message,
              })
            );
            if (!accepted) {
              return yield* new AcpAgentConnectionClosedError({
                reason: "outbound queue closed",
              });
            }
            yield* onAccepted ?? Effect.void;
            return yield* restore(Deferred.await(acknowledgement));
          }).pipe(
            Effect.ensuring(removeAcknowledgement(state, acknowledgement))
          );
        })
      )
  );

export const makeCancellationOffer =
  (outbound: Queue.Queue<OutboundItem>, capacity: number): Enqueue =>
  (message) =>
    Queue.offer(outbound, { message }).pipe(
      Effect.flatMap((accepted) =>
        accepted ? Effect.void : new AcpAgentOutboundCapacityError({ capacity })
      )
    );

export const makeWriter = (
  outbound: Queue.Queue<OutboundItem>,
  cancellationOutbound: Queue.Queue<OutboundItem>,
  send: (message: Schema.Json) => Effect.Effect<void, AcpTransportFault>,
  terminate: (error: AcpAgentConnectionError) => Effect.Effect<void>
) =>
  Effect.forever(
    Queue.poll(cancellationOutbound).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.raceFirst(
              Queue.take(cancellationOutbound),
              Queue.take(outbound)
            ),
          onSome: Effect.succeed,
        })
      ),
      Effect.flatMap((item) =>
        settleAcknowledgement(
          send(item.message).pipe(
            Effect.mapError(
              () => new AcpAgentTransportError({ operation: "send" })
            )
          ),
          item,
          terminate
        )
      )
    )
  );
