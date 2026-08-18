import { Match } from "effect";

import type { AgentFailure } from "../../../contracts/author/src/errors/agent-failure.ts";
import type { AcpConnectionError } from "../../acp-client/src/errors.ts";

import { agentFailure } from "../../../contracts/author/src/errors/agent-failure.ts";
import {
  isContextOverflowMessage,
  isMissingSessionMessage,
  isUpstreamAuthRejection,
} from "../../../contracts/author/src/errors/harness-message-classification.ts";
import { PEER_EXIT_ERROR_CODE } from "../../acp-agent/src/connection/protocol.ts";
import {
  AcpRemoteError,
  describeAcpConnectionError,
} from "../../acp-client/src/errors.ts";
import { SelectedAdapterError } from "../../selected-adapter/src/inventory.ts";

const isPeerExitRemoteError = (error: AcpConnectionError): boolean =>
  error instanceof AcpRemoteError && error.code === PEER_EXIT_ERROR_CODE;

/**
 * Classify a JSON-RPC error the peer returned.
 *
 * Overflow, missing-session, and a rejected credential are matched on message
 * text because no peer reports them as a distinct code: `error.code` is -32003
 * for every one of them. Everything else keys off `error.code`, so peer wording
 * changes cannot silently reclassify a failure.
 */
const remoteFailure = (
  displayName: string,
  error: AcpRemoteError
): AgentFailure => {
  if (isMissingSessionMessage(error.message)) {
    return agentFailure({
      code: "ORI_SESSION_NOT_FOUND",
      message: `${displayName} could not find the requested session.`,
      remediation: "Start a new session instead of resuming this one.",
      stage: "adapter",
      upstreamCode: error.code,
    });
  }
  if (isContextOverflowMessage(error.message)) {
    return agentFailure({
      code: "ORI_CONTEXT_OVERFLOW",
      stage: "adapter",
      upstreamCode: error.code,
    });
  }
  if (isUpstreamAuthRejection(error.message)) {
    return agentFailure({
      code: "ORI_ADAPTER_UNAUTHORIZED",
      message: `${displayName}'s provider rejected the credential.`,
      remediation:
        "Run `ori login`, or check the OPENROUTER_API_KEY in this environment.",
      stage: "adapter",
      upstreamCode: error.code,
    });
  }
  return agentFailure({
    code: "ORI_ADAPTER_REMOTE_ERROR",
    message: `${displayName} rejected the request.`,
    remediation: "Check the selected model and provider status.",
    stage: "adapter",
    upstreamCode: error.code,
  });
};

const peerExitFailure = (displayName: string): AgentFailure =>
  agentFailure({
    code: "ORI_ADAPTER_PEER_EXIT",
    message: `${displayName} exited before completing the request.`,
    stage: "adapter",
  });

const protocolFailure = (
  displayName: string,
  error: AcpConnectionError
): AgentFailure =>
  Match.value(error).pipe(
    Match.tag("AcpProtocolVersionError", (version) =>
      agentFailure({
        code: "ORI_ADAPTER_PROTOCOL_VERSION",
        message: `${displayName} speaks ACP version ${version.received}; ORI requires ${version.expected}.`,
        remediation: `Update ${displayName} to a build that speaks ACP version ${version.expected}.`,
        stage: "adapter",
        upstreamCode: version.received,
      })
    ),
    Match.tag("AcpInitializationError", (initialization) =>
      agentFailure({
        code: "ORI_ADAPTER_INITIALIZATION",
        message: `${displayName} failed to initialize.`,
        stage: "adapter",
        upstreamCode: initialization.reason,
      })
    ),
    Match.orElse((protocol) =>
      agentFailure({
        code: "ORI_ADAPTER_PROTOCOL",
        message: `${displayName} violated the ACP protocol.`,
        stage: "adapter",
        upstreamCode: protocol._tag,
      })
    )
  );

const safeAcpConnectionFailure = (
  displayName: string,
  error: AcpConnectionError
): AgentFailure => {
  if (isPeerExitRemoteError(error)) {
    return agentFailure({
      code: "ORI_ADAPTER_PEER_EXIT",
      message: `${displayName} exited before completing the request.`,
      stage: "adapter",
      upstreamCode: PEER_EXIT_ERROR_CODE,
    });
  }
  return Match.value(error).pipe(
    Match.tag("AcpPeerExitedError", () => peerExitFailure(displayName)),
    Match.tag("AcpRemoteError", (remote) => remoteFailure(displayName, remote)),
    Match.tag("AcpTransportError", (transport) =>
      agentFailure({
        code: "ORI_ADAPTER_TRANSPORT",
        message: `The ${displayName} transport failed during ${transport.operation}.`,
        stage: "adapter",
        upstreamCode: transport.operation,
      })
    ),
    Match.tag("AcpRequestCancelledError", () =>
      agentFailure({
        code: "ORI_REQUEST_CANCELLED",
        message: `The ${displayName} request was cancelled.`,
        stage: "adapter",
      })
    ),
    Match.tag("AcpConnectionClosedError", () =>
      agentFailure({
        code: "ORI_ADAPTER_CLOSED",
        message: `The ${displayName} connection closed before the request finished.`,
        stage: "adapter",
      })
    ),
    Match.tag("AcpConnectionConfigError", () =>
      agentFailure({
        code: "ORI_ADAPTER_CONFIG",
        message: `The ${displayName} connection is misconfigured.`,
        stage: "adapter",
      })
    ),
    Match.tag(
      "AcpPendingRequestCapacityError",
      "AcpOutboundCapacityError",
      "AcpInboundRequestCapacityError",
      (capacity) =>
        agentFailure({
          code: "ORI_ADAPTER_CAPACITY",
          message: `An ORI queue for ${displayName} reached its ${capacity.capacity}-entry limit.`,
          stage: "adapter",
          upstreamCode: capacity._tag,
        })
    ),
    Match.orElse((remaining) => protocolFailure(displayName, remaining))
  );
};

export const makeAcpConnectionErrorMapper =
  (displayName: string) =>
  (error: AcpConnectionError): SelectedAdapterError =>
    new SelectedAdapterError({
      detail: describeAcpConnectionError(displayName, error),
      reason:
        error._tag === "AcpPeerExitedError" || isPeerExitRemoteError(error)
          ? "peer-exit"
          : "connection",
      safeFailure: safeAcpConnectionFailure(displayName, error),
    });
