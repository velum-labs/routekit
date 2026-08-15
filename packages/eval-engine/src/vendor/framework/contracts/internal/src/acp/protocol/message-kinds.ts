const AcpPeer = {
  Agent: "agent",
  Client: "client",
} as const;

const AcpRequestDirection = {
  AgentToClient: "agentToClient",
  ClientToAgent: "clientToAgent",
} as const;

const AcpEnvelopeKind = {
  ErrorResponse: "errorResponseEnvelope",
  Notification: "notificationEnvelope",
  Request: "requestEnvelope",
  SuccessResponse: "successResponseEnvelope",
} as const;

const AcpMessageKind = {
  ErrorResponse: "errorResponse",
  Notification: "notification",
  Request: "request",
  SuccessResponse: "successResponse",
} as const;
export { AcpEnvelopeKind, AcpMessageKind, AcpPeer, AcpRequestDirection };
