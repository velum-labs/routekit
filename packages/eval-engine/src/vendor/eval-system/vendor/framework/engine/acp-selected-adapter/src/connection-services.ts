import { Context, Effect, Layer, Option, Queue, Ref } from "effect";

import type { AgentRuntimeEvent } from "../../../contracts/author/src/agent-event.ts";
import type { SessionId } from "../../../contracts/internal/src/ids.ts";
import type { AcpInitializeParams } from "../../acp-client/src/service.ts";
import type { AcpTransportShape } from "../../acp-client/src/transport.ts";
import type { InteractionKind } from "../../interaction/src/model.ts";

import { AgentRuntimeEventTag } from "../../../contracts/author/src/agent-event.ts";
import { AcpConnectionLive } from "../../acp-client/src/connection.ts";
import {
  AcpAgentRequestHandler,
  AcpConnection,
} from "../../acp-client/src/service.ts";
import { AcpTransport } from "../../acp-client/src/transport.ts";
import { AcpInteractionRequestHandlerLive } from "../../acp-interaction/src/handler.ts";
import { InteractionSurfacePolicy } from "../../acp-interaction/src/policy.ts";
import { InteractionEventSink } from "../../interaction/src/events.ts";
import { InteractionService } from "../../interaction/src/service.ts";

const METHOD_NOT_FOUND = -32_601;

const clientCapabilitiesForInteractions = (
  interactionsEnabled: boolean
): NonNullable<AcpInitializeParams["clientCapabilities"]> =>
  interactionsEnabled ? { elicitation: { form: {} } } : {};

type PromptInteractionQueueItem =
  | {
      readonly done: true;
      readonly promptId: symbol;
    }
  | {
      readonly event: AgentRuntimeEvent;
      readonly promptId: symbol;
    };

interface ActivePrompt {
  readonly interactionSurface: boolean;
  readonly promptId: symbol;
}

/**
 * The inbound ACP method each interaction kind arrives as. A refusal names the
 * method so the caller can tell which request was answered with a safe default.
 */
const REFUSED_METHOD_FOR_KIND: Record<InteractionKind, string> = {
  elicitation: "elicitation/create",
  permission: "session/request_permission",
};

interface PromptEventTarget {
  readonly activePrompt: Ref.Ref<Option.Option<ActivePrompt>>;
  readonly interactionEvents: Queue.Enqueue<PromptInteractionQueueItem>;
}

/**
 * The identity of a refused inbound request. `sessionId`/`toolCallId` are what
 * let an operator tell twelve refused tool-call permissions apart; the policy
 * scope carries both, the raw refuse-all path knows only the method.
 */
interface RefusedRequest {
  readonly method: string;
  readonly sessionId?: SessionId | undefined;
  readonly toolCallId?: string | undefined;
}

const headlessRefusalMessage = (refused: RefusedRequest): string =>
  `refused an inbound ${refused.method} request: this run has no interaction surface, so it was answered with the safe default`;

const headlessRefusalWarning = (
  refused: RefusedRequest
): AgentRuntimeEvent => ({
  payload: {
    detail: refused,
    message: headlessRefusalMessage(refused),
  },
  type: AgentRuntimeEventTag.RuntimeWarning,
});

/**
 * Deliver an event to the active prompt's stream, or run `whenDropped` when
 * there is no prompt to attach it to.
 *
 * The queue is per-prompt, so a `None` lease has nowhere to deliver. That
 * window is narrow but real: the lease is released in a `Stream.ensuring` as
 * the prompt stream halts, so an event in flight during a cancellation can land
 * just after it clears. Every caller routes through here so the no-prompt case
 * has to be answered explicitly — silently dropping it is the bug this module
 * exists to prevent.
 */
const deliverToActivePrompt =
  (
    interactionEvents: Queue.Enqueue<PromptInteractionQueueItem>,
    activePrompt: Option.Option<ActivePrompt>
  ) =>
  (
    event: AgentRuntimeEvent,
    whenDropped: Effect.Effect<void>
  ): Effect.Effect<void> =>
    Option.match(activePrompt, {
      onNone: () => whenDropped,
      onSome: (prompt) =>
        Queue.offer(interactionEvents, {
          event,
          promptId: prompt.promptId,
        }).pipe(Effect.asVoid),
    });

const announceHeadlessRefusal = (
  input: PromptEventTarget,
  activePrompt: Option.Option<ActivePrompt>,
  refused: RefusedRequest
): Effect.Effect<void> =>
  deliverToActivePrompt(input.interactionEvents, activePrompt)(
    headlessRefusalWarning(refused),
    Effect.logWarning(headlessRefusalMessage(refused), refused)
  );

const offerHeadlessRefusalWarning = (
  input: PromptEventTarget,
  refused: RefusedRequest
): Effect.Effect<void> =>
  Ref.get(input.activePrompt).pipe(
    Effect.flatMap((activePrompt) =>
      announceHeadlessRefusal(input, activePrompt, refused)
    )
  );

/** @internal */
const makeInteractionSinkLayer = (
  input: PromptEventTarget
): Layer.Layer<InteractionEventSink> =>
  InteractionEventSink.layer((event) =>
    Ref.get(input.activePrompt).pipe(
      Effect.flatMap((activePrompt) =>
        deliverToActivePrompt(input.interactionEvents, activePrompt)(
          event,
          Effect.logWarning(
            `dropped a ${event.type} interaction event: no prompt is active to carry it`,
            event
          )
        )
      )
    )
  );

/** @internal */
const makeInteractionSurfacePolicyLayer = (
  input: PromptEventTarget
): Layer.Layer<InteractionSurfacePolicy> =>
  InteractionSurfacePolicy.layer((scope) =>
    Ref.get(input.activePrompt).pipe(
      Effect.flatMap((activePrompt) => {
        const surfaceMounted = activePrompt.pipe(
          Option.map((prompt) => prompt.interactionSurface),
          Option.getOrElse(() => false)
        );
        return surfaceMounted
          ? Effect.succeed(true)
          : announceHeadlessRefusal(input, activePrompt, {
              method: REFUSED_METHOD_FOR_KIND[scope.kind],
              sessionId: scope.sessionId,
              toolCallId: scope.toolCallId,
            }).pipe(Effect.as(false));
      })
    )
  );

/** @internal */
const makeRefuseAllAgentRequestsLayer = (
  input: PromptEventTarget
): Layer.Layer<AcpAgentRequestHandler> =>
  Layer.succeed(AcpAgentRequestHandler, {
    handle: (request) =>
      offerHeadlessRefusalWarning(input, { method: request.method }).pipe(
        Effect.andThen(
          Effect.fail({
            code: METHOD_NOT_FOUND,
            message: `routekit-eval's selected-adapter coordinator runs headless and does not support inbound ${request.method} requests`,
          })
        )
      ),
  });

const buildConnectionServices = Effect.fn(
  "AcpSelectedAdapterContribution.buildConnectionServices"
)(function* (input: {
  readonly activePrompt: Ref.Ref<Option.Option<ActivePrompt>>;
  readonly interactionsEnabled: boolean;
  readonly interactionEvents: Queue.Enqueue<PromptInteractionQueueItem>;
  readonly transport: AcpTransportShape;
}) {
  const promptEvents: PromptEventTarget = {
    activePrompt: input.activePrompt,
    interactionEvents: input.interactionEvents,
  };
  const interactionLayer = InteractionService.layer().pipe(
    Layer.provide(makeInteractionSinkLayer(promptEvents))
  );
  const requestHandlerLayer = input.interactionsEnabled
    ? AcpInteractionRequestHandlerLive.pipe(
        Layer.provide(
          Layer.merge(
            interactionLayer,
            makeInteractionSurfacePolicyLayer(promptEvents)
          )
        )
      )
    : makeRefuseAllAgentRequestsLayer(promptEvents);
  const connectionLayer = AcpConnectionLive().pipe(
    Layer.provide(
      Layer.merge(
        Layer.succeed(AcpTransport, input.transport),
        requestHandlerLayer
      )
    )
  );
  const context = yield* Layer.build(
    Layer.merge(connectionLayer, interactionLayer)
  );
  return {
    connection: Context.get(context, AcpConnection),
    interactions: Context.get(context, InteractionService),
  };
});

export {
  buildConnectionServices,
  clientCapabilitiesForInteractions,
  makeInteractionSinkLayer,
  makeInteractionSurfacePolicyLayer,
  makeRefuseAllAgentRequestsLayer,
};
export type { ActivePrompt, PromptInteractionQueueItem };
