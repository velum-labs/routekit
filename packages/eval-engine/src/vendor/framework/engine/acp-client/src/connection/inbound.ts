import { Data, Deferred, Effect, Option, Queue, Ref } from "effect";

import type {
  ConnectionResources,
  ConnectionState,
  Enqueue,
  InboundWork,
  KnownInboundRequest,
} from "./internal.ts";
import type {
  AcpAgentCorrelatedResult,
  AcpAgentKnownNotification,
  AcpRequestId,
} from "../../../../contracts/internal/src/acp/protocol/profile.ts";
import type { AcpConnectionError } from "../errors.ts";
import type {
  AcpAgentRequestHandlerShape,
  AcpCapabilitySnapshot,
} from "../service.ts";

import { requireCapabilities } from "./initialization.ts";
import {
  CANCEL_REQUEST_METHOD,
  encodeErrorResponse,
  INVALID_PARAMS_CODE,
  INTERNAL_ERROR_CODE,
  METHOD_NOT_FOUND_CODE,
  protocolError,
  REQUEST_CANCELLED_CODE,
} from "./protocol.ts";
import {
  decodeAcpEnvelope,
  decodeAcpPeerMessage,
  decodeAcpResponseForMethod,
  encodeAcpResponseForMethod,
} from "../../../../contracts/internal/src/acp/codec/codec.ts";
import {
  AcpEnvelopeKind,
  AcpMessageKind,
  AcpRequestDirection,
} from "../../../../contracts/internal/src/acp/protocol/message-kinds.ts";
import {
  AcpInboundRequestCapacityError,
  AcpProtocolError,
} from "../errors.ts";

class InboundRequestCancelled extends Data.TaggedError(
  "InboundRequestCancelled"
) {}

const encodeHandledResult = (
  enqueue: Enqueue,
  request: InboundWork["request"],
  result: AcpAgentCorrelatedResult
): Effect.Effect<void, AcpConnectionError> => {
  if (result.method !== request.method) {
    return encodeErrorResponse(request.id, {
      code: INTERNAL_ERROR_CODE,
      message: "Inbound handler returned the wrong result method",
    }).pipe(Effect.flatMap(enqueue));
  }
  const context = {
    direction: AcpRequestDirection.AgentToClient,
    id: request.id,
    method: request.method,
  } as const;
  return decodeAcpResponseForMethod(context, {
    id: request.id,
    jsonrpc: "2.0",
    result: result.result,
  }).pipe(
    Effect.mapError(protocolError),
    Effect.flatMap((response) => encodeAcpResponseForMethod(context, response)),
    Effect.mapError(protocolError),
    Effect.flatMap(enqueue)
  );
};

export const handleKnownRequest = Effect.fn("AcpConnection.handleKnownRequest")(
  function* ({
    enqueue,
    handler,
    state,
    work,
  }: {
    readonly enqueue: Enqueue;
    readonly handler: AcpAgentRequestHandlerShape;
    readonly state: Ref.Ref<ConnectionState>;
    readonly work: InboundWork;
  }) {
    const { cancel, request } = work;
    const { kind: _, supported: __, ...known } = request;
    const handled = handler.handle(known).pipe(
      Effect.raceFirst(
        Deferred.await(cancel).pipe(
          Effect.andThen(new InboundRequestCancelled())
        )
      ),
      Effect.matchEffect({
        onFailure: (failure) =>
          encodeErrorResponse(
            request.id,
            failure instanceof InboundRequestCancelled
              ? {
                  code: REQUEST_CANCELLED_CODE,
                  message: "Request cancelled",
                }
              : failure
          ).pipe(Effect.flatMap(enqueue)),
        onSuccess: (result) => encodeHandledResult(enqueue, request, result),
      })
    );
    yield* handled.pipe(
      Effect.ensuring(
        Ref.update(state, (current) => {
          const activeInbound = new Map(current.activeInbound);
          activeInbound.delete(request.id);
          return {
            ...current,
            activeInbound,
          };
        })
      )
    );
  }
);

const admitInbound = Effect.fn("AcpConnection.admitInbound")(function* (
  resources: ConnectionResources,
  request: InboundWork["request"]
) {
  const cancel = yield* Deferred.make<true>();
  const duplicate = yield* Ref.modify(resources.state, (current) => {
    if (current.activeInbound.has(request.id)) {
      return [true, current] as const;
    }
    return [
      false,
      {
        ...current,
        activeInbound: new Map([
          ...current.activeInbound,
          [request.id, cancel],
        ]),
      },
    ] as const;
  });
  if (duplicate) {
    return yield* new AcpProtocolError({
      reason: "DuplicateInboundRequestId",
    });
  }
  const work = {
    cancel,
    request,
  };
  const remaining = Queue.offerAllUnsafe(resources.inboundRequests, [work]);
  if (remaining.length > 0) {
    return yield* new AcpInboundRequestCapacityError({
      capacity: resources.inboundRequests.capacity,
    });
  }
});

const cancelInbound = (
  resources: ConnectionResources,
  requestId: AcpRequestId
): Effect.Effect<void> =>
  Ref.get(resources.state).pipe(
    Effect.flatMap((state) => {
      const cancel = state.activeInbound.get(requestId);
      return cancel === undefined
        ? Effect.void
        : Deferred.succeed(cancel, true).pipe(Effect.asVoid);
    })
  );

interface Unsupported {
  readonly code: number;
  readonly message: string;
}

const notAdvertised: Unsupported = {
  code: METHOD_NOT_FOUND_CODE,
  message: "Method not advertised",
};

const unadvertised = (
  advertised: boolean | undefined
): Unsupported | undefined => (advertised === true ? undefined : notAdvertised);

const unsupportedElicitation = (
  snapshot: AcpCapabilitySnapshot,
  request: Extract<
    KnownInboundRequest,
    { readonly method: "elicitation/create" }
  >
): Unsupported | undefined => {
  const { elicitation } = snapshot.client;
  const supportsForm =
    elicitation?.form !== undefined && elicitation.form !== null;
  const supportsUrl =
    elicitation?.url !== undefined && elicitation.url !== null;
  if (
    (request.params.mode === "form" && supportsForm) ||
    (request.params.mode === "url" && supportsUrl)
  ) {
    return;
  }
  return {
    code: INVALID_PARAMS_CODE,
    message: "Elicitation mode was not advertised",
  };
};

// Exhaustive over the closed agent-to-client request union: a new inbound
// method forces a compile error here rather than silently falling through, and
// terminal methods are matched by identity instead of a `terminal/` prefix.
const unsupportedRequest = (
  snapshot: AcpCapabilitySnapshot,
  request: KnownInboundRequest
): Unsupported | undefined => {
  switch (request.method) {
    case "fs/read_text_file": {
      return unadvertised(snapshot.client.fs.readTextFile);
    }
    case "fs/write_text_file": {
      return unadvertised(snapshot.client.fs.writeTextFile);
    }
    case "terminal/create":
    case "terminal/kill":
    case "terminal/output":
    case "terminal/release":
    case "terminal/wait_for_exit": {
      return unadvertised(snapshot.client.terminal);
    }
    case "session/request_permission": {
      return;
    }
    case "elicitation/create": {
      return unsupportedElicitation(snapshot, request);
    }
    default: {
      return request satisfies never;
    }
  }
};

const admitSupportedRequest = ({
  enqueue,
  request,
  resources,
  snapshot,
}: {
  readonly enqueue: Enqueue;
  readonly request: KnownInboundRequest;
  readonly resources: ConnectionResources;
  readonly snapshot: AcpCapabilitySnapshot;
}): Effect.Effect<void, AcpConnectionError> => {
  const unsupported = unsupportedRequest(snapshot, request);
  return unsupported === undefined
    ? admitInbound(resources, request)
    : encodeErrorResponse(request.id, unsupported).pipe(
        Effect.flatMap(enqueue)
      );
};

/**
 * Hand a notification to the active consumer's queue. Waiting for capacity is
 * legitimate backpressure while a consumer is draining, but this runs on the
 * connection's sole reader fiber, so it must never wait on a queue nobody is
 * reading: a notification that arrives with no active consumer has no
 * destination and is discarded, and a wait in progress is abandoned as soon as
 * the consumer releases its lease. Otherwise the reader would stop processing
 * responses and inbound requests for the rest of the connection's life.
 */
const publishNotification = (
  resources: ConnectionResources,
  notification: AcpAgentKnownNotification
): Effect.Effect<void> =>
  Ref.get(resources.notificationConsumer).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.logDebug(
            "Discarded ACP notification with no active consumer",
            {
              method: notification.method,
            }
          ),
        onSome: (lease) =>
          Effect.raceFirst(
            Queue.offer(resources.notifications, {
              notification,
              type: "notification",
            }),
            Deferred.await(lease.ended)
          ).pipe(Effect.asVoid),
      })
    )
  );

export const makeInboundHandler = ({
  completeResponse,
  enqueue,
  resources,
}: {
  readonly completeResponse: (
    id: AcpRequestId,
    input: unknown
  ) => Effect.Effect<void>;
  readonly enqueue: Enqueue;
  readonly resources: ConnectionResources;
}): ((input: unknown) => Effect.Effect<void, AcpConnectionError>) =>
  Effect.fn("AcpConnection.handleInbound")((input: unknown) =>
    decodeAcpEnvelope(input).pipe(
      Effect.mapError(protocolError),
      Effect.flatMap((envelope) => {
        if (
          envelope.kind === AcpEnvelopeKind.SuccessResponse ||
          envelope.kind === AcpEnvelopeKind.ErrorResponse
        ) {
          return completeResponse(envelope.id, input);
        }
        return decodeAcpPeerMessage("agent", input).pipe(
          Effect.mapError(protocolError),
          Effect.flatMap((message) => {
            if (
              message.kind === AcpMessageKind.Notification &&
              message.supported &&
              message.method === CANCEL_REQUEST_METHOD
            ) {
              return cancelInbound(resources, message.params.requestId);
            }
            return requireCapabilities(resources.initialization).pipe(
              Effect.flatMap((snapshot) => {
                if (message.kind === AcpMessageKind.Request) {
                  return message.supported
                    ? admitSupportedRequest({
                        enqueue,
                        request: message,
                        resources,
                        snapshot,
                      })
                    : encodeErrorResponse(message.id, {
                        code: METHOD_NOT_FOUND_CODE,
                        message: "Method not found",
                      }).pipe(Effect.flatMap(enqueue));
                }
                if (!message.supported) {
                  return Effect.void;
                }
                const { kind: _, supported: __, ...notification } = message;
                return publishNotification(resources, notification);
              })
            );
          })
        );
      })
    )
  );
