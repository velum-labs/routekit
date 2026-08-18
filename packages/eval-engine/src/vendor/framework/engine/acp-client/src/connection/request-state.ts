import { Deferred, Effect, Ref, Schema } from "effect";

import type {
  ConnectionConfig,
  ConnectionState,
  Enqueue,
  OfferCancellation,
  PendingRequest,
  Terminate,
} from "./internal.ts";
import type { AcpRequestId } from "../../../../contracts/internal/src/acp/protocol/profile.ts";
import type { AcpConnectionError } from "../errors.ts";
import type {
  AcpClientRequestMethod,
  AcpClientRequestParams,
  AcpClientRequestResult,
} from "../service.ts";

import {
  CANCEL_REQUEST_METHOD,
  encodeClientMessage,
  protocolError,
  REQUEST_CANCELLED_CODE,
} from "./protocol.ts";
import { decodeAcpResponseForMethod } from "../../../../contracts/internal/src/acp/codec/codec.ts";
import {
  AcpMessageKind,
  AcpRequestDirection,
} from "../../../../contracts/internal/src/acp/protocol/message-kinds.ts";
import { CLIENT_RESULT_SCHEMAS } from "../../../../contracts/internal/src/acp/protocol/profile.ts";
import {
  AcpDuplicateResponseIdError,
  AcpPendingRequestCapacityError,
  AcpProtocolError,
  AcpRemoteError,
  AcpRequestCancelledError,
  AcpUnknownResponseIdError,
} from "../errors.ts";

type ResponseReservation =
  | { readonly pending: PendingRequest; readonly type: "pending" }
  | { readonly type: "cancelled" }
  | { readonly error: AcpConnectionError; readonly type: "error" };
type RequestReservation =
  | { readonly id: number; readonly type: "reserved" }
  | { readonly error: AcpConnectionError; readonly type: "error" };

export type AcpRawRequest = <M extends AcpClientRequestMethod>(
  method: M,
  params: AcpClientRequestParams<M>
) => Effect.Effect<AcpClientRequestResult<M>, AcpConnectionError>;

const reserveResponse = (
  state: Ref.Ref<ConnectionState>,
  id: AcpRequestId
): Effect.Effect<ResponseReservation> =>
  Ref.modify<ConnectionState, ResponseReservation>(state, (current) => {
    if (typeof id !== "number") {
      return [
        {
          error: new AcpUnknownResponseIdError({ id }),
          type: "error",
        },
        current,
      ] as const;
    }
    const pending = current.pending.get(id);
    if (pending !== undefined) {
      const next = new Map(current.pending);
      next.delete(id);
      return [
        {
          pending,
          type: "pending",
        },
        {
          ...current,
          pending: next,
        },
      ] as const;
    }
    if (current.cancelled.has(id)) {
      const cancelled = new Set(current.cancelled);
      cancelled.delete(id);
      return [
        { type: "cancelled" },
        {
          ...current,
          cancelled,
        },
      ] as const;
    }
    const error =
      id < current.nextId
        ? new AcpDuplicateResponseIdError({ id })
        : new AcpUnknownResponseIdError({ id });
    return [
      {
        error,
        type: "error",
      },
      current,
    ] as const;
  });

const completePending = (
  pending: PendingRequest,
  input: unknown,
  terminate: Terminate
): Effect.Effect<void> =>
  decodeAcpResponseForMethod(pending.context, input).pipe(
    Effect.mapError(protocolError),
    Effect.matchEffect({
      onFailure: (error) =>
        Deferred.fail(pending.deferred, error).pipe(
          Effect.andThen(terminate(error))
        ),
      onSuccess: (response) =>
        response.kind === AcpMessageKind.ErrorResponse
          ? Deferred.fail(
              pending.deferred,
              response.error.code === REQUEST_CANCELLED_CODE
                ? new AcpRequestCancelledError({
                    id: response.id,
                    message: response.error.message,
                  })
                : new AcpRemoteError({
                    code: response.error.code,
                    message: response.error.message,
                  })
            )
          : Deferred.succeed(pending.deferred, response.result),
    }),
    Effect.asVoid
  );

export const makeCompleteResponse = ({
  state,
  terminate,
}: {
  readonly state: Ref.Ref<ConnectionState>;
  readonly terminate: Terminate;
}): ((id: AcpRequestId, input: unknown) => Effect.Effect<void>) =>
  Effect.fn("AcpConnection.completeResponse")(
    (id: AcpRequestId, input: unknown) =>
      reserveResponse(state, id).pipe(
        Effect.flatMap((reservation) => {
          switch (reservation.type) {
            case "cancelled": {
              return Effect.void;
            }
            case "error": {
              return terminate(reservation.error);
            }
            case "pending": {
              return completePending(reservation.pending, input, terminate);
            }
            default: {
              return reservation satisfies never;
            }
          }
        })
      )
  );

const cancelOutbound = ({
  config,
  id,
  offerCancellation,
  state,
}: {
  readonly config: ConnectionConfig;
  readonly id: number;
  readonly offerCancellation: OfferCancellation;
  readonly state: Ref.Ref<ConnectionState>;
}): Effect.Effect<void, AcpConnectionError> =>
  Ref.modify(state, (current) => {
    if (!current.pending.has(id)) {
      return [false, current] as const;
    }
    const pending = new Map(current.pending);
    pending.delete(id);
    const oldest = current.nextId - config.cancellationRetention;
    return [
      true,
      {
        ...current,
        cancelled: new Set(
          [...current.cancelled, id].filter((value) => value >= oldest)
        ),
        pending,
      },
    ] as const;
  }).pipe(
    Effect.flatMap((cancel) =>
      cancel
        ? encodeClientMessage({
            jsonrpc: "2.0",
            method: CANCEL_REQUEST_METHOD,
            params: { requestId: id },
          }).pipe(Effect.flatMap(offerCancellation))
        : Effect.void
    )
  );

const reserveRequest = ({
  config,
  deferred,
  method,
  state,
}: {
  readonly config: ConnectionConfig;
  readonly deferred: Deferred.Deferred<unknown, AcpConnectionError>;
  readonly method: AcpClientRequestMethod;
  readonly state: Ref.Ref<ConnectionState>;
}): Effect.Effect<RequestReservation> =>
  Ref.modify<ConnectionState, RequestReservation>(state, (current) => {
    if (current.closed !== undefined) {
      return [
        {
          error: current.closed,
          type: "error",
        },
        current,
      ] as const;
    }
    if (current.pending.size >= config.pendingRequestCapacity) {
      return [
        {
          error: new AcpPendingRequestCapacityError({
            capacity: config.pendingRequestCapacity,
          }),
          type: "error",
        },
        current,
      ] as const;
    }
    const id = current.nextId;
    const nextId = id + 1;
    const oldestCancellation = nextId - config.cancellationRetention;
    return [
      {
        id,
        type: "reserved",
      },
      {
        ...current,
        cancelled: new Set(
          [...current.cancelled].filter(
            (cancelledId) => cancelledId >= oldestCancellation
          )
        ),
        nextId,
        pending: new Map([
          ...current.pending,
          [
            id,
            {
              context: {
                direction: AcpRequestDirection.ClientToAgent,
                id,
                method,
              },
              deferred,
            },
          ],
        ]),
      },
    ] as const;
  });

const isResult = <M extends AcpClientRequestMethod>(
  method: M,
  value: unknown
): value is AcpClientRequestResult<M> =>
  Schema.is(CLIENT_RESULT_SCHEMAS[method])(value);

const removePending = (
  state: Ref.Ref<ConnectionState>,
  id: number
): Effect.Effect<void> =>
  Ref.update(state, (current) => {
    if (!current.pending.has(id)) {
      return current;
    }
    const pending = new Map(current.pending);
    pending.delete(id);
    return {
      ...current,
      pending,
    };
  });

// Encode + enqueue the request, then await its reserved deferred. On
// interruption the reservation's cancellation is offered; on any failure the
// pending slot is released. Runs inside the caller's `restore` so the await is
// interruptible while enqueue/cleanup stay masked.
const sendAndAwait = <M extends AcpClientRequestMethod>({
  config,
  enqueue,
  id,
  deferred,
  method,
  offerCancellation,
  params,
  restore,
  state,
  terminate,
}: {
  readonly config: ConnectionConfig;
  readonly enqueue: Enqueue;
  readonly id: number;
  readonly deferred: Deferred.Deferred<unknown, AcpConnectionError>;
  readonly method: M;
  readonly offerCancellation: OfferCancellation;
  readonly params: AcpClientRequestParams<M>;
  readonly restore: <A, E, R>(
    effect: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E, R>;
  readonly state: Ref.Ref<ConnectionState>;
  readonly terminate: Terminate;
}): Effect.Effect<unknown, AcpConnectionError> =>
  encodeClientMessage({
    id,
    jsonrpc: "2.0",
    method,
    params,
  }).pipe(
    Effect.flatMap((wire) =>
      restore(
        enqueue(wire).pipe(Effect.andThen(Deferred.await(deferred)))
      ).pipe(
        Effect.onInterrupt(() =>
          cancelOutbound({
            config,
            id,
            offerCancellation,
            state,
          }).pipe(Effect.catch(terminate))
        )
      )
    ),
    Effect.onError(() => removePending(state, id))
  );

export const makeRequest = ({
  config,
  enqueue,
  offerCancellation,
  state,
  terminate,
}: {
  readonly config: ConnectionConfig;
  readonly enqueue: Enqueue;
  readonly offerCancellation: OfferCancellation;
  readonly state: Ref.Ref<ConnectionState>;
  readonly terminate: Terminate;
}): AcpRawRequest =>
  Effect.fn("AcpConnection.request")(
    <M extends AcpClientRequestMethod>(
      method: M,
      params: AcpClientRequestParams<M>
    ) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const deferred = yield* Deferred.make<unknown, AcpConnectionError>();
          const reservation = yield* reserveRequest({
            config,
            deferred,
            method,
            state,
          });
          if (reservation.type === "error") {
            return yield* reservation.error;
          }
          const value = yield* sendAndAwait({
            config,
            deferred,
            enqueue,
            id: reservation.id,
            method,
            offerCancellation,
            params,
            restore,
            state,
            terminate,
          });
          // `completeResponse` already decoded this value once, through the
          // stored per-request context, before fulfilling the deferred; we must
          // not decode it a second time (that would re-run a non-identity result
          // transform on an already-decoded value). The deferred is existentially
          // `unknown` only because the pending map is heterogeneous over methods,
          // so narrow it back with a runtime guard instead of an assertion. A
          // mismatch is an internal invariant break, not remote input.
          return isResult(method, value)
            ? value
            : yield* new AcpProtocolError({ reason: "UncorrelatedResult" });
        })
      )
  );
