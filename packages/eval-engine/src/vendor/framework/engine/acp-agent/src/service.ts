import { Context, Effect, Layer } from "effect";

import type {
  AcpClientCorrelatedResult,
  AcpClientKnownRequest,
  AGENT_REQUEST_SCHEMAS,
  AGENT_RESULT_SCHEMAS,
  AGENT_TO_CLIENT_NOTIFICATION_SCHEMAS,
  CLIENT_REQUEST_SCHEMAS,
} from "../../../contracts/internal/src/acp/protocol/profile.ts";

import type { AcpAgentConnectionError } from "./errors.ts";

import {
  AcpAgentConnectionClosedError,
  AcpAgentInitializationError,
} from "./errors.ts";

export type AcpAgentRequestMethod = keyof typeof AGENT_REQUEST_SCHEMAS;
export type AcpAgentNotificationMethod =
  keyof typeof AGENT_TO_CLIENT_NOTIFICATION_SCHEMAS;
export type AcpAgentRequestParams<M extends AcpAgentRequestMethod> =
  (typeof AGENT_REQUEST_SCHEMAS)[M]["Encoded"];
export type AcpAgentRequestResult<M extends AcpAgentRequestMethod> =
  (typeof AGENT_RESULT_SCHEMAS)[M]["Type"];
export type AcpAgentNotificationParams<M extends AcpAgentNotificationMethod> =
  (typeof AGENT_TO_CLIENT_NOTIFICATION_SCHEMAS)[M]["Encoded"];

export interface AcpClientCapabilitiesSnapshot {
  readonly client: (typeof CLIENT_REQUEST_SCHEMAS.initialize)["Type"]["clientCapabilities"];
}

export interface AcpClientRequestFailure {
  readonly code: number;
  readonly message: string;
}

export interface AcpClientRequestHandlerShape {
  readonly cancelSession: (
    sessionId: string
  ) => Effect.Effect<void, AcpClientRequestFailure>;
  readonly handle: (
    request: AcpClientKnownRequest
  ) => Effect.Effect<AcpClientCorrelatedResult, AcpClientRequestFailure>;
}

export class AcpClientRequestHandler extends Context.Service<
  AcpClientRequestHandler,
  AcpClientRequestHandlerShape
>()("ori/acp-agent/AcpClientRequestHandler") {
  /**
   * Test seam: an inert `AcpClientRequestHandler`. `cancelSession` resolves to
   * void and `handle` fails with a JSON-RPC `METHOD_NOT_FOUND` failure, so a
   * case must opt in to any answered request by overriding `handle`. Spread
   * `...impl` over the defaults to script only the behavior under test. The
   * effectful adapters that answer real client requests live in
   * `@ori-engine/acp-adapter-kit/selected-adapter-layers`.
   *
   * The `-32_601` sentinel mirrors `METHOD_NOT_FOUND` from `#connection/protocol`
   * but is inlined so this port module stays a dependency leaf (it imports no
   * `connection/*` adapter internals); `service.test.ts` guards the two against
   * drift.
   */
  static readonly layerTest = (
    impl: Partial<AcpClientRequestHandlerShape>
  ): Layer.Layer<AcpClientRequestHandler> =>
    Layer.succeed(AcpClientRequestHandler)(
      AcpClientRequestHandler.of({
        cancelSession: () => Effect.void,
        handle: () =>
          Effect.fail({
            code: -32_601,
            message: "AcpClientRequestHandler.layerTest: no handler provided",
          }),
        ...impl,
      })
    );
}

export interface AcpAgentConnectionShape {
  readonly capabilities: Effect.Effect<
    AcpClientCapabilitiesSnapshot,
    AcpAgentConnectionError
  >;
  readonly notify: <M extends AcpAgentNotificationMethod>(
    method: M,
    params: AcpAgentNotificationParams<M>
  ) => Effect.Effect<void, AcpAgentConnectionError>;
  readonly request: <M extends AcpAgentRequestMethod>(
    method: M,
    params: AcpAgentRequestParams<M>
  ) => Effect.Effect<AcpAgentRequestResult<M>, AcpAgentConnectionError>;
  readonly shutdown: Effect.Effect<void>;
}

export interface AcpAgentConnectionOptions {
  readonly cancellationRetention?: number;
  readonly inboundConcurrency?: number;
  readonly inboundRequestCapacity?: number;
  readonly outboundCapacity?: number;
  readonly pendingRequestCapacity?: number;
}

export class AcpAgentConnection extends Context.Service<
  AcpAgentConnection,
  AcpAgentConnectionShape
>()("ori/acp-agent/AcpAgentConnection") {
  /**
   * Test seam: an inert `AcpAgentConnection`. `capabilities` fails
   * `NotInitialized` (no handshake has run), `notify`/`shutdown` resolve to
   * void, and `request` fails closed — a generic `AcpAgentRequestResult<M>`
   * cannot be fabricated, so a case must override `request` to answer one.
   * Spread `...impl` to script only the behavior under test. The live
   * connection over a transport pair is `AcpAgentConnectionLive`
   * (`connection.ts`).
   */
  static readonly layerTest = (
    impl: Partial<AcpAgentConnectionShape>
  ): Layer.Layer<AcpAgentConnection> =>
    Layer.succeed(AcpAgentConnection)(
      AcpAgentConnection.of({
        capabilities: Effect.fail(
          new AcpAgentInitializationError({ reason: "NotInitialized" })
        ),
        notify: () => Effect.void,
        request: () =>
          Effect.fail(
            new AcpAgentConnectionClosedError({
              reason: "AcpAgentConnection.layerTest: request not provided",
            })
          ),
        shutdown: Effect.void,
        ...impl,
      })
    );
}
