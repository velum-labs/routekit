import { Cause, Clock, Effect, Exit, Option, Ref, Stream } from "effect";

import type { AgentRuntimeEvent } from "../../../../contracts/author/src/index.ts";
import type { AgentHarnessTelemetryId } from "../../../../contracts/internal/src/runtime/telemetry-harness.ts";
import type { TelemetryObserver } from "../../../../contracts/internal/src/runtime/telemetry-observer.ts";
import type { TelemetrySurfaceInput } from "../../../../contracts/internal/src/runtime/telemetry-surface.ts";
import type { ValueOf } from "../../../../utils/core/src/types.ts";

import { AgentRuntimeEventTag } from "../../../../contracts/author/src/agent-event.ts";
import {
  TELEMETRY_SURFACE_INTERNAL,
  telemetrySurfaceId,
} from "../../../../contracts/internal/src/runtime/telemetry-surface.ts";

const AGENT_RUN_OUTCOMES = {
  cancelled: "cancelled",
  error: "error",
  ok: "ok",
} as const;
type AgentRunOutcome = ValueOf<typeof AGENT_RUN_OUTCOMES>;
type AgentRunResult = Exclude<AgentRunOutcome, "cancelled">;

interface AgentRunOutcomeState {
  readonly cancelled: boolean;
  readonly session: AgentRunResult | undefined;
  readonly turn: AgentRunResult | undefined;
}

const initialAgentRunOutcomeState: AgentRunOutcomeState = {
  cancelled: false,
  session: undefined,
  turn: undefined,
};

const sessionResultFor = (type: string): AgentRunResult | undefined => {
  if (type === AgentRuntimeEventTag.SessionSucceeded) {
    return "ok";
  }
  if (
    type === AgentRuntimeEventTag.SessionFailed ||
    type === AgentRuntimeEventTag.RuntimeError
  ) {
    return "error";
  }
  return undefined;
};

const turnResultFor = (type: string): AgentRunResult | undefined => {
  if (type === AgentRuntimeEventTag.TurnSucceeded) {
    return "ok";
  }
  if (type === AgentRuntimeEventTag.TurnFailed) {
    return "error";
  }
  return undefined;
};

const resolveAgentRunOutcome = (input: {
  readonly requestedCancellation: boolean;
  readonly state: AgentRunOutcomeState;
}): AgentRunOutcome => {
  if (input.requestedCancellation) {
    return "cancelled";
  }
  return (
    input.state.session ??
    (input.state.cancelled ? "cancelled" : (input.state.turn ?? "error"))
  );
};

const trackAgentRuntimeEvent = Effect.fn("AgentRunTelemetry.trackRuntimeEvent")(
  function* (input: {
    readonly harness: Ref.Ref<AgentHarnessTelemetryId | undefined>;
    readonly outcome: Ref.Ref<AgentRunOutcomeState>;
    readonly runtimeEvent: AgentRuntimeEvent;
    readonly turns: Ref.Ref<number>;
  }) {
    if (input.runtimeEvent.type === AgentRuntimeEventTag.TurnStarted) {
      yield* Ref.update(input.turns, (count) => count + 1);
    }
    const session = sessionResultFor(input.runtimeEvent.type);
    const turn = turnResultFor(input.runtimeEvent.type);
    if (session === undefined && turn === undefined) {
      return;
    }
    yield* Ref.update(
      input.outcome,
      (current): AgentRunOutcomeState => ({
        ...current,
        ...(session === undefined ? {} : { session }),
        ...(turn === undefined ? {} : { turn }),
      })
    );
  }
);

const markAgentRunExit = (
  outcome: Ref.Ref<AgentRunOutcomeState>,
  exit: Exit.Exit<unknown, unknown>
): Effect.Effect<void> => {
  if (Exit.isSuccess(exit)) {
    return Effect.void;
  }
  if (Cause.hasInterruptsOnly(exit.cause)) {
    return Ref.update(
      outcome,
      (current): AgentRunOutcomeState => ({
        ...current,
        cancelled: true,
      })
    );
  }
  return Ref.update(
    outcome,
    (current): AgentRunOutcomeState => ({
      ...current,
      session: "error",
    })
  );
};

const emitAgentRunTelemetry = Effect.fn("AgentRunTelemetry.emit")(
  function* (input: {
    readonly cancelState: Ref.Ref<boolean> | undefined;
    readonly harness: Ref.Ref<AgentHarnessTelemetryId | undefined>;
    readonly observer: Option.Option<TelemetryObserver["Service"]>;
    readonly outcome: Ref.Ref<AgentRunOutcomeState>;
    readonly startedAt: number;
    readonly surface: TelemetrySurfaceInput | undefined;
    readonly turns: Ref.Ref<number>;
  }) {
    if (
      input.surface === TELEMETRY_SURFACE_INTERNAL ||
      Option.isNone(input.observer)
    ) {
      return;
    }
    const snapshot = yield* Effect.all({
      endedAt: Clock.currentTimeMillis,
      harness: Ref.get(input.harness),
      outcome: Ref.get(input.outcome),
      requestedCancellation:
        input.cancelState === undefined
          ? Effect.succeed(false)
          : Ref.get(input.cancelState),
      turns: Ref.get(input.turns),
    });
    yield* input.observer.value
      .observe("agent_run", {
        duration_ms: Math.max(
          0,
          Math.trunc(snapshot.endedAt - input.startedAt)
        ),
        harness: snapshot.harness ?? "harness-unknown",
        outcome: resolveAgentRunOutcome({
          requestedCancellation: snapshot.requestedCancellation,
          state: snapshot.outcome,
        }),
        surface: telemetrySurfaceId(input.surface),
        turns: snapshot.turns,
      })
      .pipe(Effect.ignore);
  }
);

export const observeAgentRun = <A extends AgentRuntimeEvent, E, R>(input: {
  readonly cancelSignal?: Effect.Effect<unknown> | undefined;
  readonly cancelState?: Ref.Ref<boolean> | undefined;
  readonly observer: Option.Option<TelemetryObserver["Service"]>;
  readonly telemetryId?: AgentHarnessTelemetryId | undefined;
  readonly surface: TelemetrySurfaceInput | undefined;
  readonly events: Stream.Stream<A, E, R>;
}): Stream.Stream<A, E, R> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis;
      const outcome = yield* Ref.make(initialAgentRunOutcomeState);
      const turns = yield* Ref.make(0);
      const harness = yield* Ref.make<AgentHarnessTelemetryId | undefined>(
        input.telemetryId
      );
      const tracked = input.events.pipe(
        Stream.tap((runtimeEvent) =>
          trackAgentRuntimeEvent({
            harness,
            outcome,
            runtimeEvent,
            turns,
          })
        ),
        Stream.onExit((exit) => markAgentRunExit(outcome, exit))
      );
      const completed =
        input.cancelSignal === undefined
          ? tracked
          : tracked.pipe(Stream.interruptWhen(input.cancelSignal));
      return completed.pipe(
        Stream.ensuring(
          emitAgentRunTelemetry({
            cancelState: input.cancelState,
            harness,
            observer: input.observer,
            outcome,
            startedAt,
            surface: input.surface,
            turns,
          })
        )
      );
    })
  );
