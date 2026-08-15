import { Data, Match } from "effect";

import type { AcpRequestId } from "../../../contracts/internal/src/acp/protocol/profile.ts";
import type { AcpPeerExit } from "./transport.ts";

export class AcpTransportError extends Data.TaggedError("AcpTransportError")<{
  readonly operation: "read" | "send" | "wait-for-exit";
  /**
   * Bounded, sanitized description of the underlying transport failure. The
   * raw cause is `unknown` and may carry unbounded or sensitive native data,
   * so only a truncated readable detail crosses this boundary. Absent when the
   * cause carries no readable message.
   */
  readonly detail?: string;
}> {}

export class AcpPeerExitedError extends Data.TaggedError(
  "AcpPeerExitedError"
)<AcpPeerExit> {}

export class AcpDuplicateResponseIdError extends Data.TaggedError(
  "AcpDuplicateResponseIdError"
)<{ readonly id: AcpRequestId }> {}

export class AcpUnknownResponseIdError extends Data.TaggedError(
  "AcpUnknownResponseIdError"
)<{ readonly id: AcpRequestId }> {}

export class AcpConnectionClosedError extends Data.TaggedError(
  "AcpConnectionClosedError"
)<{ readonly reason: string }> {}

export class AcpRequestCancelledError extends Data.TaggedError(
  "AcpRequestCancelledError"
)<{ readonly id: AcpRequestId; readonly message?: string }> {}

export class AcpRemoteError extends Data.TaggedError("AcpRemoteError")<{
  readonly code: number;
  readonly message: string;
}> {}

export class AcpProtocolError extends Data.TaggedError("AcpProtocolError")<{
  readonly reason: string;
}> {}

export class AcpConnectionConfigError extends Data.TaggedError(
  "AcpConnectionConfigError"
)<{ readonly reason: string }> {}

export class AcpPendingRequestCapacityError extends Data.TaggedError(
  "AcpPendingRequestCapacityError"
)<{ readonly capacity: number }> {}

export class AcpOutboundCapacityError extends Data.TaggedError(
  "AcpOutboundCapacityError"
)<{ readonly capacity: number }> {}

export class AcpInboundRequestCapacityError extends Data.TaggedError(
  "AcpInboundRequestCapacityError"
)<{ readonly capacity: number }> {}

export class AcpNotificationConsumerActiveError extends Data.TaggedError(
  "AcpNotificationConsumerActiveError"
) {}

export class AcpInitializationError extends Data.TaggedError(
  "AcpInitializationError"
)<{
  readonly reason:
    | "AlreadyInitialized"
    | "InitializationInProgress"
    | "NotInitialized";
}> {}

export class AcpProtocolVersionError extends Data.TaggedError(
  "AcpProtocolVersionError"
)<{ readonly expected: 1; readonly received: number }> {}

export type AcpConnectionError =
  | AcpConnectionClosedError
  | AcpConnectionConfigError
  | AcpDuplicateResponseIdError
  | AcpInitializationError
  | AcpInboundRequestCapacityError
  | AcpNotificationConsumerActiveError
  | AcpOutboundCapacityError
  | AcpPeerExitedError
  | AcpPendingRequestCapacityError
  | AcpProtocolError
  | AcpProtocolVersionError
  | AcpRemoteError
  | AcpRequestCancelledError
  | AcpTransportError
  | AcpUnknownResponseIdError;

/**
 * Renders an `AcpConnectionError` as a single human-readable line. `agentLabel`
 * names the remote peer (e.g. `"Pi"`, `"Codex"`, `"Claude"`) for the failures
 * that are attributable to it; connection/protocol-level failures stay generic.
 * Shared so every selected-adapter contribution surfaces identical wording.
 */
export const describeAcpConnectionError = (
  agentLabel: string,
  error: AcpConnectionError
): string =>
  Match.value(error).pipe(
    Match.tag(
      "AcpConnectionClosedError",
      (e) => `ACP connection closed: ${e.reason}`
    ),
    Match.tag(
      "AcpConnectionConfigError",
      (e) => `ACP connection misconfigured: ${e.reason}`
    ),
    Match.tag(
      "AcpDuplicateResponseIdError",
      (e) => `${agentLabel} sent a duplicate response id: ${String(e.id)}`
    ),
    Match.tag(
      "AcpInitializationError",
      (e) => `ACP initialization error: ${e.reason}`
    ),
    Match.tag(
      "AcpInboundRequestCapacityError",
      (e) => `ACP inbound request queue is full (capacity ${e.capacity})`
    ),
    Match.tag(
      "AcpNotificationConsumerActiveError",
      () => "ACP notifications already have an active consumer"
    ),
    Match.tag(
      "AcpOutboundCapacityError",
      (e) => `ACP outbound queue is full (capacity ${e.capacity})`
    ),
    Match.tag("AcpPeerExitedError", (e) => {
      const code = e.code === undefined ? "" : ` with code ${e.code}`;
      const signal = e.signal === undefined ? "" : ` (signal ${e.signal})`;
      return `${agentLabel} process exited${code}${signal}`;
    }),
    Match.tag(
      "AcpPendingRequestCapacityError",
      (e) => `ACP pending request table is full (capacity ${e.capacity})`
    ),
    Match.tag("AcpProtocolError", (e) => `ACP protocol error: ${e.reason}`),
    Match.tag(
      "AcpProtocolVersionError",
      (e) =>
        `ACP protocol version mismatch: expected ${e.expected}, received ${e.received}`
    ),
    Match.tag(
      "AcpRemoteError",
      (e) => `${agentLabel} rejected the request (${e.code}): ${e.message}`
    ),
    Match.tag("AcpRequestCancelledError", (e) => {
      const detail = e.message === undefined ? "" : `: ${e.message}`;
      return `ACP request ${String(e.id)} was cancelled${detail}`;
    }),
    Match.tag("AcpTransportError", (e) => {
      const detail = e.detail === undefined ? "" : `: ${e.detail}`;
      return `${agentLabel} transport error during ${e.operation}${detail}`;
    }),
    Match.tag(
      "AcpUnknownResponseIdError",
      (e) => `${agentLabel} responded to an unknown request id: ${String(e.id)}`
    ),
    Match.exhaustive
  );
