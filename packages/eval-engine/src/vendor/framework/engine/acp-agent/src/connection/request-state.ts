/* oxlint-disable typescript/explicit-function-return-type -- preserve Effect inference */
/* oxlint-disable typescript/no-unsafe-type-assertion -- codec overloads lose method correlation */
/* oxlint-disable eslint/max-lines-per-function, eslint/max-params -- request reservation and interruption cleanup are atomic */
import { Deferred, Effect, Ref } from "effect";

import type {
  AcpDecodedResponseEnvelope,
  ConnectionConfig,
  ConnectionResources,
  ConnectionState,
  PendingRequest,
} from "./internal.ts";
import type { Enqueue } from "./outbound.ts";
import type { AcpDecodedAgentPeerMessage } from "../../../../contracts/internal/src/acp/codec/codec.ts";
import type { AcpAgentConnectionError } from "../errors.ts";
import type {
  AcpAgentConnectionShape,
  AcpAgentRequestMethod,
  AcpAgentRequestResult,
} from "../service.ts";

import { makeCancellationOffer } from "./outbound.ts";
import {
  protocolFailure,
  REQUEST_CANCELLED,
  requireInitialized,
} from "./protocol.ts";
import {
  decodeAcpResponseForMethod,
  encodeAcpPeerMessage,
} from "../../../../contracts/internal/src/acp/codec/codec.ts";
import {
  AcpAgentPendingCapacityError,
  AcpAgentRemoteError,
  AcpAgentRequestCancelledError,
} from "../errors.ts";

export const makeCompleteResponse =
  (
    state: Ref.Ref<ConnectionState>,
    terminate: (error: AcpAgentConnectionError) => Effect.Effect<void>
  ) =>
  (envelope: AcpDecodedResponseEnvelope, input: unknown) =>
    Effect.gen(function* () {
      const { id } = envelope;
      if (typeof id !== "number") {
        return yield* protocolFailure();
      }
      const pending = yield* Ref.modify(state, (current) => {
        const found = current.pending.get(id);
        if (found === undefined) {
          if (!current.cancelled.has(id)) {
            return [undefined, current] as const;
          }
          const cancelled = new Set(current.cancelled);
          cancelled.delete(id);
          return [
            null,
            {
              ...current,
              cancelled,
            },
          ] as const;
        }
        const next = new Map(current.pending);
        next.delete(id);
        return [
          found,
          {
            ...current,
            pending: next,
          },
        ] as const;
      });
      if (pending === null) {
        return;
      }
      if (pending === undefined) {
        return yield* protocolFailure();
      }
      yield* decodeAcpResponseForMethod(pending.context, input).pipe(
        Effect.mapError(() => protocolFailure()),
        Effect.matchEffect({
          onFailure: (error) =>
            Deferred.fail(pending.deferred, error).pipe(
              Effect.andThen(terminate(error))
            ),
          onSuccess: (response) =>
            response.kind === "errorResponse"
              ? Deferred.fail(
                  pending.deferred,
                  response.error.code === REQUEST_CANCELLED
                    ? new AcpAgentRequestCancelledError()
                    : new AcpAgentRemoteError({
                        code: response.error.code,
                        message: "remote request failed",
                      })
                )
              : Deferred.succeed(pending.deferred, response.result),
        })
      );
    });

const reserveRequest = (
  state: Ref.Ref<ConnectionState>,
  config: ConnectionConfig,
  pending: Omit<PendingRequest, "context">,
  method: AcpAgentRequestMethod
) =>
  Ref.modify<
    ConnectionState,
    { readonly error: AcpAgentConnectionError } | { readonly id: number }
  >(state, (current) => {
    if (current.closed !== undefined) {
      return [{ error: current.closed }, current] as const;
    }
    if (current.pending.size >= config.pendingRequestCapacity) {
      return [
        {
          error: new AcpAgentPendingCapacityError({
            capacity: config.pendingRequestCapacity,
          }),
        },
        current,
      ] as const;
    }
    const id = current.nextId;
    const oldest = id + 1 - config.cancellationRetention;
    return [
      { id },
      {
        ...current,
        cancelled: new Set(
          [...current.cancelled].filter((item) => item >= oldest)
        ),
        nextId: id + 1,
        pending: new Map([
          ...current.pending,
          [
            id,
            {
              ...pending,
              context: {
                direction: "agentToClient",
                id,
                method,
              },
            },
          ],
        ]),
      },
    ] as const;
  });

const removePending = (
  state: Ref.Ref<ConnectionState>,
  id: number,
  retainCancellation: boolean,
  retention: number
) =>
  Ref.update(state, (current) => {
    const pending = new Map(current.pending);
    pending.delete(id);
    return {
      ...current,
      cancelled: retainCancellation
        ? new Set(
            [...current.cancelled, id].filter(
              (item) => item >= current.nextId - retention
            )
          )
        : current.cancelled,
      pending,
    };
  });

export const makeRequest =
  (
    resources: ConnectionResources,
    config: ConnectionConfig,
    enqueue: Enqueue
  ): AcpAgentConnectionShape["request"] =>
  (method, params) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        yield* requireInitialized(resources.state);
        const deferred = yield* Deferred.make<
          unknown,
          AcpAgentConnectionError
        >();
        const reservation = yield* reserveRequest(
          resources.state,
          config,
          { deferred },
          method
        );
        if ("error" in reservation) {
          return yield* reservation.error;
        }
        const accepted = yield* Ref.make(false);
        const send = encodeAcpPeerMessage("agent", {
          id: reservation.id,
          jsonrpc: "2.0",
          kind: "request",
          method,
          params,
          supported: true,
        } as AcpDecodedAgentPeerMessage).pipe(
          Effect.mapError(() => protocolFailure()),
          Effect.flatMap((message) =>
            enqueue(message, Ref.set(accepted, true))
          ),
          Effect.tapError(() =>
            removePending(
              resources.state,
              reservation.id,
              false,
              config.cancellationRetention
            )
          )
        );
        return (yield* restore(
          send.pipe(Effect.andThen(Deferred.await(deferred)))
        ).pipe(
          Effect.onInterrupt(() =>
            Ref.get(accepted).pipe(
              Effect.flatMap((wasAccepted) =>
                removePending(
                  resources.state,
                  reservation.id,
                  wasAccepted,
                  config.cancellationRetention
                ).pipe(
                  Effect.andThen(
                    wasAccepted
                      ? encodeAcpPeerMessage("agent", {
                          jsonrpc: "2.0",
                          kind: "notification",
                          method: "$/cancel_request",
                          params: { requestId: reservation.id },
                          supported: true,
                        }).pipe(
                          Effect.mapError(() => protocolFailure()),
                          Effect.flatMap(
                            makeCancellationOffer(
                              resources.cancellationOutbound,
                              config.pendingRequestCapacity +
                                config.outboundCapacity
                            )
                          ),
                          Effect.ignore
                        )
                      : Effect.void
                  )
                )
              )
            )
          )
        )) as AcpAgentRequestResult<typeof method>;
      })
    );
