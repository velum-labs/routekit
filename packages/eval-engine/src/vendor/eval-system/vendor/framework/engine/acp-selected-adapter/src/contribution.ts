import type { Scope } from "effect";

import {
  Cause,
  Effect,
  Filter,
  Layer,
  Option,
  Queue,
  Ref,
  Stream,
} from "effect";

import type { AgentRuntimeEvent } from "../../../contracts/author/src/agent-event.ts";
import type { AcpAgentKnownNotification } from "../../../contracts/internal/src/acp/protocol/profile.ts";
import type { HarnessName } from "../../../contracts/internal/src/ids.ts";
import type { AcpConnectionError } from "../../acp-client/src/errors.ts";
import type {
  AcpConnectionShape,
  AcpInitializeParams,
} from "../../acp-client/src/service.ts";
import type { AcpTransportShape } from "../../acp-client/src/transport.ts";
import type { InteractionError } from "../../interaction/src/errors.ts";
import type { InteractionServiceShape } from "../../interaction/src/service.ts";
import type {
  SelectedAdapterContribution,
  SelectedAdapterEvent,
  SelectedAdapterInteractionResponse,
  SelectedAdapterOptions,
} from "../../selected-adapter/src/inventory.ts";

import { agentFailure } from "../../../contracts/author/src/errors/agent-failure.ts";
import { isMissingSessionMessage } from "../../../contracts/author/src/errors/harness-message-classification.ts";
import { InteractionCorrelationId } from "../../interaction/src/model.ts";
import {
  SelectedAdapter,
  SelectedAdapterError,
} from "../../selected-adapter/src/inventory.ts";

import type {
  ActivePrompt,
  PromptInteractionQueueItem,
} from "./connection-services.ts";

import { makeAcpConnectionErrorMapper } from "./connection-failure.ts";
import {
  buildConnectionServices,
  clientCapabilitiesForInteractions,
} from "./connection-services.ts";
import { initializeConnectionOnce } from "./initialize.ts";
import { resumeSessionRequest, sessionLoadSetup } from "./session-setup.ts";

/**
 * A spawned ACP peer's transport and teardown. The shared factory turns each
 * harness's `makePeer` result into a `SelectedAdapter` the coordinator can drive.
 */
interface AcpPeer {
  readonly transport: AcpTransportShape;
  readonly terminate: Effect.Effect<void>;
}

/**
 * Everything the harness-agnostic ACP contribution factory needs. `makePeer`
 * is the only harness-specific seam: it spawns the harness process, wires the
 * native-to-ACP bridge, and returns the client-side transport plus teardown.
 * `PeerError` is inferred from `makePeer`; the factory normalizes any failure
 * (typed or defect) into a `SelectedAdapterError`, so callers never widen it.
 */
interface AcpSelectedAdapterContributionConfig<PeerError> {
  readonly name: HarnessName;
  readonly displayName: string;
  readonly makePeer: (
    options: SelectedAdapterOptions
  ) => Effect.Effect<AcpPeer, PeerError, Scope.Scope>;
  readonly interactionsEnabled?: (options: SelectedAdapterOptions) => boolean;
}

/**
 * Anything that went wrong building the adapter. Classified here because this
 * is a boundary: without it a stale resume raised during construction arrives
 * as `ROUTEKIT_EVAL_ADAPTER_INVALID_STATE`, and the retry that would have started a fresh
 * session keys off `ROUTEKIT_EVAL_SESSION_NOT_FOUND` and never fires.
 */
const mapContributionFailure = (
  cause: Cause.Cause<unknown>
): SelectedAdapterError => {
  const detail = Cause.pretty(cause);
  return new SelectedAdapterError({
    detail,
    reason: "invalid-state",
    ...(isMissingSessionMessage(detail)
      ? {
          safeFailure: agentFailure({
            code: "ROUTEKIT_EVAL_SESSION_NOT_FOUND",
            message: "The requested session could not be resumed.",
            remediation: "Start a new session instead of resuming this one.",
            stage: "adapter",
          }),
        }
      : {}),
  });
};

const describeInteractionError = (error: InteractionError): string => {
  if (error._tag === "InteractionInvalidResponseError") {
    return error.detail;
  }
  if (error._tag === "InteractionNotPendingError") {
    return `${error._tag}: ${error.reason}`;
  }
  return `${error._tag}: ${error.scope} capacity ${error.capacity}`;
};

const mapInteractionError = (error: InteractionError): SelectedAdapterError =>
  new SelectedAdapterError({
    detail: describeInteractionError(error),
    reason: "invalid-state",
  });

const respondToInteraction = (
  interactions: InteractionServiceShape,
  input: SelectedAdapterInteractionResponse
): Effect.Effect<void, SelectedAdapterError> => {
  const correlationId = InteractionCorrelationId.make(input.correlationId);
  if (input.kind === "elicitation") {
    return interactions
      .respondElicitation(correlationId, input.response)
      .pipe(Effect.mapError(mapInteractionError));
  }
  return (
    input.response.outcome === "cancelled"
      ? interactions.respondPermission(correlationId, input.response)
      : interactions.respondPermissionKind(
          correlationId,
          input.response.optionKind
        )
  ).pipe(Effect.mapError(mapInteractionError));
};

interface PromptStreamInput {
  readonly activePrompt: Ref.Ref<Option.Option<ActivePrompt>>;
  readonly activeSessionId: Ref.Ref<Option.Option<string>>;
  readonly interactionSurface: boolean;
  readonly interactionEvents: Queue.Queue<PromptInteractionQueueItem>;
  readonly mapConnectionError: (
    error: AcpConnectionError
  ) => SelectedAdapterError;
  readonly notifications: Stream.Stream<
    AcpAgentKnownNotification,
    AcpConnectionError
  >;
  readonly sessionId: string;
}

/** @internal */
export const releasePromptLease = (
  current: Option.Option<ActivePrompt>,
  promptId: symbol
): Option.Option<ActivePrompt> =>
  Option.match(current, {
    onNone: () => current,
    onSome: (activePrompt) =>
      activePrompt.promptId === promptId ? Option.none() : current,
  });

const makeSessionUpdateStream = (
  input: PromptStreamInput
): Stream.Stream<SelectedAdapterEvent, AcpConnectionError> =>
  input.notifications.pipe(
    Stream.filterMap(
      Filter.fromPredicateOption((notification) =>
        notification.method === "session/update" &&
        notification.params.sessionId === input.sessionId
          ? Option.some<SelectedAdapterEvent>({
              event: "acp.session_update",
              update: notification.params.update,
            })
          : Option.none()
      )
    )
  );

/** @internal */
export const makeInteractionEventStream = (
  interactionEvents: Queue.Dequeue<PromptInteractionQueueItem>,
  promptId: symbol
): Stream.Stream<SelectedAdapterEvent> =>
  Stream.fromQueue(interactionEvents).pipe(
    Stream.filter((item) => item.promptId === promptId),
    Stream.takeWhile(
      (
        item
      ): item is Extract<
        PromptInteractionQueueItem,
        { readonly event: AgentRuntimeEvent }
      > => "event" in item
    ),
    Stream.map((item) => ({
      event: item.event,
      type: "runtime-event" as const,
    }))
  );

const mapPromptError = (
  input: PromptStreamInput,
  error: SelectedAdapterError | AcpConnectionError
): SelectedAdapterError =>
  error._tag === "SelectedAdapterError"
    ? error
    : input.mapConnectionError(error);

const buildSelectedAdapterPromptStream = (
  input: PromptStreamInput
): Stream.Stream<SelectedAdapterEvent, SelectedAdapterError> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const promptId = Symbol("prompt");
      const claimed = yield* Ref.modify(input.activePrompt, (current) =>
        Option.isSome(current)
          ? [false, current]
          : [
              true,
              Option.some({
                interactionSurface: input.interactionSurface,
                promptId,
              }),
            ]
      );
      if (!claimed) {
        return yield* new SelectedAdapterError({
          detail: "The ACP connection already has an active prompt",
          reason: "invalid-state",
        });
      }
      yield* Ref.set(input.activeSessionId, Option.some(input.sessionId));
      return makeSessionUpdateStream(input).pipe(
        Stream.ensuring(
          Queue.offer(input.interactionEvents, {
            done: true,
            promptId,
          })
        ),
        Stream.merge(
          makeInteractionEventStream(input.interactionEvents, promptId),
          { haltStrategy: "both" }
        ),
        Stream.ensuring(
          Ref.update(input.activePrompt, (current) =>
            releasePromptLease(current, promptId)
          )
        )
      );
    })
  ).pipe(Stream.mapError((error) => mapPromptError(input, error)));

interface SelectedAdapterFromConnectionInput {
  readonly clientCapabilities: NonNullable<
    AcpInitializeParams["clientCapabilities"]
  >;
  readonly connection: AcpConnectionShape;
  readonly cwd: string;
  readonly activePrompt: Ref.Ref<Option.Option<ActivePrompt>>;
  readonly activeSessionId: Ref.Ref<Option.Option<string>>;
  readonly interactionEvents: Queue.Queue<PromptInteractionQueueItem>;
  readonly interactions: InteractionServiceShape;
  readonly mapConnectionError: (
    error: AcpConnectionError
  ) => SelectedAdapterError;
}

const makeSelectedAdapterFromConnection = (
  input: SelectedAdapterFromConnectionInput
): SelectedAdapter["Service"] => {
  const { activeSessionId, connection, cwd, mapConnectionError } = input;
  return {
    cancel: Ref.get(activeSessionId).pipe(
      Effect.flatMap((current) =>
        Option.match(current, {
          onNone: () => Effect.void,
          onSome: (sessionId) =>
            connection.notify("session/cancel", { sessionId }),
        })
      ),
      Effect.mapError(mapConnectionError)
    ),
    createSession: (sessionInput) =>
      connection
        .request("session/new", {
          cwd: sessionInput.cwd,
          mcpServers: [],
        })
        .pipe(
          Effect.map((result) => result.sessionId),
          Effect.mapError(mapConnectionError)
        ),
    initialize: initializeConnectionOnce(
      connection,
      input.clientCapabilities
    ).pipe(Effect.mapError(mapConnectionError)),
    loadSession: (sessionId) =>
      connection
        .requestNotifications("session/load", sessionLoadSetup(cwd, sessionId))
        .pipe(Stream.runDrain, Effect.mapError(mapConnectionError)),
    // `session/resume` is not a notification-producing method, so it stays a
    // plain request. Draining is only needed where the agent streams while the
    // request is still open.
    resumeSession: (sessionId) =>
      resumeSessionRequest(connection, mapConnectionError, {
        cwd,
        sessionId,
      }),
    prompt: (promptInput: {
      readonly interactionSurface?: boolean | undefined;
      readonly prompt: string;
      readonly sessionId: string;
    }): Stream.Stream<SelectedAdapterEvent, SelectedAdapterError> =>
      buildSelectedAdapterPromptStream({
        activePrompt: input.activePrompt,
        activeSessionId,
        interactionSurface: promptInput.interactionSurface === true,
        interactionEvents: input.interactionEvents,
        mapConnectionError,
        notifications: connection.requestNotifications("session/prompt", {
          prompt: [
            {
              text: promptInput.prompt,
              type: "text",
            },
          ],
          sessionId: promptInput.sessionId,
        }),
        sessionId: promptInput.sessionId,
      }),
    respondInteraction: (response) =>
      respondToInteraction(input.interactions, response),
  };
};

const makeAcpSelectedAdapterContribution = <PeerError>(
  config: AcpSelectedAdapterContributionConfig<PeerError>
): SelectedAdapterContribution => {
  const mapConnectionError = makeAcpConnectionErrorMapper(config.displayName);
  return {
    layer: (options): Layer.Layer<SelectedAdapter, SelectedAdapterError> =>
      Layer.effect(SelectedAdapter)(
        Effect.gen(function* () {
          const peer = yield* config.makePeer(options);
          yield* Effect.addFinalizer(() => peer.terminate);
          const interactionEvents =
            yield* Queue.unbounded<PromptInteractionQueueItem>();
          const activePrompt = yield* Ref.make<Option.Option<ActivePrompt>>(
            Option.none()
          );
          const interactionsEnabled =
            config.interactionsEnabled?.(options) ?? false;
          const { connection, interactions } = yield* buildConnectionServices({
            activePrompt,
            interactionsEnabled,
            interactionEvents,
            transport: peer.transport,
          });
          const activeSessionId = yield* Ref.make<Option.Option<string>>(
            Option.none()
          );
          return makeSelectedAdapterFromConnection({
            activePrompt,
            activeSessionId,
            connection,
            clientCapabilities:
              clientCapabilitiesForInteractions(interactionsEnabled),
            cwd: options.cwd,
            interactionEvents,
            interactions,
            mapConnectionError,
          });
        })
      ).pipe(
        Layer.catchCause((cause) =>
          Layer.effect(SelectedAdapter)(
            Effect.fail(mapContributionFailure(cause))
          )
        )
      ),
    name: config.name,
  };
};

export {
  makeAcpSelectedAdapterContribution,
  makeSelectedAdapterFromConnection,
};
export type {
  AcpPeer,
  AcpSelectedAdapterContributionConfig,
  PromptInteractionQueueItem,
};
