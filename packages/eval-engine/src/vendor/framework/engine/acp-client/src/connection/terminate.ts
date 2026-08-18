import { Deferred, Effect, Option, Queue, Ref } from "effect";

import type {
  ConnectionResources,
  ConnectionState,
  PendingRequest,
  Terminate,
} from "./internal.ts";
import type { AcpConnectionError } from "../errors.ts";

interface TerminationWork {
  readonly acknowledgements: readonly Deferred.Deferred<
    true,
    AcpConnectionError
  >[];
  readonly activeInbound: readonly Deferred.Deferred<true>[];
  readonly pending: readonly PendingRequest[];
}

export const makeTerminate = (resources: ConnectionResources): Terminate =>
  Effect.fn("AcpConnection.terminate")((error: AcpConnectionError) =>
    Effect.uninterruptible(
      Ref.modify<ConnectionState, Option.Option<TerminationWork>>(
        resources.state,
        (current) => {
          if (current.closed !== undefined) {
            return [Option.none(), current] as const;
          }
          return [
            Option.some({
              activeInbound: [...current.activeInbound.values()],
              acknowledgements: [...current.outboundAcknowledgements],
              pending: [...current.pending.values()],
            }),
            {
              ...current,
              activeInbound: new Map(),
              closed: error,
              outboundAcknowledgements: new Set(),
              pending: new Map(),
            },
          ] as const;
        }
      ).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: ({ acknowledgements, activeInbound, pending }) =>
              Ref.set(resources.initialization, {
                error,
                type: "closed",
              }).pipe(
                Effect.andThen(Queue.clear(resources.outbound)),
                Effect.andThen(
                  Effect.all([
                    ...pending.map(({ deferred }) =>
                      Deferred.fail(deferred, error)
                    ),
                    ...activeInbound.map((cancel) =>
                      Deferred.succeed(cancel, true)
                    ),
                    ...acknowledgements.map((acknowledgement) =>
                      Deferred.fail(acknowledgement, error)
                    ),
                  ])
                ),
                Effect.andThen(Queue.shutdown(resources.outbound)),
                Effect.andThen(Queue.shutdown(resources.inboundRequests)),
                Effect.andThen(Deferred.succeed(resources.closed, error)),
                Effect.andThen(Deferred.succeed(resources.stop, true)),
                Effect.andThen(
                  resources.transport.close.pipe(
                    Effect.timeout("1 second"),
                    Effect.ignore
                  )
                ),
                Effect.asVoid
              ),
          })
        )
      )
    )
  );
