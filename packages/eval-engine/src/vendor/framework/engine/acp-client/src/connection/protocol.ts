import { Effect, Option, Schema } from "effect";

import type { Enqueue } from "./internal.ts";
import type { AcpRequestId } from "../../../../contracts/internal/src/acp/protocol/profile.ts";
import type { AcpConnectionError } from "../errors.ts";
import type {
  AcpClientNotificationMethod,
  AcpClientNotificationParams,
  AcpConnectionShape,
} from "../service.ts";

import {
  decodeAcpPeerMessage,
  encodeAcpPeerMessage,
} from "../../../../contracts/internal/src/acp/codec/codec.ts";
import { AcpErrorResponse } from "../../../../contracts/internal/src/acp/protocol/profile.ts";
import {
  AcpProtocolError,
  AcpTransportError,
} from "../errors.ts";
import { AcpTransportFault } from "../transport.ts";

const TRANSPORT_DETAIL_LIMIT = 256;

export const CANCEL_REQUEST_METHOD = "$/cancel_request";

export const REQUEST_CANCELLED_CODE = -32_800;
export const METHOD_NOT_FOUND_CODE = -32_601;
export const INVALID_PARAMS_CODE = -32_602;
export const INTERNAL_ERROR_CODE = -32_603;

// Extract the codec error's tag through a schema decode rather than an ad-hoc
// `"_tag" in cause` probe, matching how the codec itself reads issue tags.
const TaggedCause = Schema.Struct({ _tag: Schema.String });
const decodeTaggedCause = Schema.decodeUnknownOption(TaggedCause);

export const protocolError = (cause: unknown): AcpProtocolError =>
  new AcpProtocolError({
    reason: Option.match(decodeTaggedCause(cause), {
      onNone: () => "InvalidAcpMessage",
      onSome: ({ _tag }) => _tag,
    }),
  });

const readableCause = (cause: unknown): string | undefined => {
  // Transport implementations raise a typed AcpTransportFault carrying an
  // already-bounded `detail`; read it directly. Non-fault causes (a native
  // Error or raw string) fall through to the generic extraction below.
  if (cause instanceof AcpTransportFault) {
    return cause.detail;
  }
  if (cause instanceof Error) {
    return cause.message;
  }
  return typeof cause === "string" ? cause : undefined;
};

const boundedDetail = (cause: unknown): string | undefined => {
  const message = readableCause(cause);
  if (message === undefined || message.length === 0) {
    return undefined;
  }
  return message.length > TRANSPORT_DETAIL_LIMIT
    ? `${message.slice(0, TRANSPORT_DETAIL_LIMIT)}\u2026`
    : message;
};

/**
 * Build a typed transport error that preserves a *bounded, sanitized* detail
 * from the underlying failure. The raw cause is never surfaced (it may carry
 * unbounded or sensitive native data); only a truncated readable message
 * crosses the boundary, per the transport-cause preservation rule.
 */
export const transportError = (
  operation: AcpTransportError["operation"],
  cause: unknown
): AcpTransportError => {
  const detail = boundedDetail(cause);
  return new AcpTransportError(
    detail === undefined
      ? { operation }
      : {
          detail,
          operation,
        }
  );
};

export const encodeClientMessage = (
  input: unknown
): Effect.Effect<Schema.Json, AcpProtocolError> =>
  decodeAcpPeerMessage("client", input).pipe(
    Effect.flatMap((message) => encodeAcpPeerMessage("client", message)),
    Effect.mapError(protocolError)
  );

export const encodeErrorResponse = (
  id: AcpRequestId,
  failure: {
    readonly code: number;
    readonly data?: Schema.Json;
    readonly message: string;
  }
): Effect.Effect<Schema.Json, AcpProtocolError> => {
  const error =
    failure.data === undefined
      ? {
          code: failure.code,
          message: failure.message,
        }
      : {
          code: failure.code,
          data: failure.data,
          message: failure.message,
        };
  return Schema.encodeUnknownEffect(AcpErrorResponse)({
    error,
    id,
    jsonrpc: "2.0",
  }).pipe(Effect.mapError(protocolError));
};

const clientNotification = <M extends AcpClientNotificationMethod>(
  method: M,
  params: AcpClientNotificationParams<M>
): {
  readonly jsonrpc: "2.0";
  readonly method: M;
  readonly params: AcpClientNotificationParams<M>;
} => ({
  jsonrpc: "2.0",
  method,
  params,
});

export const makeNotify =
  (enqueue: Enqueue): AcpConnectionShape["notify"] =>
  <M extends AcpClientNotificationMethod>(
    method: M,
    params: AcpClientNotificationParams<M>
  ): Effect.Effect<void, AcpConnectionError> =>
    encodeClientMessage(clientNotification(method, params)).pipe(
      Effect.flatMap(enqueue)
    );
