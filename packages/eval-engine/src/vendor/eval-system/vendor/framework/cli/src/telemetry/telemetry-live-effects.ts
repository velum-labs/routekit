import type { HttpClient } from "effect/unstable/http";

import { Clock, Effect, Ref, Schedule } from "effect";

import type { HostProcess } from "../../../contracts/internal/src/cli/host-process.ts";
import type { TelemetryShape } from "./telemetry.ts";
import type {
  TelemetryEvent,
  TelemetryEventName,
  TelemetryProps,
  TelemetryIdentitySchema,
} from "./telemetry-event.ts";
import type { TelemetryState } from "./telemetry-state.ts";

import { makeTelemetryEvent } from "./telemetry-event.ts";

const emitSessionEnd = Effect.fn("Telemetry.emitSessionEnd")(function* (input: {
  readonly buffer: Ref.Ref<readonly TelemetryEvent[]>;
  readonly counters: Ref.Ref<{
    readonly cancelledRuns: number;
    readonly runs: number;
  }>;
  readonly identity: typeof TelemetryIdentitySchema.Type;
  readonly nowMs: number;
  readonly props: TelemetryProps;
  readonly sessionStarted: Ref.Ref<boolean>;
}) {
  if (!(yield* Ref.get(input.sessionStarted))) {
    return;
  }
  const counters = yield* Ref.get(input.counters);
  const entry = makeTelemetryEvent({
    event: "session_end",
    identity: input.identity,
    now: new Date(input.nowMs),
    props: {
      ...input.props,
      cancelled_runs: counters.cancelledRuns,
      runs: counters.runs,
    },
  });
  yield* Ref.update(input.buffer, (events) => [...events, entry]);
  yield* Ref.set(input.counters, {
    cancelledRuns: 0,
    runs: 0,
  });
  yield* Ref.set(input.sessionStarted, false);
});

export const persistFirstAgentRun = Effect.fn("Telemetry.persistFirstAgentRun")(
  function* (persist: Effect.Effect<void>) {
    yield* persist;
  }
);

const updateRunCounters = (
  counters: Ref.Ref<{ readonly cancelledRuns: number; readonly runs: number }>,
  outcome: unknown
): Effect.Effect<void> =>
  Ref.update(counters, (current) => ({
    cancelledRuns: current.cancelledRuns + (outcome === "cancelled" ? 1 : 0),
    runs: current.runs + 1,
  }));

export const enrichAgentRunProps = Effect.fn("Telemetry.enrichAgentRunProps")(
  function* (input: {
    readonly event: TelemetryEventName;
    readonly nowMs: number;
    readonly props: TelemetryProps;
    readonly stateRef: Ref.Ref<TelemetryState>;
    readonly firstAgentRunActivationProps: (
      installedAtMs: number | undefined,
      nowMs: number
    ) => TelemetryProps;
  }) {
    const enrichedProps = yield* Ref.modify(input.stateRef, (current) => {
      if (input.event !== "agent_run" || current.firstAgentRunSent === true) {
        return [input.props, current] as const;
      }
      return [
        {
          ...input.props,
          ...input.firstAgentRunActivationProps(
            current.installedAtMs,
            input.nowMs
          ),
        },
        {
          ...current,
          firstAgentRunSent: true,
        },
      ] as const;
    });
    return enrichedProps;
  }
);

const startSessionIfNeeded = Effect.fn("Telemetry.startSessionIfNeeded")(
  function* (input: {
    readonly buffer: Ref.Ref<readonly TelemetryEvent[]>;
    readonly counters: Ref.Ref<{
      readonly cancelledRuns: number;
      readonly runs: number;
    }>;
    readonly identity: typeof TelemetryIdentitySchema.Type;
    readonly nowMs: number;
    readonly sessionStarted: Ref.Ref<boolean>;
    readonly sessionStartedAt: Ref.Ref<number>;
  }) {
    const firstRun = yield* Ref.modify(input.sessionStarted, (started) => [
      !started,
      true,
    ]);
    if (firstRun) {
      yield* Ref.set(input.counters, {
        cancelledRuns: 0,
        runs: 0,
      });
      yield* Ref.set(input.sessionStartedAt, input.nowMs);
      yield* Ref.update(input.buffer, (events) => [
        ...events,
        makeTelemetryEvent({
          event: "session_start",
          identity: input.identity,
          now: new Date(input.nowMs),
          props: {},
        }),
      ]);
    }
  }
);

export const recordAgentRun = Effect.fn("Telemetry.recordAgentRun")(
  function* (input: {
    readonly buffer: Ref.Ref<readonly TelemetryEvent[]>;
    readonly counters: Ref.Ref<{
      readonly cancelledRuns: number;
      readonly runs: number;
    }>;
    readonly identity: typeof TelemetryIdentitySchema.Type;
    readonly nowMs: number;
    readonly props: TelemetryProps;
    readonly sessionStarted: Ref.Ref<boolean>;
    readonly sessionStartedAt: Ref.Ref<number>;
  }) {
    yield* startSessionIfNeeded({
      buffer: input.buffer,
      counters: input.counters,
      identity: input.identity,
      nowMs: input.nowMs,
      sessionStarted: input.sessionStarted,
      sessionStartedAt: input.sessionStartedAt,
    });
    yield* updateRunCounters(input.counters, input.props.outcome);
  }
);

export const appendTelemetryEvent = Effect.fn("Telemetry.appendTelemetryEvent")(
  function* (input: {
    readonly buffer: Ref.Ref<readonly TelemetryEvent[]>;
    readonly entry: TelemetryEvent;
    readonly flush: Effect.Effect<void>;
    readonly flushThreshold: number;
  }) {
    const size = yield* Ref.modify(input.buffer, (events) => {
      const next = [...events, input.entry];
      return [next.length, next];
    });
    if (size >= input.flushThreshold) {
      yield* input.flush.pipe(Effect.forkDetach({ startImmediately: true }));
    }
  }
);

export const handleSessionEnd = Effect.fn("Telemetry.handleSessionEnd")(
  function* (input: {
    readonly buffer: Ref.Ref<readonly TelemetryEvent[]>;
    readonly counters: Ref.Ref<{
      readonly cancelledRuns: number;
      readonly runs: number;
    }>;
    readonly identity: typeof TelemetryIdentitySchema.Type;
    readonly nowMs: number;
    readonly props: TelemetryProps;
    readonly sessionStarted: Ref.Ref<boolean>;
  }) {
    yield* emitSessionEnd(input);
  }
);

type PostBatch = (
  client: HttpClient.HttpClient,
  events: readonly TelemetryEvent[],
  apiKey: string | undefined
) => Effect.Effect<void>;

const makeSessionFinalizer = Effect.fn("Telemetry.sessionFinalizer")(
  function* (input: {
    readonly emit: TelemetryShape["emit"];
    readonly flush: Effect.Effect<void>;
    readonly sessionStarted: Ref.Ref<boolean>;
    readonly sessionStartedAt: Ref.Ref<number>;
  }) {
    const startedAt = yield* Ref.get(input.sessionStartedAt);
    const nowMs = yield* Clock.currentTimeMillis;
    const durationMs = nowMs - startedAt;
    yield* input.emit("session_end", {
      duration_ms: durationMs,
    });
    yield* input.flush;
  }
);

export const makeFlush = Effect.fn("Telemetry.flush")(function* (input: {
  readonly buffer: Ref.Ref<readonly TelemetryEvent[]>;
  readonly client: HttpClient.HttpClient;
  readonly hostProcess: HostProcess["Service"];
  readonly postBatch: PostBatch;
  readonly maxEventsPerBatch: number;
}) {
  const events = yield* Ref.getAndSet(input.buffer, []);
  if (events.length === 0) {
    return;
  }
  const batch = events.slice(0, input.maxEventsPerBatch);
  const overflow = events.slice(input.maxEventsPerBatch);
  if (overflow.length > 0) {
    yield* Ref.update(input.buffer, (current) => [...overflow, ...current]);
  }
  const currentEnv = yield* input.hostProcess.env;
  yield* input.postBatch(input.client, batch, currentEnv.ROUTEKIT_EVAL_BEARER_TOKEN);
});

export const startTelemetryLifecycle = Effect.fn("Telemetry.startLifecycle")(
  function* (input: {
    readonly emit: TelemetryShape["emit"];
    readonly flush: Effect.Effect<void>;
    readonly flushInterval: Parameters<typeof Schedule.spaced>[0];
    readonly exitFlushTimeout: Parameters<typeof Schedule.spaced>[0];
    readonly sessionStarted: Ref.Ref<boolean>;
    readonly sessionStartedAt: Ref.Ref<number>;
  }) {
    yield* input.flush.pipe(
      Effect.schedule(Schedule.spaced(input.flushInterval)),
      Effect.forkScoped
    );
    yield* Effect.addFinalizer(() =>
      Ref.get(input.sessionStarted).pipe(
        Effect.flatMap((started) =>
          started ? makeSessionFinalizer(input) : input.flush
        ),
        Effect.timeout(input.exitFlushTimeout),
        Effect.ignore
      )
    );
  }
);
