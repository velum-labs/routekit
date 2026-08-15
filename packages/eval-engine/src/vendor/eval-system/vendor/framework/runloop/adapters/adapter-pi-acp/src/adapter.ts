import type { Fiber, Scope } from "effect";

import { Deferred, Effect, Option, Ref, Schema } from "effect";

import type {
  HandlerContext,
  PromptState,
  SessionRefs,
} from "./handler/request-handlers.ts";
import type { PiNativeConnection, PiNativeEvent } from "./native/connection.ts";
import type { PiUnknownEvent } from "./native/protocol.ts";
import type { PiExtensionUiRequest, PiKnownSessionEvent } from "./native/schema.ts";
import type { PiSessionRegistry } from "./session-registry.ts";
import type { AcpClientKnownRequest } from "../../../../contracts/internal/src/acp/protocol/profile.ts";
import type { AgentAdapterObservation } from "../../../../contracts/internal/src/runtime/agent-adapter-event.ts";
import type { AcpAgentConnectionError } from "../../../../engine/acp-agent/src/errors.ts";
import type {
  AcpAgentConnectionShape,
  AcpClientRequestHandlerShape,
} from "../../../../engine/acp-agent/src/service.ts";

import {
  createSession,
  errorMessage,
  initializeResult,
  loadSession,
  resumeSession,
  runPrompt,
} from "./handler/request-handlers.ts";
import { ExtensionUiRequestKnown } from "./native/schema.ts";
import {
  PiUnsupportedBlockingEventError,
  projectAcpElicitationResult,
  projectPiElicitation,
} from "./projection/elicitation.ts";
import { handlePiPermission } from "./projection/permission.ts";
import { makePiProjector } from "./projection/projector.ts";
import {
  malformedNativeEventDiagnostic,
  unknownNativeEventDiagnostic,
} from "./diagnostics.ts";
import { AGENT_REQUEST_SCHEMAS } from "../../../../contracts/internal/src/acp/protocol/profile.ts";
import { MAX_DIAGNOSTIC_TEXT_LENGTH } from "../../../../contracts/internal/src/runtime/agent-event-diagnostic.ts";
import {
  forkTrackedInteraction,
  makeNativeEventLoop,
  makeNotifyUpdates,
} from "../../../../engine/acp-adapter-kit/src/native-event-loop.ts";
import {
  makeCancelSession,
  settlePromptTurn,
} from "../../../../engine/acp-adapter-kit/src/prompt-settlement.ts";
import { makeAcpRequestDispatcher } from "../../../../engine/acp-adapter-kit/src/request-dispatch.ts";
import { makeAgentEventReporter } from "../../../../engine/agent-events/src/diagnostics.ts";

import { closedPromptFailure } from "./closed-prompt-failure.ts";

const PI_SPAN_PREFIX = "PiAdapter";
// A malformed native line has no reliable `type` to attribute, so its
// diagnostic uses a stable category label instead of echoing the raw record.
const MALFORMED_NATIVE_EVENT = "pi-native-line";
/** Reports a Pi retry/compaction observation outside the ACP session-update
 * wire (per ROUTEKIT_EVAL-423: those observations never join `AcpSessionUpdate`). */
type PiObservationReporter = (
  observation: AgentAdapterObservation
) => Effect.Effect<void>;

interface PiHandlerState {
  readonly activeInteraction: Ref.Ref<Option.Option<Fiber.Fiber<void>>>;
  readonly activePrompt: Ref.Ref<Option.Option<PromptState>>;
  readonly agent: Deferred.Deferred<AcpAgentConnectionShape>;
  readonly cancelledSessions: Ref.Ref<readonly string[]>;
  readonly native: PiNativeConnection;
  readonly cumulativeCost: Ref.Ref<number>;
  readonly pendingFailure: Ref.Ref<Option.Option<string>>;
  readonly notifyUpdates: (
    sessionId: string,
    event: PiKnownSessionEvent | PiUnknownEvent
  ) => Effect.Effect<
    void,
    AcpAgentConnectionError | PiUnsupportedBlockingEventError
  >;
  readonly refs: SessionRefs;
  readonly report: Effect.Success<typeof makeAgentEventReporter>;
}

const handleElicitation = Effect.fn("PiAdapter.handleElicitation")(
  function* (state: PiHandlerState, event: PiExtensionUiRequest) {
    const session = yield* Ref.get(state.refs.currentSession);
    const request = yield* projectPiElicitation(
      event,
      Option.getOrUndefined(session)
    );
    if (request === undefined) {
      return;
    }
    const connection = yield* Deferred.await(state.agent);
    const params = yield* Schema.decodeUnknownEffect(
      AGENT_REQUEST_SCHEMAS["elicitation/create"]
    )(request.params);
    const result = yield* connection.request(request.method, params);
    const response = yield* projectAcpElicitationResult(
      request.dialogMethod,
      event.id,
      result
    );
    yield* state.native.respondToExtensionUi(response);
  },
  (effect, state, event) =>
    effect.pipe(
      // Cancellation interrupts this fiber mid-request; the native peer is
      // still blocked waiting for a UI response, so it must always receive a
      // terminal (cancelled) answer even when the turn is torn down.
      Effect.onInterrupt(() =>
        state.native
          .respondToExtensionUi({
            cancelled: true,
            id: event.id,
            type: "extension_ui_response",
          })
          .pipe(Effect.ignore)
      ),
      Effect.catch((error) => {
        const settleNative = state.native
          .respondToExtensionUi({
            cancelled: true,
            id: event.id,
            type: "extension_ui_response",
          })
          .pipe(Effect.ignore);
        // A blocking dialog Pi can raise but ACP cannot represent must settle
        // the native peer and surface a diagnostic without failing the turn;
        // a silently dropped blocking request is the exact failure ROUTEKIT_EVAL-423
        // forbids ("blocking UI requests cannot become ignored diagnostics").
        if (error instanceof PiUnsupportedBlockingEventError) {
          return settleNative.pipe(
            Effect.andThen(
              state.report(unknownNativeEventDiagnostic(error.nativeEvent))
            )
          );
        }
        return settleNative.pipe(
          Effect.andThen(
            settlePromptTurn(state.activePrompt, {
              message: errorMessage(error),
            })
          )
        );
      })
    )
);

type PiMessageEnd = Extract<
  PiKnownSessionEvent,
  { readonly type: "message_end" }
>["message"];

/**
 * Records how one attempt ended, without settling the turn. An error tail is
 * held for the `agent_end` verdict (Pi's own backoff may re-run the turn) and
 * reported as consumed so the abandoned attempt's output is not projected; a
 * clean tail clears the held error so a recovered turn does not inherit it.
 */
const trackAttemptOutcome = (
  state: PiHandlerState,
  message: PiMessageEnd
): Effect.Effect<boolean> =>
  message.stopReason === "error"
    ? Ref.set(
        state.pendingFailure,
        Option.some(
          message.errorMessage?.slice(0, MAX_DIAGNOSTIC_TEXT_LENGTH) ??
            "Pi assistant message failed"
        )
      ).pipe(Effect.as(true))
    : Ref.set(state.pendingFailure, Option.none()).pipe(Effect.as(false));

/**
 * Applies Pi's end-of-turn verdict. `willRetry` means Pi runs this turn again,
 * so the prompt stays in flight and the retry's outcome is what reaches the
 * caller; otherwise the turn settles, failing with any held attempt error.
 */
const settleAgentEnd = (
  state: PiHandlerState,
  willRetry: boolean | undefined
): Effect.Effect<void> =>
  willRetry === true
    ? Effect.void
    : Ref.getAndSet(state.pendingFailure, Option.none()).pipe(
        Effect.flatMap((pending) =>
          settlePromptTurn(
            state.activePrompt,
            Option.match(pending, {
              onNone: () => "end_turn" as const,
              onSome: (message) => ({ message }),
            })
          )
        )
      );

const projectEvent = Effect.fn("PiAdapter.projectEvent")(function* (
  state: PiHandlerState,
  event: PiNativeEvent
) {
  if ("_tag" in event) {
    // A malformed record is reported and dropped so a single bad line never
    // tears down the event loop; an unknown-type event falls through to the
    // session-scoped projection path, which reports it as unrecognized.
    if (event._tag === "PiMalformedLine") {
      return yield* state.report(
        malformedNativeEventDiagnostic(MALFORMED_NATIVE_EVENT, event.detail)
      );
    }
  } else {
    // An error-tailed assistant message ends the ATTEMPT, not the turn (ROUTEKIT_EVAL-869):
    // only `agent_end` reports whether Pi is done trying.
    if (event.type === "message_end" && event.message.role === "assistant") {
      const abandoned = yield* trackAttemptOutcome(state, event.message);
      if (abandoned) {
        return;
      }
    }
    if (event.type === "agent_end") {
      return yield* settleAgentEnd(state, event.willRetry);
    }
    if (event.type === "extension_ui_request") {
      const interaction = ExtensionUiRequestKnown.guards.confirm(event)
        ? handlePiPermission(
            {
              agent: state.agent,
              currentSession: state.refs.currentSession,
              native: state.native,
              onFailure: settlePromptTurn(state.activePrompt, {
                message: "Pi permission request failed",
              }),
            },
            event
          )
        : handleElicitation(state, event);
      return yield* forkTrackedInteraction(
        state.activeInteraction,
        interaction
      );
    }
  }
  const session = yield* Ref.get(state.refs.currentSession);
  if (Option.isNone(session)) {
    return;
  }
  yield* state.notifyUpdates(session.value, event);
});

const finishClosedPrompt = (state: PiHandlerState): Effect.Effect<void> =>
  state.native.getClosed.pipe(
    Effect.flatMap((closed) =>
      settlePromptTurn(state.activePrompt, closedPromptFailure(closed))
    )
  );

const makeRun = (
  state: PiHandlerState
): Effect.Effect<void, never, Scope.Scope> =>
  makeNativeEventLoop({
    activePrompt: state.activePrompt,
    events: state.native.events,
    onEnded: finishClosedPrompt(state),
    onStreamFailure: (error) => ({ message: errorMessage(error) }),
    projectEvent: (event) => projectEvent(state, event),
  });

const handleRequest = makeAcpRequestDispatcher<HandlerContext>({
  createSession,
  initializeResult: initializeResult(),
  loadSession,
  resumeSession,
  runPrompt,
});

/**
 * Allocates the adapter's mutable state. `retryEntry` and `cumulativeCost` are
 * Pi's alone — the retry rollback in `runPrompt` and the running cost the
 * projector accumulates — so this stays local to the Pi adapter rather than
 * joining the shared kit.
 */
const makePiAdapterRefs = Effect.fn("PiAdapter.makeRefs")(function* (
  sessions: PiSessionRegistry
) {
  const currentSession = yield* Ref.make<Option.Option<string>>(Option.none());
  const retryEntry = yield* Ref.make<
    Option.Option<{
      readonly entryId: string;
      readonly prompt: string;
      readonly sessionId: string;
    }>
  >(Option.none());
  const cumulativeCost = yield* Ref.make(0);
  const refs: SessionRefs = {
    currentSession,
    cumulativeCost,
    retryEntry,
    sessions,
  };
  const activePrompt = yield* Ref.make<Option.Option<PromptState>>(
    Option.none()
  );
  const activeInteraction = yield* Ref.make<Option.Option<Fiber.Fiber<void>>>(
    Option.none()
  );
  const cancelledSessions = yield* Ref.make<readonly string[]>([]);
  const pendingFailure = yield* Ref.make<Option.Option<string>>(Option.none());
  return {
    activeInteraction,
    activePrompt,
    cancelledSessions,
    cumulativeCost,
    pendingFailure,
    refs,
  };
});

const makePiAcpClientRequestHandler = Effect.fn(
  "PiAdapter.makeClientRequestHandler"
)(function* (
  native: PiNativeConnection,
  reportObservation: PiObservationReporter,
  sessions: PiSessionRegistry
) {
  const agent = yield* Deferred.make<AcpAgentConnectionShape>();
  const {
    activeInteraction,
    activePrompt,
    cancelledSessions,
    cumulativeCost,
    pendingFailure,
    refs,
  } = yield* makePiAdapterRefs(sessions);
  const project = yield* makePiProjector;
  const report = yield* makeAgentEventReporter;

  const state: PiHandlerState = {
    activeInteraction,
    activePrompt,
    agent,
    cancelledSessions,
    cumulativeCost,
    native,
    notifyUpdates: makeNotifyUpdates({
      agent,
      project: (event) => project(event, cumulativeCost),
      reportObservation,
      spanPrefix: PI_SPAN_PREFIX,
    }),
    pendingFailure,
    refs,
    report,
  };

  const context: HandlerContext = {
    activePrompt,
    agent,
    cancelledSessions,
    native,
    report,
    refs,
  };

  const cancelSession = makeCancelSession({
    activeInteraction,
    activePrompt,
    cancelledSessions,
    errorMessage,
    native,
  });

  return {
    bind: (connection: AcpAgentConnectionShape): Effect.Effect<void> =>
      Deferred.succeed(agent, connection).pipe(Effect.asVoid),
    cancelSession,
    handle: (
      request: AcpClientKnownRequest
    ): ReturnType<AcpClientRequestHandlerShape["handle"]> =>
      handleRequest(context, request),
    run: makeRun(state),
  };
});

export { makePiAcpClientRequestHandler };
export type { PiObservationReporter };
