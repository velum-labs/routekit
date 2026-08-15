import type { AcpMessageKind as MessageKind } from "../protocol/message-kinds.ts";
import type {
  AcpAgentCorrelatedResult,
  AcpAgentKnownNotification,
  AcpAgentKnownRequest,
  AcpClientCorrelatedResult,
  AcpClientKnownNotification,
  AcpClientKnownRequest,
  AcpErrorResponse,
  AcpNotificationEnvelope,
  AcpRequestDirection,
  AcpRequestEnvelope,
  AcpRequestId,
} from "../protocol/profile.ts";

import type {
  KnownNotification,
  KnownRequest,
  KnownSuccessResponse,
} from "./constructors.ts";

type UnknownRequest = AcpRequestEnvelope & {
  readonly kind: typeof MessageKind.Request;
  readonly supported: false;
};

type UnknownNotification = AcpNotificationEnvelope & {
  readonly kind: typeof MessageKind.Notification;
  readonly supported: false;
};

type AcpDecodedAgentPeerMessage =
  | KnownNotification<AcpAgentKnownNotification>
  | KnownRequest<AcpAgentKnownRequest>
  | UnknownNotification
  | UnknownRequest;
type AcpDecodedClientPeerMessage =
  | KnownNotification<AcpClientKnownNotification>
  | KnownRequest<AcpClientKnownRequest>
  | UnknownNotification
  | UnknownRequest;
type AcpDecodedRequest =
  | KnownRequest<AcpAgentKnownRequest>
  | KnownRequest<AcpClientKnownRequest>
  | UnknownRequest;
type AcpDecodedNotification =
  | KnownNotification<AcpAgentKnownNotification>
  | KnownNotification<AcpClientKnownNotification>
  | UnknownNotification;
type AcpDecodedSuccessResponse = KnownSuccessResponse<
  AcpAgentCorrelatedResult | AcpClientCorrelatedResult
>;
type AcpDecodedErrorResponse = Pick<
  AcpErrorResponse,
  "error" | "id" | "jsonrpc"
> & {
  readonly kind: typeof MessageKind.ErrorResponse;
  readonly method: string;
};
type AcpDecodedPeerMessage = AcpDecodedRequest | AcpDecodedNotification;
type AcpDecodedResponse = AcpDecodedSuccessResponse | AcpDecodedErrorResponse;
type AcpDecodedMessage = AcpDecodedPeerMessage | AcpDecodedResponse;
interface AcpPendingRequest<
  D extends AcpRequestDirection = AcpRequestDirection,
  M extends string = string,
> {
  readonly direction: D;
  readonly id: AcpRequestId;
  readonly method: M;
}

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
  UnknownNotification,
  UnknownRequest,
};
