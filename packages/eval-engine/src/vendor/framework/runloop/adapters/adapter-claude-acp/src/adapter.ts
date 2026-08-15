import type { Fiber, Scope } from "effect";

import { Deferred, Effect, Option, Ref, Schema } from "effect";

import type {
  HandlerContext,
  PromptState,
  SessionRefs,
} from "./handler/request-handlers.ts";
import type {
  ClaudeNativeConnection,
  ClaudeNativeEvent,
} from "./native/connection.ts";
import type { ClaudeUnknownEvent } from "./native/protocol.ts";
import type { ClaudeControlRequest, ClaudeInbound } from "./native/schema.ts";
import type { ClaudeSessionRegistry } from "./session-registry.ts";
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
import {
  ClaudeUnsupportedElicitationError,
  projectAcpElicitationResult,
  projectClaudeElicitation,
} from "./projection/elicitation.ts";
import { makeClaudeProjector } from "./projection/projector.ts";
import {
  malformedNativeEventDiagnostic,
  unknownNativeEventDiagnostic,
} from "./diagnostics.ts";
import { makeClaudeSessionRegistry } from "./session-registry.ts";
import { AGENT_REQUEST_SCHEMAS } from "../../../../contracts/internal/src/acp/protocol/profile.ts";
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

const CLAUDE_SPAN_PREFIX = "ClaudeAdapter";
// A malformed native line has no reliable `type` to attribute, so its
// diagnostic uses a stable category label instead of echoing the raw record.
const MALFORMED_NATIVE_EVENT = "claude-native-line";

/** Reports a Claude retry/compaction observation outside the ACP session-update
 * wire (per ORI-405/423: those observations never join `AcpSessionUpdate`). */
type ClaudeObservationReporter = (
  observation: AgentAdapterObservation
) => Effect.Effect<void>;

interface ClaudeHandlerState {
  readonly activeInteraction: Ref.Ref<Option.Option<Fiber.Fiber<void>>>;
  readonly activePrompt: Ref.Ref<Option.Option<PromptState>>;
  readonly agent: Deferred.Deferred<AcpAgentConnectionShape>;
  readonly cancelledSessions: Ref.Ref<readonly string[]>;
  readonly native: ClaudeNativeConnection;
  readonly notifyUpdates: (
    sessionId: string,
    event: ClaudeInbound | ClaudeUnknownEvent
  ) => Effect.Effect<
    void,
    AcpAgentConnectionError | ClaudeUnsupportedElicitationError
  >;
  readonly refs: SessionRefs;
  readonly report: Effect.Success<typeof makeAgentEventReporter>;
}

// Answers Claude's blocking AskUserQuestion control_request with a single
// cancelled control_response. Ignored so a broken native connection never
// turns a terminal answer into an adapter failure.
const deliverCancelled = (
  state: ClaudeHandlerState,
  requestId: string
): Effect.Effect<void> =>
  state.native
    .respondToAskUser({
      request_id: requestId,
      response: { subtype: "cancelled" },
      type: "control_response",
    })
    .pipe(Effect.ignore);

// Correlates one AskUserQuestion control_request to an ACP elicitation/create
// round trip and delivers exactly one control_response. Unsupported native
// requests are answered cancelled and surfaced as a diagnostic without failing
// the active turn.
const handleElicitation = Effect.fn("ClaudeAdapter.handleElicitation")(
  function* (state: ClaudeHandlerState, event: ClaudeControlRequest) {
    const session = yield* Ref.get(state.refs.currentSession);
    const request = yield* projectClaudeElicitation(
      event,
      Option.getOrUndefined(session)
    );
    const connection = yield* Deferred.await(state.agent);
    const params = yield* Schema.decodeUnknownEffect(
      AGENT_REQUEST_SCHEMAS["elicitation/create"]
    )(request.params);
    const result = yield* connection.request(request.method, params);
    const response = yield* projectAcpElicitationResult(
      event.request_id,
      result
    );
    // A real answer was produced: attempt exactly one delivery and never a
    // cancelled fallback. If delivery fails, fail the waiting prompt with the
    // typed detail so it settles instead of hanging (no owner retries a single
    // send).
    yield* state.native.respondToAskUser(response).pipe(
      Effect.catch((error) =>
        settlePromptTurn(state.activePrompt, {
          message: `Claude elicitation response delivery failed: ${errorMessage(error)}`,
        })
      )
    );
  },
  (effect, state, event) =>
    effect.pipe(
      // Cancellation interrupts this fiber mid-request; Claude's peer is still
      // blocked on the AskUserQuestion control_request, so it must always
      // receive a terminal (cancelled) answer even when the turn is torn down.
      Effect.onInterrupt(() => deliverCancelled(state, event.request_id)),
      // Reached only for failures BEFORE a real answer is produced (a delivery
      // failure is already handled above). A control_request ACP cannot
      // represent as a form settles the native peer cancelled and is surfaced
      // as a diagnostic without failing the turn; every other pre-answer
      // failure settles cancelled and fails the waiting prompt with the typed
      // detail so it never hangs.
      Effect.catch((error) => {
        if (error instanceof ClaudeUnsupportedElicitationError) {
          return deliverCancelled(state, event.request_id).pipe(
            Effect.andThen(
              state.report(unknownNativeEventDiagnostic(error.nativeEvent))
            )
          );
        }
        return deliverCancelled(state, event.request_id).pipe(
          Effect.andThen(
            settlePromptTurn(state.activePrompt, {
              message: errorMessage(error),
            })
          )
        );
      })
    )
);

const projectEvent = Effect.fn("ClaudeAdapter.projectEvent")(function* (
  state: ClaudeHandlerState,
  event: ClaudeNativeEvent
) {
  if ("_tag" in event) {
    // A malformed record is reported and dropped so one bad line never tears
    // down the event loop; an unknown-type event falls through to the projection
    // path, which reports it as unrecognized.
    if (event._tag === "ClaudeMalformedLine") {
      return yield* state.report(
        malformedNativeEventDiagnostic(MALFORMED_NATIVE_EVENT, event.detail)
      );
    }
  } else {
    if (event.type === "agent_end") {
      return yield* settlePromptTurn(state.activePrompt, "end_turn");
    }
    if (event.type === "control_request") {
      return yield* forkTrackedInteraction(
        state.activeInteraction,
        handleElicitation(state, event)
      );
    }
  }
  const session = yield* Ref.get(state.refs.currentSession);
  if (Option.isNone(session)) {
    return;
  }
  yield* state.notifyUpdates(session.value, event);
});

const makeRun = (
  state: ClaudeHandlerState
): Effect.Effect<void, never, Scope.Scope> =>
  makeNativeEventLoop({
    activePrompt: state.activePrompt,
    events: state.native.events,
    onEnded: settlePromptTurn(state.activePrompt, {
      message: "Claude native event stream ended",
    }),
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

const makeClaudeAcpClientRequestHandler = Effect.fn(
  "ClaudeAdapter.makeClientRequestHandler"
)(function* (
  native: ClaudeNativeConnection,
  reportObservation: ClaudeObservationReporter,
  sessions: ClaudeSessionRegistry = makeClaudeSessionRegistry()
) {
  const agent = yield* Deferred.make<AcpAgentConnectionShape>();
  const currentSession = yield* Ref.make<Option.Option<string>>(Option.none());
  const refs: SessionRefs = {
    currentSession,
    sessions,
  };
  const activePrompt = yield* Ref.make<Option.Option<PromptState>>(
    Option.none()
  );
  const activeInteraction = yield* Ref.make<Option.Option<Fiber.Fiber<void>>>(
    Option.none()
  );
  const cancelledSessions = yield* Ref.make<readonly string[]>([]);
  const project = yield* makeClaudeProjector;
  const report = yield* makeAgentEventReporter;

  const state: ClaudeHandlerState = {
    activeInteraction,
    activePrompt,
    agent,
    cancelledSessions,
    native,
    notifyUpdates: makeNotifyUpdates({
      agent,
      project,
      reportObservation,
      spanPrefix: CLAUDE_SPAN_PREFIX,
    }),
    refs,
    report,
  };

  const context: HandlerContext = {
    activePrompt,
    agent,
    cancelledSessions,
    native,
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

export { makeClaudeAcpClientRequestHandler };
export type { ClaudeObservationReporter };
