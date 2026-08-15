import type { Schema } from "effect";

import { Effect } from "effect";

import type {
  AcpMalformedJsonError,
  AcpSchemaDecodeError,
} from "../errors.ts";
import type { AcpPeer } from "../protocol/profile.ts";

import {
  AcpInvalidEnvelopeError,
  AcpUnexpectedResponseError,
  AcpUnknownMethodError,
} from "../errors.ts";
import {
  AcpEnvelopeKind,
  AcpMessageKind,
  AcpPeer as AcpPeerValue,
  AcpRequestDirection,
} from "../protocol/message-kinds.ts";
import {
  AcpAgentCorrelatedResult,
  AcpAgentKnownNotification,
  AcpAgentKnownRequest,
  AcpClientCorrelatedResult,
  AcpClientKnownNotification,
  AcpClientKnownRequest,
  AcpErrorResponse,
  AcpNotificationEnvelope,
  AcpRequestEnvelope,
  AcpSuccessResponseEnvelope,
} from "../protocol/profile.ts";

import type {
  AcpDecodedAgentPeerMessage,
  AcpDecodedClientPeerMessage,
  AcpDecodedErrorResponse,
  AcpDecodedMessage,
  AcpDecodedNotification,
  AcpDecodedPeerMessage,
  AcpDecodedRequest,
  AcpDecodedResponse,
  AcpDecodedSuccessResponse,
  AcpPendingRequest,
  UnknownNotification,
  UnknownRequest,
} from "./model.ts";

import {
  makeKnownNotification,
  makeKnownRequest,
  makeKnownSuccessResponse,
} from "./constructors.ts";
import { decodeAcpEnvelope, safeRequestId } from "./envelope.ts";
import {
  absurd,
  decodeWith,
  encodeWith,
  lookupSchema,
  notificationSchemasFor,
  requestSchemasFor,
  resultSchemasFor,
} from "./schema-routing.ts";

type Json = Schema.Json;
type AcpCodecDecodeError =
  | AcpInvalidEnvelopeError
  | AcpMalformedJsonError
  | AcpSchemaDecodeError
  | AcpUnexpectedResponseError
  | AcpUnknownMethodError;

const decodePeerMessage = Effect.fn("AcpCodec.decodePeerMessage")(function* (
  peer: AcpPeer,
  input: unknown
): Effect.fn.Return<AcpDecodedPeerMessage, AcpCodecDecodeError> {
  const envelope = yield* decodeAcpEnvelope(input);
  switch (envelope.kind) {
    case AcpEnvelopeKind.Request: {
      const { kind: _, ...wire } = envelope;
      if (lookupSchema(requestSchemasFor(peer), wire.method) === undefined) {
        return {
          ...wire,
          kind: AcpMessageKind.Request,
          supported: false,
        } satisfies UnknownRequest;
      }
      switch (peer) {
        case AcpPeerValue.Agent: {
          return makeKnownRequest(
            yield* decodeWith(AcpAgentKnownRequest, wire)
          );
        }
        case AcpPeerValue.Client: {
          return makeKnownRequest(
            yield* decodeWith(AcpClientKnownRequest, wire)
          );
        }
        default: {
          return absurd(peer);
        }
      }
    }
    case AcpEnvelopeKind.Notification: {
      const { kind: _, ...wire } = envelope;
      if (
        lookupSchema(notificationSchemasFor(peer), wire.method) === undefined
      ) {
        return {
          ...wire,
          kind: AcpMessageKind.Notification,
          supported: false,
        } satisfies UnknownNotification;
      }
      switch (peer) {
        case AcpPeerValue.Agent: {
          return makeKnownNotification(
            yield* decodeWith(AcpAgentKnownNotification, wire)
          );
        }
        case AcpPeerValue.Client: {
          return makeKnownNotification(
            yield* decodeWith(AcpClientKnownNotification, wire)
          );
        }
        default: {
          return absurd(peer);
        }
      }
    }
    case AcpEnvelopeKind.ErrorResponse:
    case AcpEnvelopeKind.SuccessResponse: {
      return yield* new AcpInvalidEnvelopeError();
    }
    default: {
      return absurd(envelope);
    }
  }
});

function decodeAcpPeerMessage(
  peer: typeof AcpPeerValue.Agent,
  input: unknown
): Effect.Effect<AcpDecodedAgentPeerMessage, AcpCodecDecodeError>;
function decodeAcpPeerMessage(
  peer: typeof AcpPeerValue.Client,
  input: unknown
): Effect.Effect<AcpDecodedClientPeerMessage, AcpCodecDecodeError>;
function decodeAcpPeerMessage(
  peer: AcpPeer,
  input: unknown
): Effect.Effect<AcpDecodedPeerMessage, AcpCodecDecodeError> {
  return decodePeerMessage(peer, input);
}

const decodeAcpResponseForMethod = Effect.fn(
  "AcpCodec.decodeResponseForMethod"
)(function* (
  pending: AcpPendingRequest,
  input: unknown
): Effect.fn.Return<AcpDecodedResponse, AcpCodecDecodeError> {
  const envelope = yield* decodeAcpEnvelope(input);
  switch (envelope.kind) {
    case AcpEnvelopeKind.ErrorResponse: {
      if (envelope.id !== pending.id) {
        return yield* new AcpUnexpectedResponseError({
          requestId: safeRequestId(envelope.id),
        });
      }
      const { kind: _, ...wire } = envelope;
      return {
        ...wire,
        kind: AcpMessageKind.ErrorResponse,
        method: pending.method,
      } satisfies AcpDecodedErrorResponse;
    }
    case AcpEnvelopeKind.SuccessResponse: {
      if (envelope.id !== pending.id) {
        return yield* new AcpUnexpectedResponseError({
          requestId: safeRequestId(envelope.id),
        });
      }
      const { kind: _, ...wire } = envelope;
      if (
        lookupSchema(resultSchemasFor(pending.direction), pending.method) ===
        undefined
      ) {
        return yield* new AcpUnknownMethodError({
          method: "[redacted]",
          requestId: safeRequestId(wire.id),
        });
      }
      const value = {
        method: pending.method,
        result: wire.result,
      };
      switch (pending.direction) {
        case AcpRequestDirection.AgentToClient: {
          return makeKnownSuccessResponse(
            yield* decodeWith(AcpAgentCorrelatedResult, value),
            wire
          );
        }
        case AcpRequestDirection.ClientToAgent: {
          return makeKnownSuccessResponse(
            yield* decodeWith(AcpClientCorrelatedResult, value),
            wire
          );
        }
        default: {
          return absurd(pending.direction);
        }
      }
    }
    case AcpEnvelopeKind.Notification:
    case AcpEnvelopeKind.Request: {
      return yield* new AcpInvalidEnvelopeError();
    }
    default: {
      return absurd(envelope);
    }
  }
});

const encodePeerMessage = Effect.fn("AcpCodec.encodePeerMessage")(function* (
  peer: AcpPeer,
  message: AcpDecodedPeerMessage
): Effect.fn.Return<Json, AcpSchemaDecodeError> {
  switch (message.kind) {
    case AcpMessageKind.Request: {
      const { kind: _, supported: __, ...wire } = message;
      if (message.supported) {
        switch (peer) {
          case AcpPeerValue.Agent: {
            return yield* encodeWith(AcpAgentKnownRequest, wire);
          }
          case AcpPeerValue.Client: {
            return yield* encodeWith(AcpClientKnownRequest, wire);
          }
          default: {
            return absurd(peer);
          }
        }
      }
      return yield* encodeWith(AcpRequestEnvelope, wire);
    }
    case AcpMessageKind.Notification: {
      const { kind: _, supported: __, ...wire } = message;
      if (message.supported) {
        switch (peer) {
          case AcpPeerValue.Agent: {
            return yield* encodeWith(AcpAgentKnownNotification, wire);
          }
          case AcpPeerValue.Client: {
            return yield* encodeWith(AcpClientKnownNotification, wire);
          }
          default: {
            return absurd(peer);
          }
        }
      }
      return yield* encodeWith(AcpNotificationEnvelope, wire);
    }
    default: {
      return absurd(message);
    }
  }
});

function encodeAcpPeerMessage(
  peer: typeof AcpPeerValue.Agent,
  message: AcpDecodedAgentPeerMessage
): Effect.Effect<Json, AcpSchemaDecodeError>;
function encodeAcpPeerMessage(
  peer: typeof AcpPeerValue.Client,
  message: AcpDecodedClientPeerMessage
): Effect.Effect<Json, AcpSchemaDecodeError>;
function encodeAcpPeerMessage(
  peer: AcpPeer,
  message: AcpDecodedPeerMessage
): Effect.Effect<Json, AcpSchemaDecodeError> {
  return encodePeerMessage(peer, message);
}

const encodeCorrelatedResult = Effect.fn("AcpCodec.encodeCorrelatedResult")(
  function* (
    direction: AcpPendingRequest["direction"],
    value: Omit<AcpDecodedSuccessResponse, "id" | "jsonrpc" | "kind">
  ) {
    switch (direction) {
      case AcpRequestDirection.AgentToClient: {
        return yield* encodeWith(AcpAgentCorrelatedResult, value);
      }
      case AcpRequestDirection.ClientToAgent: {
        return yield* encodeWith(AcpClientCorrelatedResult, value);
      }
      default: {
        return absurd(direction);
      }
    }
  }
);

const encodeAcpResponseForMethod = Effect.fn(
  "AcpCodec.encodeResponseForMethod"
)(function* (
  pending: AcpPendingRequest,
  message: AcpDecodedResponse
): Effect.fn.Return<
  Json,
  AcpSchemaDecodeError | AcpUnexpectedResponseError | AcpUnknownMethodError
> {
  if (message.id !== pending.id || message.method !== pending.method) {
    return yield* new AcpUnexpectedResponseError({
      requestId: safeRequestId(message.id),
    });
  }
  switch (message.kind) {
    case AcpMessageKind.ErrorResponse: {
      const { kind: _, method: __, ...wire } = message;
      return yield* encodeWith(AcpErrorResponse, wire);
    }
    case AcpMessageKind.SuccessResponse: {
      if (
        lookupSchema(resultSchemasFor(pending.direction), pending.method) ===
        undefined
      ) {
        return yield* new AcpUnknownMethodError({
          method: "[redacted]",
          requestId: safeRequestId(message.id),
        });
      }
      const { id, jsonrpc, kind: _, ...correlatedValue } = message;
      const correlated = yield* encodeCorrelatedResult(
        pending.direction,
        correlatedValue
      );
      return yield* encodeWith(AcpSuccessResponseEnvelope, {
        id,
        jsonrpc,
        result: correlated.result,
      });
    }
    default: {
      return absurd(message);
    }
  }
});

export {
  AcpEnvelopeKind,
  AcpMessageKind,
  decodeAcpEnvelope,
  decodeAcpPeerMessage,
  decodeAcpResponseForMethod,
  encodeAcpPeerMessage,
  encodeAcpResponseForMethod,
};
export type {
  AcpDecodedAgentPeerMessage,
  AcpDecodedClientPeerMessage,
  AcpDecodedErrorResponse,
  AcpDecodedMessage,
  AcpDecodedNotification,
  AcpDecodedPeerMessage,
  AcpDecodedRequest,
  AcpDecodedResponse,
  AcpDecodedSuccessResponse,
  AcpPendingRequest,
};
