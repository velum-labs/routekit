import type { Schema } from "effect";

import { Context, Effect, Layer, Stream } from "effect";

import type {
  AcpAgentCorrelatedResult,
  AcpAgentKnownNotification,
  AcpAgentKnownRequest,
  CLIENT_REQUEST_SCHEMAS,
  CLIENT_RESULT_SCHEMAS,
  CLIENT_TO_AGENT_NOTIFICATION_SCHEMAS,
} from "../../../contracts/internal/src/acp/protocol/profile.ts";
import type { AcpConnectionError } from "./errors.ts";

import { AcpConnectionClosedError } from "./errors.ts";

// The inert `layerTest` seams refuse deterministically: the request handler
// answers with JSON-RPC method-not-found and the connection reports itself
// closed. Both messages are diagnostic only — no case asserts on them.
const STUB_REFUSAL_MESSAGE = "acp-client layerTest handler refuses requests";
const STUB_CLOSED_REASON = "acp-client layerTest connection is inert";

export type AcpClientRequestMethod = keyof typeof CLIENT_REQUEST_SCHEMAS;
export type AcpOperationalRequestMethod = Exclude<
  AcpClientRequestMethod,
  "initialize"
>;
export type AcpNotificationProducingRequestMethod =
  | "session/load"
  | "session/prompt";
export type AcpClientNotificationMethod =
  keyof typeof CLIENT_TO_AGENT_NOTIFICATION_SCHEMAS;
export type AcpClientRequestParams<M extends AcpClientRequestMethod> =
  (typeof CLIENT_REQUEST_SCHEMAS)[M]["Encoded"];
export type AcpClientRequestResult<M extends AcpClientRequestMethod> =
  (typeof CLIENT_RESULT_SCHEMAS)[M]["Type"];
export type AcpClientNotificationParams<M extends AcpClientNotificationMethod> =
  (typeof CLIENT_TO_AGENT_NOTIFICATION_SCHEMAS)[M]["Encoded"];
export type AcpInitializeParams = Omit<
  (typeof CLIENT_REQUEST_SCHEMAS.initialize)["Encoded"],
  "protocolVersion"
>;
export type AcpInitializeResult =
  (typeof CLIENT_RESULT_SCHEMAS.initialize)["Type"];

export interface AcpCapabilitySnapshot {
  readonly agent: AcpInitializeResult["agentCapabilities"];
  readonly agentInfo: AcpInitializeResult["agentInfo"];
  readonly authMethods: AcpInitializeResult["authMethods"];
  readonly client: (typeof CLIENT_REQUEST_SCHEMAS.initialize)["Type"]["clientCapabilities"];
}

export interface AcpInboundRequestFailure {
  readonly code: number;
  readonly data?: Schema.Json;
  readonly message: string;
}

export interface AcpAgentRequestHandlerShape {
  readonly handle: (
    request: AcpAgentKnownRequest
  ) => Effect.Effect<AcpAgentCorrelatedResult, AcpInboundRequestFailure>;
}

export class AcpAgentRequestHandler extends Context.Service<
  AcpAgentRequestHandler,
  AcpAgentRequestHandlerShape
>()("routekit-eval/acp-client/AcpAgentRequestHandler") {
  /**
   * Test seam: an inbound handler that refuses every agent-to-client request
   * with JSON-RPC method-not-found (`-32601`), the honest default for a client
   * that advertises no inbound capability. A case exercising a real handler
   * (elicitation, permission) overrides `handle`. This port has no production
   * layer — the handler is wired at each embedding site — so it ships only the
   * test seam.
   */
  static readonly layerTest = (
    impl: Partial<AcpAgentRequestHandlerShape>
  ): Layer.Layer<AcpAgentRequestHandler> =>
    Layer.succeed(AcpAgentRequestHandler)(
      AcpAgentRequestHandler.of({
        handle: () =>
          Effect.fail({
            code: -32_601,
            message: STUB_REFUSAL_MESSAGE,
          }),
        ...impl,
      })
    );
}

export interface AcpConnectionShape {
  readonly capabilities: Effect.Effect<
    AcpCapabilitySnapshot,
    AcpConnectionError
  >;
  readonly initialize: (
    params: AcpInitializeParams
  ) => Effect.Effect<AcpCapabilitySnapshot, AcpConnectionError>;
  /**
   * The connection-wide notification stream. Only one notification stream may
   * be consumed at a time; a second consumer fails with
   * `AcpNotificationConsumerActiveError`.
   */
  readonly notifications: Stream.Stream<
    AcpAgentKnownNotification,
    AcpConnectionError
  >;
  readonly notify: <M extends AcpClientNotificationMethod>(
    method: M,
    params: AcpClientNotificationParams<M>
  ) => Effect.Effect<void, AcpConnectionError>;
  readonly request: <M extends AcpOperationalRequestMethod>(
    method: M,
    params: AcpClientRequestParams<M>
  ) => Effect.Effect<AcpClientRequestResult<M>, AcpConnectionError>;
  /**
   * Starts one notification-producing request when the returned stream is
   * consumed, then ends after its response and all earlier notifications.
   * A concurrent notification consumer fails with
   * `AcpNotificationConsumerActiveError`.
   */
  readonly requestNotifications: <
    M extends AcpNotificationProducingRequestMethod,
  >(
    method: M,
    params: AcpClientRequestParams<M>
  ) => Stream.Stream<AcpAgentKnownNotification, AcpConnectionError>;
  readonly shutdown: Effect.Effect<void>;
}

export interface AcpConnectionOptions {
  readonly cancellationRetention?: number;
  readonly inboundConcurrency?: number;
  readonly inboundRequestCapacity?: number;
  readonly notificationCapacity?: number;
  readonly outboundCapacity?: number;
  readonly pendingRequestCapacity?: number;
}

export class AcpConnection extends Context.Service<
  AcpConnection,
  AcpConnectionShape
>()("routekit-eval/acp-client/AcpConnection") {
  /**
   * Test seam: an inert connection that behaves as if the peer is already gone
   * — `capabilities`, `initialize`, `request`, `requestNotifications`, and
   * `notify` all fail with `AcpConnectionClosedError`; `notifications` is the
   * empty stream and `shutdown` is void. There is no natural empty
   * `AcpCapabilitySnapshot`, so failing is the honest inert default; a case
   * that needs a live round-trip overrides the field it drives (or wires the
   * real `AcpConnectionLive` over a peer). The effectful adapter is
   * `AcpConnectionLive` (`connection.ts`).
   */
  static readonly layerTest = (
    impl: Partial<AcpConnectionShape>
  ): Layer.Layer<AcpConnection> =>
    Layer.succeed(AcpConnection)(
      AcpConnection.of({
        capabilities: Effect.fail(
          new AcpConnectionClosedError({ reason: STUB_CLOSED_REASON })
        ),
        initialize: () =>
          Effect.fail(
            new AcpConnectionClosedError({ reason: STUB_CLOSED_REASON })
          ),
        notifications: Stream.empty,
        notify: () =>
          Effect.fail(
            new AcpConnectionClosedError({ reason: STUB_CLOSED_REASON })
          ),
        request: () =>
          Effect.fail(
            new AcpConnectionClosedError({ reason: STUB_CLOSED_REASON })
          ),
        requestNotifications: () =>
          Stream.fail(
            new AcpConnectionClosedError({ reason: STUB_CLOSED_REASON })
          ),
        shutdown: Effect.void,
        ...impl,
      })
    );
}
