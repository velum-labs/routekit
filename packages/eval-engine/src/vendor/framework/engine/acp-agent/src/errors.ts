import { Data } from "effect";

export class AcpAgentTransportError extends Data.TaggedError(
  "AcpAgentTransportError"
)<{ readonly operation: "read" | "send" | "wait-for-exit" }> {}

export class AcpAgentPeerExitedError extends Data.TaggedError(
  "AcpAgentPeerExitedError"
)<{ readonly code?: number; readonly signal?: string }> {}

export class AcpAgentConnectionClosedError extends Data.TaggedError(
  "AcpAgentConnectionClosedError"
)<{ readonly reason: string }> {}

export class AcpAgentInitializationError extends Data.TaggedError(
  "AcpAgentInitializationError"
)<{
  readonly reason:
    | "AlreadyInitialized"
    | "InitializationInProgress"
    | "NotInitialized";
}> {}

export class AcpAgentProtocolError extends Data.TaggedError(
  "AcpAgentProtocolError"
)<{ readonly reason: string }> {}

export class AcpAgentRemoteError extends Data.TaggedError(
  "AcpAgentRemoteError"
)<{ readonly code: number; readonly message: string }> {}

export class AcpAgentRequestCancelledError extends Data.TaggedError(
  "AcpAgentRequestCancelledError"
) {}

export class AcpAgentPendingCapacityError extends Data.TaggedError(
  "AcpAgentPendingCapacityError"
)<{ readonly capacity: number }> {}

export class AcpAgentOutboundCapacityError extends Data.TaggedError(
  "AcpAgentOutboundCapacityError"
)<{ readonly capacity: number }> {}

export class AcpAgentConfigError extends Data.TaggedError(
  "AcpAgentConfigError"
)<{ readonly reason: string }> {}

export type AcpAgentConnectionError =
  | AcpAgentConfigError
  | AcpAgentConnectionClosedError
  | AcpAgentInitializationError
  | AcpAgentOutboundCapacityError
  | AcpAgentPeerExitedError
  | AcpAgentPendingCapacityError
  | AcpAgentProtocolError
  | AcpAgentRemoteError
  | AcpAgentRequestCancelledError
  | AcpAgentTransportError;
