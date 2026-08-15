import { Clock, Context, Effect, Layer, Match, Option } from "effect";

import type { AgentRuntimeEvent as AuthorAgentRuntimeEvent } from "../../../contracts/author/src/index.ts";
import type { AgentFailure } from "../../../contracts/author/src/errors/agent-failure.ts";
import type { HarnessError } from "../../../contracts/internal/src/errors.ts";
import type { HarnessName } from "../../../contracts/internal/src/ids.ts";
import type { AgentRuntimeEvent } from "../../../contracts/internal/src/runtime/agent-runtime-event.ts";
import type {
  HarnessEventIds,
  HarnessEventState,
} from "./events.ts";
import type { RuntimeHarnessInvokeOptions } from "./options.ts";

import { agentFailure } from "../../../contracts/author/src/errors/agent-failure.ts";
import { SessionId as SessionIdSchema } from "../../../contracts/internal/src/ids.ts";
import { AgentRuntimeEventTag } from "../../../contracts/internal/src/runtime/agent-runtime-event.ts";
import {
  initialHarnessEventState,
  makeHarnessStartEvents,
  makeHarnessRuntimeEvent,
  makeRuntimeErrorEvent,
  makeTurnCompletedEvent,
  markHarnessTerminalEvent,
  withHarnessCurrentTime,
  withHarnessModel,
  withHarnessSessionId,
} from "./events.ts";
import { formatSafeErrorDiagnostic } from "../../../utils/core/src/error-formatting.ts";

interface AgentHarnessProjectionState {
  readonly failed: boolean;
  readonly harnessState: HarnessEventState;
  readonly pendingTerminal: Option.Option<PendingTerminalEvent>;
}

interface ProjectionResult {
  readonly events: readonly AgentRuntimeEvent[];
  readonly state: AgentHarnessProjectionState;
}

interface PendingTerminalEvent {
  readonly event: AuthorAgentRuntimeEvent;
  readonly harnessState: HarnessEventState;
}

// Built through `agentFailure`, not `boundAgentFailure`: the latter only
// applies the text bounds to an already-built failure, so a literal that omits
// `retryable` publishes a harness crash with no retry answer while the same
// code carries one everywhere else.
const projectionFailure = (error: HarnessError): AgentFailure =>
  Match.value(error).pipe(
    Match.tag("HarnessProcessError", (failure) =>
      agentFailure({
        code: "ORI_HARNESS_PROCESS_FAILED",
        message: "The harness process stopped before the turn completed.",
        stage: "harness",
        ...(failure.exitCode === undefined
          ? {}
          : { upstreamCode: failure.exitCode }),
      })
    ),
    Match.tag("HarnessCapabilityError", (failure) =>
      agentFailure({
        code: "ORI_HARNESS_CAPABILITY_UNSUPPORTED",
        message: failure.message,
        stage: "harness",
      })
    ),
    Match.tag("HarnessProtocolError", () =>
      agentFailure({
        code: "ORI_HARNESS_PROTOCOL_FAILED",
        message: "The harness emitted invalid protocol data.",
        stage: "harness",
      })
    ),
    Match.tag("HarnessValidationError", () =>
      agentFailure({
        code: "ORI_HARNESS_VALIDATION_FAILED",
        message: "The harness configuration is invalid.",
        stage: "harness",
      })
    ),
    Match.tag("RuntimeEnvironmentError", () =>
      agentFailure({
        code: "ORI_RUNTIME_ENVIRONMENT_FAILED",
        message: "ORI could not prepare the harness environment.",
        stage: "runtime",
      })
    ),
    Match.tag("RuntimeSecretError", () =>
      agentFailure({
        code: "ORI_RUNTIME_SECRET_FAILED",
        message: "ORI could not resolve a required harness secret.",
        stage: "runtime",
      })
    ),
    Match.exhaustive
  );

interface AgentHarnessEventProjectorShape {
  readonly fail: (
    state: AgentHarnessProjectionState,
    error: HarnessError
  ) => Effect.Effect<ProjectionResult>;
  readonly finalize: (
    state: AgentHarnessProjectionState
  ) => Effect.Effect<ProjectionResult>;
  readonly project: (
    state: AgentHarnessProjectionState,
    event: AuthorAgentRuntimeEvent
  ) => Effect.Effect<ProjectionResult>;
  readonly start: (input: {
    readonly harness: HarnessName;
    readonly ids: HarnessEventIds;
    readonly options: RuntimeHarnessInvokeOptions;
  }) => Effect.Effect<ProjectionResult>;
}

const startProjection: AgentHarnessEventProjectorShape["start"] = Effect.fn(
  "EventProjector.startProjection"
)(function* (input) {
  const currentTimeMillis = yield* Clock.currentTimeMillis;
  const initialState = withHarnessModel(
    initialHarnessEventState(input.harness, currentTimeMillis, input.ids),
    input.options.model
  );
  const harnessState = input.options.sessionId
    ? withHarnessSessionId(initialState, input.options.sessionId)
    : initialState;
  const [nextHarnessState, events] = makeHarnessStartEvents(
    harnessState,
    input.options
  );

  return {
    events,
    state: {
      failed: false,
      harnessState: nextHarnessState,
      pendingTerminal: Option.none(),
    },
  };
});

const finalizeProjection: AgentHarnessEventProjectorShape["finalize"] =
  Effect.fn("EventProjector.finalizeProjection")(function* (state) {
    if (state.failed) {
      return {
        events: [],
        state,
      };
    }

    if (Option.isSome(state.pendingTerminal)) {
      const currentTimeMillis = yield* Clock.currentTimeMillis;
      const pending = state.pendingTerminal.value;
      const terminalHarnessState = withHarnessCurrentTime(
        {
          ...pending.harnessState,
          eventSequence: state.harnessState.eventSequence,
        },
        currentTimeMillis
      );
      const [nextHarnessState, runtimeEvent] = makeHarnessRuntimeEvent(
        terminalHarnessState,
        pending.event
      );
      return {
        events: [runtimeEvent],
        state: {
          ...state,
          harnessState: markHarnessTerminalEvent(nextHarnessState),
        },
      };
    }

    const currentTimeMillis = yield* Clock.currentTimeMillis;
    const terminalState = markHarnessTerminalEvent(
      withHarnessCurrentTime(state.harnessState, currentTimeMillis)
    );
    const [nextHarnessState, turnCompleted] =
      makeTurnCompletedEvent(terminalState);

    return {
      events: [turnCompleted],
      state: {
        ...state,
        harnessState: nextHarnessState,
      },
    };
  });

const failProjection: AgentHarnessEventProjectorShape["fail"] = Effect.fn(
  "EventProjector.failProjection"
)(function* (state, error) {
  const currentTimeMillis = yield* Clock.currentTimeMillis;
  const terminalState = markHarnessTerminalEvent(
    withHarnessCurrentTime(state.harnessState, currentTimeMillis)
  );
  const failure = projectionFailure(error);
  // The mapped failure carries the code's fixed summary, so the error's own
  // chained detail ("stream failed ← inner stream") would otherwise end here:
  // it cannot ride the runtime event into Slack and the journal, and it does
  // not survive as `raw` because an Error serializes to `{}`.
  yield* Effect.logError(
    `Harness projection failed (${failure.code}): ${formatSafeErrorDiagnostic(error)}`
  );
  const [errorState, runtimeError] = makeRuntimeErrorEvent(
    terminalState,
    failure,
    error
  );
  const [completedState, turnCompleted] = makeTurnCompletedEvent(errorState, {
    failure,
    ok: false,
    raw: error,
  });

  return {
    events: [runtimeError, turnCompleted],
    state: {
      failed: true,
      harnessState: completedState,
      pendingTerminal: Option.none<PendingTerminalEvent>(),
    },
  };
});

const isTerminalAuthorRuntimeEvent = (
  event: AuthorAgentRuntimeEvent
): boolean =>
  event.type === AgentRuntimeEventTag.TurnSucceeded ||
  event.type === AgentRuntimeEventTag.TurnFailed ||
  event.type === AgentRuntimeEventTag.SessionSucceeded ||
  event.type === AgentRuntimeEventTag.SessionFailed;

const projectAuthorAgentRuntimeEvent: AgentHarnessEventProjectorShape["project"] =
  Effect.fn("EventProjector.projectAuthorAgentRuntimeEvent")(
    function* (state, event) {
      const currentTimeMillis = yield* Clock.currentTimeMillis;
      const harnessState = withHarnessCurrentTime(
        state.harnessState,
        currentTimeMillis
      );

      const sessionId =
        event.type === AgentRuntimeEventTag.SessionStarted ||
        event.type === AgentRuntimeEventTag.SessionSucceeded ||
        event.type === AgentRuntimeEventTag.SessionFailed
          ? event.payload.sessionId
          : undefined;
      const stateWithSession =
        typeof sessionId === "string" && sessionId.length > 0
          ? withHarnessSessionId(harnessState, SessionIdSchema.make(sessionId))
          : harnessState;
      if (isTerminalAuthorRuntimeEvent(event)) {
        const terminalState = markHarnessTerminalEvent(stateWithSession);
        return {
          events: [],
          state: {
            ...state,
            harnessState: terminalState,
            pendingTerminal: Option.some({
              event,
              harnessState: stateWithSession,
            }),
          },
        };
      }

      const [nextHarnessState, runtimeEvent] = makeHarnessRuntimeEvent(
        stateWithSession,
        event
      );

      return {
        events: [runtimeEvent],
        state: {
          ...state,
          harnessState: nextHarnessState,
        },
      };
    }
  );

export const makeAgentHarnessEventProjector =
  (): AgentHarnessEventProjectorShape => ({
    fail: failProjection,
    finalize: finalizeProjection,
    project: projectAuthorAgentRuntimeEvent,
    start: startProjection,
  });

export class AgentHarnessEventProjector extends Context.Service<
  AgentHarnessEventProjector,
  AgentHarnessEventProjectorShape
>()("ori/harness/AgentHarnessEventProjector") {
  static readonly layer = Layer.succeed(AgentHarnessEventProjector)(
    AgentHarnessEventProjector.of(makeAgentHarnessEventProjector())
  );
}

export type {
  AgentHarnessProjectionState,
  ProjectionResult,
  AgentHarnessEventProjectorShape,
};
