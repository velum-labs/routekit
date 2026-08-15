import type { Scope, Fiber } from "effect";

import { Deferred, Effect, Option, Ref, Schema } from "effect";

import type { HandlerContext, SessionRefs } from "./handler/request-handlers.ts";
import type {
  CodexNativeConnection,
  CodexNativeEvent,
} from "./native/connection.ts";
import type { CodexUnknownEvent } from "./native/protocol.ts";
import type {
  CodexAskUserRequest,
  CodexKnownSessionEvent,
} from "./native/schema.ts";
import type { CodexAdapterConfig } from "./config.ts";
import type { AcpClientKnownRequest } from "../../../../contracts/internal/src/acp/protocol/profile.ts";
import type {
  AgentAdapterEvent,
  AgentAdapterObservation,
} from "../../../../contracts/internal/src/runtime/agent-adapter-event.ts";
import type { PromptTurn } from "../../../../engine/acp-adapter-kit/src/prompt-turn.ts";
import type { SessionPromptParams } from "../../../../engine/acp-adapter-kit/src/session-requests.ts";
import type {
  AcpAgentConnectionShape,
  AcpClientRequestFailure,
  AcpClientRequestHandlerShape,
} from "../../../../engine/acp-agent/src/service.ts";

import {
  createSession,
  errorMessage,
  failure,
  initializeResult,
  loadSession,
} from "./handler/request-handlers.ts";
import {
  projectAcpElicitationResult,
  projectCodexAskUser,
} from "./projection/elicitation.ts";
import { makeCodexProjector } from "./projection/projector.ts";
import { malformedNativeEventDiagnostic } from "./diagnostics.ts";
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
import { runPromptTurn } from "../../../../engine/acp-adapter-kit/src/prompt-turn.ts";
import { makeAgentEventReporter } from "../../../../engine/agent-events/src/diagnostics.ts";

const METHOD_NOT_FOUND = -32_601;
const MALFORMED_NATIVE_EVENT = "codex-native-line";
const CODEX_AGENT_LABEL = "Codex";

type CodexObservationReporter = (
  observation: AgentAdapterObservation
) => Effect.Effect<void>;

interface CodexHandlerState {
  readonly activeInteraction: Ref.Ref<Option.Option<Fiber.Fiber<void>>>;
  readonly activePrompt: Ref.Ref<
    Option.Option<PromptTurn<{ readonly message: string }>>
  >;
  readonly agent: Deferred.Deferred<AcpAgentConnectionShape>;
  readonly cancelledSessions: Ref.Ref<readonly string[]>;
  readonly native: CodexNativeConnection;
  readonly notifyUpdates: (
    sessionId: string,
    event: CodexKnownSessionEvent | CodexUnknownEvent
  ) => Effect.Effect<void, string>;
  readonly refs: SessionRefs;
  readonly report: Effect.Success<typeof makeAgentEventReporter>;
  readonly turnId: Ref.Ref<Option.Option<string>>;
}

const declineAskUser = (
  state: CodexHandlerState,
  event: CodexAskUserRequest
): Effect.Effect<void> => {
  const questionId = event.params.questions[0]?.id ?? event.params.itemId;
  return state.native
    .respondToAskUser(event.id, questionId, [])
    .pipe(Effect.ignore);
};

const handleAskUser = Effect.fn("CodexAdapter.handleAskUser")(
  function* (state: CodexHandlerState, event: CodexAskUserRequest) {
    const session = yield* Ref.get(state.refs.currentSession);
    const request = projectCodexAskUser(event, Option.getOrUndefined(session));
    if (request === undefined) {
      yield* declineAskUser(state, event);
      return;
    }
    const connection = yield* Deferred.await(state.agent);
    const params = yield* Schema.decodeUnknownEffect(
      AGENT_REQUEST_SCHEMAS["elicitation/create"]
    )(request.params);
    const result = yield* connection.request(request.method, params);
    const answers = yield* projectAcpElicitationResult(result);
    yield* state.native.respondToAskUser(event.id, request.questionId, answers);
  },
  (effect, state, event) =>
    effect.pipe(
      Effect.onInterrupt(() => declineAskUser(state, event)),
      Effect.catch((error) =>
        declineAskUser(state, event).pipe(
          Effect.andThen(
            settlePromptTurn(state.activePrompt, {
              message: errorMessage(error),
            }).pipe(Effect.ensuring(Ref.set(state.turnId, Option.none())))
          )
        )
      )
    )
);

const projectEvent = Effect.fn("CodexAdapter.projectEvent")(function* (
  state: CodexHandlerState,
  event: CodexNativeEvent
) {
  if ("_tag" in event) {
    if (event._tag === "CodexMalformedLine") {
      return yield* state.report(
        malformedNativeEventDiagnostic(MALFORMED_NATIVE_EVENT, event.detail)
      );
    }
  } else if (event.method === "turn/completed") {
    return yield* settlePromptTurn(state.activePrompt, "end_turn").pipe(
      Effect.ensuring(Ref.set(state.turnId, Option.none()))
    );
  } else if ("id" in event) {
    return yield* forkTrackedInteraction(
      state.activeInteraction,
      handleAskUser(state, event)
    );
  }
  const session = yield* Ref.get(state.refs.currentSession);
  if (Option.isNone(session)) {
    return;
  }
  yield* state
    .notifyUpdates(session.value, event)
    .pipe(Effect.mapError(errorMessage));
});

const makeRun = (
  state: CodexHandlerState
): Effect.Effect<void, never, Scope.Scope> =>
  makeNativeEventLoop({
    activePrompt: state.activePrompt,
    events: state.native.events,
    onEnded: settlePromptTurn(state.activePrompt, {
      message: "Codex connection closed before the turn completed",
    }).pipe(Effect.ensuring(Ref.set(state.turnId, Option.none()))),
    onStreamFailure: (error) => ({ message: errorMessage(error) }),
    projectEvent: (event) =>
      projectEvent(state, event).pipe(Effect.mapError(errorMessage)),
  });

const makeNativeAbort = Effect.fn("CodexAdapter.nativeAbort")(function* (
  state: CodexHandlerState
) {
  const nativeSession = yield* Ref.get(state.refs.currentNativeSession);
  const turnId = yield* Ref.get(state.turnId);
  if (Option.isNone(nativeSession) || Option.isNone(turnId)) {
    return;
  }
  yield* state.native.turnInterrupt(nativeSession.value, turnId.value);
});

const makeNativePrompt =
  (
    state: CodexHandlerState
  ): ((message: string) => Effect.Effect<void, AcpClientRequestFailure>) =>
  (message) =>
    Effect.gen(function* () {
      const nativeSession = yield* Ref.get(state.refs.currentNativeSession);
      if (Option.isNone(nativeSession)) {
        return yield* Effect.fail(failure("Codex session is not active"));
      }
      const startedTurnId = yield* state.native.turnStart(
        nativeSession.value,
        message
      );
      yield* Ref.set(state.turnId, Option.some(startedTurnId));
    }).pipe(
      Effect.asVoid,
      Effect.mapError((error) => failure(errorMessage(error)))
    );

const makeRunPrompt =
  (state: CodexHandlerState) =>
  (
    context: HandlerContext,
    params: SessionPromptParams
  ): Effect.Effect<
    {
      readonly method: "session/prompt";
      readonly result: { readonly stopReason: "cancelled" | "end_turn" };
    },
    AcpClientRequestFailure | { readonly message: string }
  > =>
    runPromptTurn({
      activePrompt: state.activePrompt,
      agentLabel: CODEX_AGENT_LABEL,
      beforeSend: () => Effect.void,
      cancelledSessions: state.cancelledSessions,
      currentSession: context.refs.currentSession,
      native: {
        abort: makeNativeAbort(state).pipe(Effect.ignore),
        prompt: makeNativePrompt(state),
      },
      params,
    });

const makeHandlerState = Effect.fn("CodexAdapter.makeHandlerState")(function* (
  native: CodexNativeConnection,
  model: CodexAdapterConfig["model"],
  input: {
    readonly reportObservation: CodexObservationReporter;
    readonly systemPrompt?: CodexAdapterConfig["systemPrompt"];
  }
) {
  const agent = yield* Deferred.make<AcpAgentConnectionShape>();
  const currentSession = yield* Ref.make<Option.Option<string>>(Option.none());
  const currentNativeSession = yield* Ref.make<Option.Option<string>>(
    Option.none()
  );
  const turnId = yield* Ref.make<Option.Option<string>>(Option.none());
  const refs: SessionRefs = {
    currentNativeSession,
    currentSession,
  };
  const activePrompt = yield* Ref.make<
    Option.Option<PromptTurn<{ readonly message: string }>>
  >(Option.none());
  const activeInteraction = yield* Ref.make<Option.Option<Fiber.Fiber<void>>>(
    Option.none()
  );
  const cancelledSessions = yield* Ref.make<readonly string[]>([]);
  const project = yield* makeCodexProjector;
  const projectWithKnownError = (
    event: CodexKnownSessionEvent | CodexUnknownEvent
  ): Effect.Effect<readonly AgentAdapterEvent[], string> =>
    project(event).pipe(
      Effect.mapError((error: unknown) => errorMessage(error))
    );
  const report = yield* makeAgentEventReporter;
  const notifyUpdates = makeNotifyUpdates({
    agent,
    project: projectWithKnownError,
    reportObservation: input.reportObservation,
    spanPrefix: "CodexAdapter",
  });
  const state: CodexHandlerState = {
    activeInteraction,
    activePrompt,
    agent,
    cancelledSessions,
    native,
    notifyUpdates: (sessionId, event) =>
      notifyUpdates(sessionId, event).pipe(
        Effect.mapError((error: unknown) => errorMessage(error))
      ),
    refs,
    report,
    turnId,
  };
  const context: HandlerContext = {
    activePrompt,
    agent,
    cancelledSessions,
    model,
    native,
    refs,
    systemPrompt: input.systemPrompt,
  };
  return {
    context,
    state,
  };
});

const makeHandleRequest =
  (state: CodexHandlerState, context: HandlerContext) =>
  (
    request: AcpClientKnownRequest
  ): ReturnType<AcpClientRequestHandlerShape["handle"]> => {
    switch (request.method) {
      case "initialize": {
        return initializeResult();
      }
      case "session/new": {
        return createSession(context, request.params);
      }
      case "session/load": {
        return loadSession(context, request.params);
      }
      case "session/prompt": {
        return makeRunPrompt(state)(context, request.params).pipe(
          Effect.mapError((error) => failure(errorMessage(error)))
        );
      }
      case "authenticate":
      case "logout":
      case "session/close":
      case "session/delete":
      case "session/list":
      case "session/resume":
      case "session/set_config_option":
      case "session/set_mode": {
        return Effect.fail(
          failure(
            `ACP method is not supported: ${request.method}`,
            METHOD_NOT_FOUND
          )
        );
      }
      default: {
        return Effect.die("Unreachable ACP client request method");
      }
    }
  };

const makeCodexAcpClientRequestHandler = Effect.fn(
  "CodexAdapter.makeClientRequestHandler"
)(function* (
  native: CodexNativeConnection,
  model: CodexAdapterConfig["model"],
  input: {
    readonly reportObservation: CodexObservationReporter;
    readonly systemPrompt?: CodexAdapterConfig["systemPrompt"];
  }
) {
  const { context, state } = yield* makeHandlerState(native, model, input);
  const { activeInteraction, activePrompt, cancelledSessions } = state;
  const handleRequest = makeHandleRequest(state, context);
  const cancelSession = makeCancelSession({
    activeInteraction,
    activePrompt,
    cancelledSessions,
    errorMessage,
    native: {
      abort: makeNativeAbort(state).pipe(Effect.ignore),
    },
  });
  return {
    bind: (connection: AcpAgentConnectionShape): Effect.Effect<void> =>
      Deferred.succeed(state.agent, connection).pipe(Effect.asVoid),
    cancelSession,
    handle: (
      request: AcpClientKnownRequest
    ): ReturnType<AcpClientRequestHandlerShape["handle"]> =>
      handleRequest(request),
    run: makeRun(state),
  };
});

export { makeCodexAcpClientRequestHandler };
export type { CodexObservationReporter };
