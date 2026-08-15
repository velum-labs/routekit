/* oxlint-disable typescript/explicit-function-return-type -- preserve Effect inference */
/* oxlint-disable eslint/max-lines-per-function, eslint/max-params -- inbound handling keeps admission and cleanup together */
import { Deferred, Effect, Queue, Ref, Result } from "effect";

import type {
  AcpDecodedResponseEnvelope,
  ConnectionResources,
  ConnectionState,
  InboundWork,
} from "./internal.ts";
import type { Enqueue } from "./outbound.ts";
import type {
  AcpClientKnownRequest,
  AcpRequestId,
} from "../../../../contracts/internal/src/acp/protocol/profile.ts";
import type { AcpAgentConnectionError } from "../errors.ts";
import type {
  AcpClientRequestFailure,
  AcpClientRequestHandlerShape,
} from "../service.ts";

import {
  INTERNAL_ERROR,
  METHOD_NOT_FOUND,
  protocolFailure,
  REQUEST_CANCELLED,
} from "./protocol.ts";
import {
  decodeAcpEnvelope,
  decodeAcpPeerMessage,
  encodeAcpResponseForMethod,
} from "../../../../contracts/internal/src/acp/codec/codec.ts";

const errorResponse = (id: AcpRequestId, code: number, message: string) => ({
  error: {
    code,
    message,
  },
  id,
  jsonrpc: "2.0" as const,
});
const admitInbound = Effect.fn("admitInbound")(function* (
  resources: ConnectionResources,
  request: AcpClientKnownRequest
) {
  const cancel = yield* Deferred.make<true>();
  const admitted = yield* Ref.modify(resources.state, (current) => {
    if (current.active.has(request.id)) {
      return [false, current] as const;
    }
    return [
      true,
      {
        ...current,
        active: new Map([...current.active, [request.id, { cancel }]]),
      },
    ] as const;
  });
  if (!admitted) {
    return yield* protocolFailure("DuplicateInboundRequestId");
  }
  // Fatal on capacity by design. A client that outruns the inbound workers past
  // `inboundRequestCapacity` is treated as a protocol/DoS fault: the connection
  // is torn down (this failure reaches the inbound stream's `onFailure:
  // terminate` in connection.ts) rather than silently buffering unbounded work.
  // Teardown discards connection state, so the `active` slot reserved above needs
  // no separate cleanup on this path. Do not soften this to a per-request reject
  // without re-deciding the backpressure contract.
  if (
    !Queue.offerUnsafe(resources.inboundRequests, {
      cancel,
      request,
    })
  ) {
    return yield* protocolFailure("InboundRequestCapacityExceeded");
  }
});

const validateAdmission = (
  state: ConnectionState,
  request: AcpClientKnownRequest
): AcpClientRequestFailure | undefined => {
  if (state.closed !== undefined) {
    return {
      code: INTERNAL_ERROR,
      message: "Connection closed",
    };
  }
  if (request.method === "initialize") {
    if (request.params.protocolVersion !== 1) {
      return {
        code: INTERNAL_ERROR,
        message: "Unsupported protocol version",
      };
    }
    if (state.capabilities !== undefined) {
      return {
        code: INTERNAL_ERROR,
        message: "Connection already initialized",
      };
    }
    if (state.initializing) {
      return {
        code: INTERNAL_ERROR,
        message: "Initialization already in progress",
      };
    }
    return;
  }
  return state.capabilities === undefined
    ? {
        code: INTERNAL_ERROR,
        message: "Connection not initialized",
      }
    : undefined;
};

export const handleRequest = Effect.fn("handleRequest")(function* (
  resources: ConnectionResources,
  handler: AcpClientRequestHandlerShape,
  enqueue: Enqueue,
  work: InboundWork
) {
  return yield* Effect.gen(function* () {
    const { cancel, request } = work;
    const admission = yield* Ref.modify(resources.state, (current) => {
      const failure = validateAdmission(current, request);
      return [
        failure,
        failure === undefined && request.method === "initialize"
          ? {
              ...current,
              initializing: true,
            }
          : current,
      ] as const;
    });
    const result =
      admission === undefined
        ? yield* handler.handle(request).pipe(
            Effect.raceFirst(
              Deferred.await(cancel).pipe(
                Effect.andThen(
                  Effect.fail({
                    code: REQUEST_CANCELLED,
                    message: "Request cancelled",
                  })
                )
              )
            ),
            Effect.result
          )
        : Result.fail(admission);
    yield* Ref.update(resources.state, (current) => {
      const validInitialize =
        Result.isSuccess(result) &&
        request.method === "initialize" &&
        result.success.method === "initialize" &&
        result.success.result.protocolVersion === 1;
      const next = {
        ...current,
        initializing:
          request.method === "initialize" ? false : current.initializing,
      };
      return validInitialize
        ? {
            ...next,
            capabilities: { client: request.params.clientCapabilities },
          }
        : next;
    });
    if (Result.isFailure(result)) {
      return yield* enqueue(
        errorResponse(request.id, result.failure.code, result.failure.message)
      );
    }
    if (result.success.method !== request.method) {
      return yield* enqueue(
        errorResponse(
          request.id,
          INTERNAL_ERROR,
          "Inbound handler returned the wrong result method"
        )
      );
    }
    if (
      request.method === "initialize" &&
      result.success.method === "initialize" &&
      result.success.result.protocolVersion !== 1
    ) {
      return yield* enqueue(
        errorResponse(
          request.id,
          INTERNAL_ERROR,
          "Unsupported protocol version"
        )
      );
    }
    const wire = yield* encodeAcpResponseForMethod(
      {
        direction: "clientToAgent",
        id: request.id,
        method: request.method,
      },
      {
        ...result.success,
        id: request.id,
        jsonrpc: "2.0",
        kind: "successResponse",
      }
    ).pipe(Effect.mapError(() => protocolFailure()));
    yield* enqueue(wire);
  }).pipe(
    Effect.ensuring(
      Ref.update(resources.state, (current) => {
        const active = new Map(current.active);
        active.delete(work.request.id);
        return {
          ...current,
          active,
        };
      })
    )
  );
});

export const makeInboundHandler =
  (
    resources: ConnectionResources,
    handler: AcpClientRequestHandlerShape,
    enqueue: Enqueue,
    completeResponse: (
      envelope: AcpDecodedResponseEnvelope,
      input: unknown
    ) => Effect.Effect<void, AcpAgentConnectionError>
  ) =>
  (input: unknown) =>
    decodeAcpEnvelope(input).pipe(
      Effect.mapError(() => protocolFailure()),
      Effect.flatMap((envelope) => {
        if (
          envelope.kind === "successResponseEnvelope" ||
          envelope.kind === "errorResponseEnvelope"
        ) {
          return completeResponse(envelope, input);
        }
        return decodeAcpPeerMessage("client", input).pipe(
          Effect.mapError(() => protocolFailure()),
          Effect.flatMap((message) => {
            if (!message.supported) {
              return message.kind === "request"
                ? enqueue(
                    errorResponse(
                      message.id,
                      METHOD_NOT_FOUND,
                      "Method not found"
                    )
                  )
                : Effect.void;
            }
            if (message.kind === "request") {
              return admitInbound(resources, message);
            }
            if (message.method === "session/cancel") {
              return handler
                .cancelSession(message.params.sessionId)
                .pipe(
                  Effect.mapError(() =>
                    protocolFailure("SessionCancellationFailed")
                  )
                );
            }
            return Ref.get(resources.state).pipe(
              Effect.flatMap((current) => {
                const active = current.active.get(message.params.requestId);
                return active === undefined
                  ? Effect.void
                  : Deferred.succeed(active.cancel, true);
              })
            );
          })
        );
      })
    );
