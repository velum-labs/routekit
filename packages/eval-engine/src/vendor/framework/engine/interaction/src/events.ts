import { Context, Effect, Layer } from "effect";

import type {
  AgentRuntimeEvent,
  ElicitationResolvedAction,
} from "../../../contracts/author/src/agent-event.ts";
import type {
  ElicitationRegisterInput,
  InteractionCorrelationId,
  InteractionKind,
  InteractionResponse,
  PermissionRegisterInput,
} from "./model.ts";

import { AgentRuntimeEventTag } from "../../../contracts/author/src/agent-event.ts";

/**
 * The four interactive-request runtime events the service emits: the `requested`
 * pair on register and the `resolved` pair on terminal resolution. They are the
 * author {@link AgentRuntimeEvent} members without the engine envelope
 * (`harness`/`model`/`raw`/`eventId`/timestamps), which the journaling layer
 * downstream (S3+) stamps — the interaction service owns lifecycle, not
 * journaling.
 */
export type InteractionRuntimeEvent = Extract<
  AgentRuntimeEvent,
  {
    readonly type:
      | typeof AgentRuntimeEventTag.ElicitationRequested
      | typeof AgentRuntimeEventTag.ElicitationResolved
      | typeof AgentRuntimeEventTag.PermissionRequested
      | typeof AgentRuntimeEventTag.PermissionResolved;
  }
>;

export interface InteractionEventSinkShape {
  readonly emit: (event: InteractionRuntimeEvent) => Effect.Effect<void>;
}

/**
 * The small emit port the service publishes through. Decoupling emission behind
 * a replaceable capability keeps the lifecycle engine free of journaling: a
 * production layer forwards to the event bus/journal, a test layer records into
 * a buffer. Emission is `Effect<void>` (no error channel) so a journaling
 * failure can never corrupt or fail an in-flight interaction lifecycle.
 */
export class InteractionEventSink extends Context.Service<
  InteractionEventSink,
  InteractionEventSinkShape
>()("ori/engine/interaction/InteractionEventSink") {
  static readonly layer = (
    emit: (event: InteractionRuntimeEvent) => Effect.Effect<void>
  ): Layer.Layer<InteractionEventSink> =>
    Layer.succeed(InteractionEventSink)(InteractionEventSink.of({ emit }));

  /**
   * Test seam: a sink that silently drops every event. A case asserting on
   * emitted events overrides `emit` (typically forwarding into a `Ref` buffer)
   * via {@link InteractionEventSink.layer}.
   */
  static readonly layerNoop: Layer.Layer<InteractionEventSink> = Layer.succeed(
    InteractionEventSink
  )(InteractionEventSink.of({ emit: () => Effect.void }));
}

export const permissionRequestedEvent = (
  correlationId: InteractionCorrelationId,
  input: PermissionRegisterInput
): InteractionRuntimeEvent => ({
  payload: {
    correlationId,
    operation: input.operation,
    options: input.options.map((option) => option.kind),
    sessionId: input.sessionId,
    toolCallId: input.toolCallId,
  },
  type: AgentRuntimeEventTag.PermissionRequested,
});

export const elicitationRequestedEvent = (
  correlationId: InteractionCorrelationId,
  input: ElicitationRegisterInput
): InteractionRuntimeEvent => ({
  payload: {
    correlationId,
    fields: input.fields,
    message: input.message,
    requestId: input.requestId,
    sessionId: input.sessionId,
    toolCallId: input.toolCallId,
  },
  type: AgentRuntimeEventTag.ElicitationRequested,
});

export const permissionResolvedEvent = (
  correlationId: InteractionCorrelationId,
  outcome:
    | { readonly optionId: string; readonly outcome: "selected" }
    | { readonly outcome: "cancelled" }
): InteractionRuntimeEvent => ({
  payload:
    outcome.outcome === "selected"
      ? {
          correlationId,
          optionId: outcome.optionId,
          outcome: "selected",
        }
      : {
          correlationId,
          outcome: "cancelled",
        },
  type: AgentRuntimeEventTag.PermissionResolved,
});

export const elicitationResolvedEvent = (
  correlationId: InteractionCorrelationId,
  action: ElicitationResolvedAction
): InteractionRuntimeEvent => ({
  payload: {
    action,
    correlationId,
  },
  type: AgentRuntimeEventTag.ElicitationResolved,
});

/** The resolved event for a surface-submitted response. */
export const respondedResolvedEvent = (
  correlationId: InteractionCorrelationId,
  response: InteractionResponse
): InteractionRuntimeEvent => {
  if (response.kind === "elicitation") {
    return elicitationResolvedEvent(correlationId, response.action);
  }
  return response.outcome === "selected"
    ? permissionResolvedEvent(correlationId, {
        optionId: response.optionId,
        outcome: "selected",
      })
    : permissionResolvedEvent(correlationId, { outcome: "cancelled" });
};

/**
 * The resolved event for a cancellation ($/cancel_request or session/cancel):
 * a permission settles as the protocol `cancelled` outcome, an elicitation as
 * the `cancel` action (RFC 0003 Interactive Request Lifecycle).
 */
export const cancelledResolvedEvent = (
  correlationId: InteractionCorrelationId,
  kind: InteractionKind
): InteractionRuntimeEvent =>
  kind === "permission"
    ? permissionResolvedEvent(correlationId, { outcome: "cancelled" })
    : elicitationResolvedEvent(correlationId, "cancel");
