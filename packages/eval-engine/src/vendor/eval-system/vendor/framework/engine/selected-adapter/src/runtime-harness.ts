import { Clock, Crypto, Effect, Option, Schema, Stream } from "effect";

import type { AgentRuntimeEvent as AuthorAgentRuntimeEvent } from "../../../contracts/author/src/agent-event.ts";
import type { AgentFailureCode } from "../../../contracts/author/src/errors/agent-failure-codes.ts";
import type { RuntimeUsage } from "../../../contracts/author/src/agent-usage.ts";
import type { HarnessName, SessionId } from "../../../contracts/internal/src/ids.ts";
import type { AgentRuntimeEvent } from "../../../contracts/internal/src/runtime/agent-runtime-event.ts";
import type {
  RuntimeHarnessCompactionOptions,
  RuntimeHarnessInvokeOptions,
} from "../../harness/src/options.ts";
import type { RuntimeHarness } from "../../harness/src/runtime-harness.ts";

import { AgentRuntimeEventTag } from "../../../contracts/author/src/agent-event.ts";
import {
  agentFailure,
  boundAgentFailure,
} from "../../../contracts/author/src/errors/agent-failure.ts";
import { HarnessProtocolError } from "../../../contracts/internal/src/errors.ts";
import {
  HarnessName as HarnessNameSchema,
  SessionId as SessionIdSchema,
} from "../../../contracts/internal/src/ids.ts";
import { RuntimeUsageSchema } from "../../../contracts/internal/src/runtime/agent-runtime-event.ts";
import {
  RuntimeUsageItemType,
  RuntimeUsageReport,
} from "../../../contracts/internal/src/runtime/agent-session-item.ts";
import { projectAgentAdapterEventsUnpublished } from "../../events/src/runtime-projection.ts";
import {
  initialHarnessEventState,
  makeHarnessEventIds,
  makeHarnessRuntimeEvent,
  makeHarnessStartEvents,
  makeSessionStartedEvent,
  makeTurnCompletedEvent,
  markHarnessTerminalEvent,
  withHarnessCurrentTime,
  withHarnessModel,
  withHarnessSessionId,
  withHarnessUsage,
} from "../../harness/src/events.ts";
import {
  MissingSessionOwnershipError,
  SelectedAdapterError,
} from "./inventory.ts";
import { formatSafeErrorDiagnostic } from "../../../utils/core/src/error-formatting.ts";

import type {
  SelectedAdapterCoordinatorShape,
  SelectedAdapterOutputType,
} from "./coordinator.ts";
import type { SelectedAdapterPrepare } from "./inventory.ts";

interface SelectedAdapterHarnessContribution {
  readonly adapter: string;
  readonly compactionPrompt?: string | undefined;
  readonly defaultModel?: string | undefined;
  readonly name: string;
  readonly telemetryId?: RuntimeHarness["telemetryId"];
  /** Optional: an adapter that owns its own launch plan needs none supplied. */
  readonly prepare?: SelectedAdapterPrepare | undefined;
}

type HarnessEventState = ReturnType<typeof initialHarnessEventState>;

const runtimeUsageFromEvents = (
  events: readonly AgentRuntimeEvent[]
): RuntimeUsage | undefined => {
  for (const event of events) {
    if (
      event.type !== AgentRuntimeEventTag.ItemCompleted ||
      event.payload.itemType !== RuntimeUsageItemType
    ) {
      continue;
    }
    const report = Schema.decodeUnknownOption(RuntimeUsageReport)(
      event.payload.data
    );
    if (Option.isSome(report)) {
      return report.value.usage;
    }
  }
  return undefined;
};

const isTerminalEventType = (type: string): boolean =>
  type === AgentRuntimeEventTag.TurnFailed ||
  type === AgentRuntimeEventTag.TurnSucceeded ||
  type === AgentRuntimeEventTag.SessionFailed ||
  type === AgentRuntimeEventTag.SessionSucceeded;

const isTerminalOutput = (output: SelectedAdapterOutputType): boolean =>
  output.type === "runtime-event" && isTerminalEventType(output.event.type);

const ADAPTER_REASON_CODES: Record<
  SelectedAdapterError["reason"],
  AgentFailureCode
> = {
  connection: "ROUTEKIT_EVAL_ADAPTER_CONNECTION",
  "invalid-state": "ROUTEKIT_EVAL_ADAPTER_INVALID_STATE",
  "malformed-input": "ROUTEKIT_EVAL_ADAPTER_MALFORMED_INPUT",
  "peer-exit": "ROUTEKIT_EVAL_ADAPTER_PEER_EXIT",
};

const terminalFailureOutput = (
  error: SelectedAdapterError
): SelectedAdapterOutputType => ({
  event: {
    payload: {
      failure: boundAgentFailure(
        error.safeFailure ??
          agentFailure({
            code: ADAPTER_REASON_CODES[error.reason],
            stage: "adapter",
          })
      ),
    },
    type: AgentRuntimeEventTag.TurnFailed,
  },
  type: "runtime-event",
});

const coordinatorFailureOutput = (
  error: SelectedAdapterError | MissingSessionOwnershipError
): SelectedAdapterOutputType => {
  if (Schema.is(MissingSessionOwnershipError)(error)) {
    return terminalFailureOutput(
      new SelectedAdapterError({
        detail: error.message,
        reason: "malformed-input",
        safeFailure: agentFailure({
          code: "ROUTEKIT_EVAL_SESSION_NOT_FOUND",
          message: "ROUTEKIT_EVAL could not find the session requested for resume.",
          remediation: "Start a new session or choose an existing session.",
          stage: "adapter",
        }),
      })
    );
  }
  return terminalFailureOutput(error);
};

// A turn terminal must report the usage the turn accumulated, so rebuild it
// from state through the same builder the synthetic `completeTurn` uses instead
// of forwarding the adapter's bare payload. `terminalFailureOutput` runs inside
// `Stream.catch`, upstream of the accumulator, so it cannot see the usage
// itself — filling it in here is the only place that can (ROUTEKIT_EVAL-969).
// Only a TURN-level terminal is rebuilt (and suppresses the synthetic one). A
// session-level terminal ends the output stream but says nothing about the
// turn, and turn accounting downstream counts `turn.succeeded`, so claiming it
// here would drop the turn from the session's completed count.
// Accumulated state DELIBERATELY outranks an adapter-supplied `usage`: the
// harness sees every round, an adapter only sees what it chose to attach.
const turnTerminalFromOutput = (
  state: HarnessEventState,
  event: AuthorAgentRuntimeEvent
): readonly [HarnessEventState, AgentRuntimeEvent] | undefined => {
  if (event.type === AgentRuntimeEventTag.TurnSucceeded) {
    return makeTurnCompletedEvent(state, { raw: event.raw });
  }
  if (event.type === AgentRuntimeEventTag.TurnFailed) {
    return makeTurnCompletedEvent(state, {
      failure: event.payload.failure,
      ok: false,
      raw: event.raw,
    });
  }
  return undefined;
};

/**
 * The adapter's `detail` is peer text ROUTEKIT_EVAL did not author, so it is redacted on
 * the way to the log. A peer is free to put a signed URL, a bearer token, or
 * its own request id in the message it hands back, and the log is the one place
 * this text is allowed to land at all.
 */
const describeCoordinatorError = (cause: unknown): string =>
  formatSafeErrorDiagnostic(
    Schema.is(SelectedAdapterError)(cause) ? cause.detail : cause
  );

/**
 * Emit the terminal failure event, and put the adapter's own detail in the
 * local log on the way past.
 *
 * That detail cannot ride on the runtime event, which crosses into Slack and
 * the journal, yet it is the only text naming which of a dozen connection
 * faults occurred. Logging it is the difference between a debuggable failure
 * and "the adapter connection failed".
 */
const loggedCoordinatorFailure = (
  name: HarnessName,
  error: SelectedAdapterError | MissingSessionOwnershipError
): Stream.Stream<SelectedAdapterOutputType> =>
  Stream.unwrap(
    Effect.as(
      Effect.logError(
        `Selected adapter ${name} failed: ${describeCoordinatorError(error)}`
      ),
      Stream.succeed(coordinatorFailureOutput(error))
    )
  );

// Projects one adapter output into runtime events, threading the harness event
// state as the accumulator. A `session-started` output advances the state; a
// `session-update` leaves it unchanged and emits the projected events.
const projectOutput = Effect.fn("SelectedAdapterRuntimeHarness.projectOutput")(
  function* (input: {
    readonly contextWindow?: number | undefined;
    readonly crypto: Crypto.Crypto;
    readonly name: HarnessName;
    readonly output: SelectedAdapterOutputType;
    readonly state: HarnessEventState;
  }) {
    if (input.output.type === "session-started") {
      const sessionId = SessionIdSchema.make(input.output.sessionId);
      const [next, event] = makeSessionStartedEvent(
        withHarnessSessionId(input.state, sessionId),
        sessionId,
        input.output
      );
      return [next, [event]] as const;
    }
    if (input.output.type === "runtime-event") {
      const turnTerminal = turnTerminalFromOutput(
        input.state,
        input.output.event
      );
      if (turnTerminal !== undefined) {
        const [next, event] = turnTerminal;
        return [markHarnessTerminalEvent(next), [event]] as const;
      }
      const [next, event] = makeHarnessRuntimeEvent(
        input.state,
        input.output.event
      );
      return [next, [event]] as const;
    }
    const events = yield* projectAgentAdapterEventsUnpublished(
      Stream.make(input.output.update),
      {
        contextWindow: input.contextWindow,
        harness: input.name,
        model: input.state.model,
        runId: input.state.runId,
        sessionId: input.state.sessionId,
        turnId: input.state.turnId,
      }
    ).pipe(
      Stream.runCollect,
      Effect.provideService(Crypto.Crypto, input.crypto)
    );
    const runtimeUsage = runtimeUsageFromEvents(events);
    const nextState = Schema.is(RuntimeUsageSchema)(runtimeUsage)
      ? withHarnessUsage(input.state, runtimeUsage)
      : input.state;
    return [nextState, [...events]] as const;
  }
);

// Emits the terminal turn-completed event from the final accumulated state, run
// when the adapter output stream halts so the completion timestamp reflects the
// end of the turn.
const completeTurn = Effect.fn("SelectedAdapterRuntimeHarness.completeTurn")(
  function* (state: HarnessEventState) {
    if (state.emittedTerminalEvent) {
      return [state, []] as const;
    }
    const now = yield* Clock.currentTimeMillis;
    const [next, event] = makeTurnCompletedEvent(
      withHarnessCurrentTime(state, now)
    );
    return [next, [event]] as const;
  }
);

// Projects the adapter output stream plus a trailing terminal turn into runtime
// events. `Stream.mapAccumEffect` carries `HarnessEventState` as private
// accumulator state (no external `Ref`); an `Option.none` sentinel appended
// after the outputs drives the two-stage terminal-turn completion using the
// final state.
const makeAdapterEventStream = (input: {
  readonly adapter: HarnessName;
  readonly coordinator: SelectedAdapterCoordinatorShape;
  readonly crypto: Crypto.Crypto;
  readonly initialState: HarnessEventState;
  readonly name: HarnessName;
  readonly options: RuntimeHarnessInvokeOptions;
  readonly prepare?: SelectedAdapterPrepare | undefined;
}): Stream.Stream<AgentRuntimeEvent, HarnessProtocolError> =>
  input.coordinator
    .invoke({
      cancelState: input.options.cancelState,
      cancelSignal: input.options.cancelSignal,
      contextWindow: input.options.contextWindow,
      cwd: input.options.cwd ?? ".",
      env: input.options.env,
      extraSkillDirs: input.options.extraSkillDirs,
      parameters: input.options.parameters,
      harness: input.adapter,
      interactionSurface: input.options.interactionSurface,
      model: input.options.model,
      prepare: input.prepare,
      prompt: input.options.prompt,
      sessionId: input.options.sessionId,
      systemPrompt: input.options.systemPrompt,
    })
    .pipe(
      Stream.catch((error) =>
        Schema.is(SelectedAdapterError)(error) ||
        Schema.is(MissingSessionOwnershipError)(error)
          ? loggedCoordinatorFailure(input.name, error)
          : Stream.fail(error)
      ),
      Stream.takeUntil(isTerminalOutput),
      Stream.map(Option.some<SelectedAdapterOutputType>),
      Stream.concat(Stream.make(Option.none<SelectedAdapterOutputType>())),
      Stream.mapAccumEffect(
        () => input.initialState,
        (state, item) =>
          Option.match(item, {
            onNone: () => completeTurn(state),
            onSome: (output) =>
              projectOutput({
                crypto: input.crypto,
                contextWindow: input.options.contextWindow,
                name: input.name,
                output,
                state,
              }),
          })
      ),
      Stream.mapError(
        (cause) =>
          new HarnessProtocolError({
            cause,
            detail: `Selected adapter ${input.adapter} failed: ${describeCoordinatorError(cause)}`,
          })
      )
    );

const makeSelectedAdapterRuntimeHarness = (input: {
  readonly contribution: SelectedAdapterHarnessContribution;
  readonly coordinator: SelectedAdapterCoordinatorShape;
  readonly crypto: Crypto.Crypto;
}): RuntimeHarness => {
  const adapter = HarnessNameSchema.make(input.contribution.adapter);
  const name = HarnessNameSchema.make(input.contribution.name);
  const { compactionPrompt } = input.contribution;
  const invoke = (
    options: RuntimeHarnessInvokeOptions
  ): Stream.Stream<AgentRuntimeEvent, HarnessProtocolError> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const ids = yield* makeHarnessEventIds(input.crypto);
        const currentTimeMillis = yield* Clock.currentTimeMillis;
        const initial = withHarnessModel(
          initialHarnessEventState(name, currentTimeMillis, ids),
          options.model
        );
        const resumed =
          options.sessionId === undefined
            ? initial
            : withHarnessSessionId(initial, options.sessionId);
        const [startedState, startedEvents] = makeHarnessStartEvents(
          resumed,
          options
        );
        return Stream.fromIterable(startedEvents).pipe(
          Stream.concat(
            makeAdapterEventStream({
              adapter,
              coordinator: input.coordinator,
              crypto: input.crypto,
              initialState: startedState,
              name,
              options,
              prepare: input.contribution.prepare,
            })
          )
        );
      })
    );
  const compact =
    compactionPrompt === undefined
      ? Effect.succeedNone
      : Effect.succeed(
          Option.some((options: RuntimeHarnessCompactionOptions) =>
            invoke({
              ...options,
              outputSchema: undefined,
              prompt: compactionPrompt,
            })
          )
        );
  return {
    close: Effect.void,
    defaultModel: input.contribution.defaultModel,
    compact,
    telemetryId: input.contribution.telemetryId,
    invoke,
    name,
    parseSessionId: (): Effect.Effect<Option.Option<SessionId>> =>
      Effect.succeed(Option.none()),
  };
};

export { makeSelectedAdapterRuntimeHarness };
export type { SelectedAdapterHarnessContribution };
