import { Effect, Layer } from "effect";

import type {
  AcpAgentCorrelatedResult,
  AcpAgentKnownRequest,
} from "../../../contracts/internal/src/acp/protocol/profile.ts";
import type { AcpInboundRequestFailure } from "../../acp-client/src/service.ts";
import type {
  InteractionHandle,
  RegisterInput,
} from "../../interaction/src/model.ts";
import type { InteractionServiceShape } from "../../interaction/src/service.ts";

import { AcpAgentRequestHandler } from "../../acp-client/src/service.ts";
import { InteractionService } from "../../interaction/src/service.ts";

import type { InteractionSurfacePolicyShape } from "./policy.ts";
import type { InteractiveMethod } from "./result.ts";

import { InteractionSurfacePolicy } from "./policy.ts";
import { projectElicitation, projectPermission } from "./request.ts";
import {
  elicitationFallback,
  INTERNAL_ERROR_CODE,
  INVALID_PARAMS_CODE,
  permissionFallback,
  terminalToResult,
} from "./result.ts";

const METHOD_NOT_FOUND_CODE = -32_601;

const notInteractive: AcpInboundRequestFailure = {
  code: METHOD_NOT_FOUND_CODE,
  message: "The interaction handler serves only permission and elicitation",
};
const capacityExceeded: AcpInboundRequestFailure = {
  code: INTERNAL_ERROR_CODE,
  message: "No capacity to accept a new interactive request",
};
const unsupportedMode: AcpInboundRequestFailure = {
  code: INVALID_PARAMS_CODE,
  message: "Elicitation mode is not supported",
};
const unsupportedScope: AcpInboundRequestFailure = {
  code: INVALID_PARAMS_CODE,
  message: "Request-scoped elicitation is not supported",
};

interface Bridge {
  readonly interactions: InteractionServiceShape;
  readonly policy: InteractionSurfacePolicyShape;
}

// Register the interaction, then await its terminal. On interruption — the
// acp-client cancels this handler's fiber when the peer sends
// `$/cancel_request` — tear down the pending interaction so no request is left
// hanging, then let interruption propagate (the connection writes -32800).
const runInteraction = (
  bridge: Bridge,
  method: InteractiveMethod,
  input: RegisterInput
): Effect.Effect<AcpAgentCorrelatedResult, AcpInboundRequestFailure> =>
  bridge.interactions.register(input).pipe(
    Effect.mapError(() => capacityExceeded),
    Effect.flatMap((handle: InteractionHandle) =>
      handle.awaitOutcome.pipe(
        Effect.onInterrupt(() =>
          bridge.interactions
            .cancelByRequest(handle.correlationId)
            .pipe(Effect.ignore)
        ),
        Effect.flatMap((terminal) => {
          const mapped = terminalToResult(method, terminal);
          return mapped.type === "result"
            ? Effect.succeed(mapped.result)
            : Effect.fail(mapped.failure);
        })
      )
    )
  );

const handlePermission = (
  bridge: Bridge,
  request: Extract<
    AcpAgentKnownRequest,
    { readonly method: "session/request_permission" }
  >
): Effect.Effect<AcpAgentCorrelatedResult, AcpInboundRequestFailure> => {
  const input = projectPermission(request);
  return bridge.policy
    .isAvailable({
      kind: "permission",
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
    })
    .pipe(
      Effect.flatMap((available) =>
        available
          ? runInteraction(bridge, "session/request_permission", input)
          : Effect.succeed(permissionFallback)
      )
    );
};

const handleElicitation = (
  bridge: Bridge,
  request: Extract<
    AcpAgentKnownRequest,
    { readonly method: "elicitation/create" }
  >
): Effect.Effect<AcpAgentCorrelatedResult, AcpInboundRequestFailure> => {
  const projected = projectElicitation(request);
  if (projected.type === "unsupported-mode") {
    return Effect.fail(unsupportedMode);
  }
  if (projected.type === "unsupported-scope") {
    return Effect.fail(unsupportedScope);
  }
  const { input } = projected;
  return bridge.policy
    .isAvailable({
      kind: "elicitation",
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
    })
    .pipe(
      Effect.flatMap((available) =>
        available
          ? runInteraction(bridge, "elicitation/create", input)
          : Effect.succeed(elicitationFallback)
      )
    );
};

const makeHandle =
  (bridge: Bridge) =>
  (
    request: AcpAgentKnownRequest
  ): Effect.Effect<AcpAgentCorrelatedResult, AcpInboundRequestFailure> => {
    if (request.method === "session/request_permission") {
      return handlePermission(bridge, request);
    }
    if (request.method === "elicitation/create") {
      return handleElicitation(bridge, request);
    }
    return Effect.fail(notInteractive);
  };

/**
 * The production {@link AcpAgentRequestHandler}: it bridges inbound ACP
 * agent-to-client permission and elicitation requests to the S2
 * {@link InteractionService}, and answers other methods with method-not-found.
 * It never auto-approves — a permission with no available surface settles as
 * the deterministic `cancelled` outcome supplied by the
 * {@link InteractionSurfacePolicy} port (default deny). Requires the interaction
 * service and the surface policy; the event sink is supplied to the service.
 */
export const AcpInteractionRequestHandlerLive: Layer.Layer<
  AcpAgentRequestHandler,
  never,
  InteractionService | InteractionSurfacePolicy
> = Layer.effect(AcpAgentRequestHandler)(
  Effect.gen(function* () {
    const bridge: Bridge = {
      interactions: yield* InteractionService,
      policy: yield* InteractionSurfacePolicy,
    };
    return AcpAgentRequestHandler.of({ handle: makeHandle(bridge) });
  })
);
