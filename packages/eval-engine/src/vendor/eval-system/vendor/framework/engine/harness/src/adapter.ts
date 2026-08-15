import {
  Clock,
  Context,
  Effect,
  Layer,
  Option,
  Ref,
  Schema,
  Stream,
} from "effect";

import type { AgentRuntimeEvent as AgentRuntimeEventContribution } from "../../../contracts/author/src/index.ts";
import type { AgentHarness } from "../../../contracts/internal/src/author-schemas/agent-harness.ts";
import type { HarnessError } from "../../../contracts/internal/src/errors.ts";
import type { SessionId as SessionIdSchema } from "../../../contracts/internal/src/ids.ts";
import type { AgentRuntimeEvent } from "../../../contracts/internal/src/runtime/agent-runtime-event-types.ts";
import type {
  AgentHarnessEventProjectorShape,
  AgentHarnessProjectionState,
  ProjectionResult,
} from "./event-projector.ts";
import type { HarnessEventIds } from "./events.ts";
import type {
  RuntimeHarnessCompactionOptions,
  RuntimeHarnessInvokeOptions,
} from "./options.ts";
import type { PublicHarnessLifecycle } from "./public-harness-lifecycle.ts";
import type { RuntimeHarness } from "./runtime-harness.ts";

import { decodeAuthorAgentRuntimeEvent } from "../../../contracts/internal/src/author-schemas/agent-runtime-event.ts";
import { HarnessInvokeOptionsSchema } from "../../../contracts/internal/src/author-schemas/harness-options.ts";
import {
  HarnessCapabilityError,
  HarnessProtocolError,
} from "../../../contracts/internal/src/errors.ts";
import { HarnessName as HarnessNameSchema } from "../../../contracts/internal/src/ids.ts";
import { AgentHarnessEventProjector } from "./event-projector.ts";
import {
  makeRuntimeWarningEvent,
  withHarnessCurrentTime,
} from "./events.ts";
import {
  formatHarnessFailureDetail,
  makePublicHarnessLifecycle,
} from "./public-harness-lifecycle.ts";
import { formatUnknownError } from "../../../utils/core/src/error-formatting.ts";

import type { ConnectedResult } from "./adapter-session.ts";

import {
  closeConnected,
  connectedSessionEvents,
  eagerConnect,
  startProjection,
  withCancellation,
} from "./adapter-session.ts";

type SessionId = ReturnType<typeof SessionIdSchema.make>;

interface AgentHarnessAdapterShape {
  readonly adapt: (
    contribution: AgentHarness,
    makeIds: Effect.Effect<HarnessEventIds, HarnessError>
  ) => RuntimeHarness;
}

const projectPublicAgentRuntimeEvent = (input: {
  readonly event: AgentRuntimeEventContribution;
  readonly projector: AgentHarnessEventProjectorShape;
  readonly state: AgentHarnessProjectionState;
}): Effect.Effect<ProjectionResult> =>
  decodeAuthorAgentRuntimeEvent(input.event).pipe(
    Effect.flatMap((decoded) => input.projector.project(input.state, decoded)),
    Effect.catch((decodeError) =>
      Effect.gen(function* () {
        const currentTimeMillis = yield* Clock.currentTimeMillis;
        const harnessState = withHarnessCurrentTime(
          input.state.harnessState,
          currentTimeMillis
        );
        const message = `Invalid harness event: ${formatUnknownError(decodeError)}`;
        const [nextHarnessState, warningEvent] = makeRuntimeWarningEvent(
          harnessState,
          message,
          input.event
        );
        return {
          events: [warningEvent],
          state: {
            ...input.state,
            harnessState: nextHarnessState,
          },
        };
      })
    )
  );
const normalizePublicAgentRuntimeEvent = Effect.fn(
  "Adapter.normalizePublicAgentRuntimeEvent"
)(function* (input: {
  readonly event: AgentRuntimeEventContribution;
  readonly projector: AgentHarnessEventProjectorShape;
  readonly stateRef: Ref.Ref<AgentHarnessProjectionState>;
}) {
  const projected = yield* projectPublicAgentRuntimeEvent({
    event: input.event,
    projector: input.projector,
    state: yield* Ref.get(input.stateRef),
  });
  yield* Ref.set(input.stateRef, projected.state);
  return projected.events;
});
const finalizePublicHarnessStream = Effect.fn(
  "Adapter.finalizePublicHarnessStream"
)(function* (input: {
  readonly projector: AgentHarnessEventProjectorShape;
  readonly stateRef: Ref.Ref<AgentHarnessProjectionState>;
}) {
  const projected = yield* input.projector.finalize(
    yield* Ref.get(input.stateRef)
  );
  yield* Ref.set(input.stateRef, projected.state);
  return projected.events;
});
const failPublicHarnessStream = Effect.fn("Adapter.failPublicHarnessStream")(
  function* (input: {
    readonly error: HarnessError;
    readonly projector: AgentHarnessEventProjectorShape;
    readonly stateRef: Ref.Ref<AgentHarnessProjectionState>;
  }) {
    const projected = yield* input.projector.fail(
      yield* Ref.get(input.stateRef),
      input.error
    );
    yield* Ref.set(input.stateRef, projected.state);
    return projected.events;
  }
);
const projectConnectedSessionStarted = Effect.fn(
  "Adapter.projectConnectedSessionStarted"
)(function* (input: {
  readonly projector: AgentHarnessEventProjectorShape;
  readonly sessionId: string | undefined;
  readonly stateRef: Ref.Ref<AgentHarnessProjectionState>;
}) {
  return input.sessionId === undefined
    ? []
    : yield* normalizePublicAgentRuntimeEvent({
        event: {
          payload: { sessionId: input.sessionId },
          type: "session.started",
        },
        projector: input.projector,
        stateRef: input.stateRef,
      });
});
const projectChangedSessionStarted = Effect.fn(
  "Adapter.projectChangedSessionStarted"
)(function* (input: {
  readonly emittedSessionId: { value: string | undefined };
  readonly lifecycle: PublicHarnessLifecycle;
  readonly projector: AgentHarnessEventProjectorShape;
  readonly stateRef: Ref.Ref<AgentHarnessProjectionState>;
}) {
  const sessionId = input.lifecycle.sessionId();
  const changedSessionId =
    sessionId === input.emittedSessionId.value ? undefined : sessionId;
  input.emittedSessionId.value = sessionId;
  return yield* projectConnectedSessionStarted({
    projector: input.projector,
    sessionId: changedSessionId,
    stateRef: input.stateRef,
  });
});
interface PublicHarnessStreamInputBase {
  readonly contribution: AgentHarness;
  readonly lifecycle: PublicHarnessLifecycle;
  readonly makeIds: Effect.Effect<HarnessEventIds, HarnessError>;
  readonly projector: AgentHarnessEventProjectorShape;
  readonly emittedSessionId: { value: string | undefined };
}
type PublicHarnessStreamInput =
  | (PublicHarnessStreamInputBase & {
      readonly compact: (
        options: RuntimeHarnessCompactionOptions
      ) => AsyncIterable<AgentRuntimeEventContribution>;
      readonly operation: "compact";
      readonly options: RuntimeHarnessCompactionOptions;
    })
  | (PublicHarnessStreamInputBase & {
      readonly operation: "prompt";
      readonly options: RuntimeHarnessInvokeOptions;
    })
  | (PublicHarnessStreamInputBase & {
      readonly operation: "connect";
      readonly options: RuntimeHarnessInvokeOptions;
    });
const failPublicHarnessStreamEvents = (
  projector: AgentHarnessEventProjectorShape,
  stateRef: Ref.Ref<AgentHarnessProjectionState>,
  error: HarnessError
): Stream.Stream<AgentRuntimeEvent> =>
  Stream.fromEffect(
    failPublicHarnessStream({
      error,
      projector,
      stateRef,
    })
  ).pipe(Stream.flatMap((failureEvents) => Stream.fromIterable(failureEvents)));
const mapPublicOutputStream = (
  input: PublicHarnessStreamInput,
  args: { readonly stateRef: Ref.Ref<AgentHarnessProjectionState> },
  events: AsyncIterable<AgentRuntimeEventContribution>
): Stream.Stream<AgentRuntimeEvent> =>
  Stream.fromAsyncIterable(events, (cause) =>
    Schema.is(HarnessCapabilityError)(cause)
      ? cause
      : new HarnessProtocolError({
          cause,
          detail: formatHarnessFailureDetail(
            input.contribution.name,
            "stream failed",
            cause
          ),
        })
  ).pipe(
    Stream.mapEffect((event) =>
      normalizePublicAgentRuntimeEvent({
        event,
        projector: input.projector,
        stateRef: args.stateRef,
      })
    ),
    Stream.flatMap((runtimeEvents) => Stream.fromIterable(runtimeEvents)),
    Stream.catch((error) =>
      failPublicHarnessStreamEvents(input.projector, args.stateRef, error)
    )
  );
const buildPublicHarnessOutputStream = (
  input: PublicHarnessStreamInput,
  args: {
    readonly stateRef: Ref.Ref<AgentHarnessProjectionState>;
    readonly publicOptions:
      | ReturnType<
          ReturnType<
            typeof Schema.encodeSync<typeof HarnessInvokeOptionsSchema>
          >
        >
      | undefined;
    readonly connected: ConnectedResult;
  }
): Effect.Effect<Stream.Stream<AgentRuntimeEvent>> =>
  ((): Effect.Effect<
    AsyncIterable<AgentRuntimeEventContribution>,
    HarnessError
  > => {
    if (input.operation === "compact") {
      return Effect.try({
        catch: (cause) =>
          new HarnessProtocolError({
            cause,
            detail: formatHarnessFailureDetail(
              input.contribution.name,
              "failed to compact",
              cause
            ),
          }),
        try: () => input.compact(input.options),
      });
    }
    if (args.publicOptions === undefined) {
      return Effect.die(new Error("Prompt options were not encoded"));
    }
    if (input.operation === "connect") {
      return connectedSessionEvents(
        input.lifecycle,
        args.publicOptions,
        args.connected
      );
    }
    return input.lifecycle.prompt(args.publicOptions);
  })().pipe(
    Effect.map((events) => mapPublicOutputStream(input, args, events)),
    Effect.catch((error) =>
      Effect.succeed(
        failPublicHarnessStreamEvents(input.projector, args.stateRef, error)
      )
    )
  );
const makeSessionStartedStream = (input: {
  readonly emittedSessionId: { value: string | undefined };
  readonly lifecycle: PublicHarnessLifecycle;
  readonly projector: AgentHarnessEventProjectorShape;
  readonly stateRef: Ref.Ref<AgentHarnessProjectionState>;
}): Stream.Stream<AgentRuntimeEvent> =>
  Stream.fromEffect(projectChangedSessionStarted(input)).pipe(
    Stream.flatMap((events) => Stream.fromIterable(events))
  );
const makePublicHarnessRuntimeStream = (
  input: PublicHarnessStreamInput
): Stream.Stream<AgentRuntimeEvent, HarnessError> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const publicOptions =
        "prompt" in input.options
          ? Schema.encodeSync(HarnessInvokeOptionsSchema)(input.options)
          : undefined;
      const connectedResult = yield* eagerConnect(
        input.lifecycle,
        input.operation,
        publicOptions
      );
      const started = yield* startProjection(input, input.options).pipe(
        Effect.onError(() => closeConnected(connectedResult))
      );
      const stateRef = yield* Ref.make(started.state);
      const output = yield* buildPublicHarnessOutputStream(input, {
        connected: connectedResult,
        publicOptions,
        stateRef,
      });
      const sessionStarted = makeSessionStartedStream({
        emittedSessionId: input.emittedSessionId,
        lifecycle: input.lifecycle,
        projector: input.projector,
        stateRef,
      });
      const finalize = Stream.fromEffect(
        finalizePublicHarnessStream({
          projector: input.projector,
          stateRef,
        })
      ).pipe(
        Stream.flatMap((terminalEvents) => Stream.fromIterable(terminalEvents))
      );
      const turn = Stream.fromIterable(started.events).pipe(
        Stream.concat(sessionStarted),
        Stream.concat(output),
        Stream.concat(finalize)
      );
      return withCancellation(turn, input.options, input.lifecycle);
    })
  );
const adaptAgentHarnessContribution = (
  projector: AgentHarnessEventProjectorShape,
  contribution: AgentHarness,
  makeIds: Effect.Effect<HarnessEventIds, HarnessError>
): RuntimeHarness => {
  const lifecycle = makePublicHarnessLifecycle(contribution);
  const emittedSessionId = { value: undefined as string | undefined };
  const { mode } = lifecycle;
  const runtimeHarness: RuntimeHarness = {
    initialize: lifecycle.initialize,
    compact: lifecycle.compact.pipe(
      Effect.map(
        Option.map(
          (compact) => (options: RuntimeHarnessCompactionOptions) =>
            makePublicHarnessRuntimeStream({
              compact,
              contribution,
              emittedSessionId,
              lifecycle,
              makeIds,
              operation: "compact",
              options,
              projector,
            })
        )
      )
    ),
    close: lifecycle.close,
    get defaultModel() {
      return lifecycle.defaultModel();
    },
    invoke: (options): Stream.Stream<AgentRuntimeEvent, HarnessError> =>
      Stream.unwrap(
        mode.pipe(
          Effect.map((operation) =>
            makePublicHarnessRuntimeStream({
              contribution,
              emittedSessionId,
              lifecycle,
              makeIds,
              options,
              operation,
              projector,
            })
          )
        )
      ),
    name: HarnessNameSchema.make(contribution.name),
    parseSessionId: (): Effect.Effect<Option.Option<SessionId>, HarnessError> =>
      Effect.succeed(Option.none()),
    respond: (response): Effect.Effect<void, HarnessError> =>
      lifecycle.respond(response),
    telemetryId: undefined,
  };
  return runtimeHarness;
};

export class AgentHarnessAdapter extends Context.Service<
  AgentHarnessAdapter,
  AgentHarnessAdapterShape
>()("routekit-eval/harness/AgentHarnessAdapter") {
  static readonly layer = Layer.effect(AgentHarnessAdapter)(
    Effect.gen(function* () {
      const projector = yield* AgentHarnessEventProjector;
      return AgentHarnessAdapter.of({
        adapt: (contribution, makeIds) =>
          adaptAgentHarnessContribution(projector, contribution, makeIds),
      });
    })
  ).pipe(Layer.provide(AgentHarnessEventProjector.layer));
}

export type { AgentHarnessAdapterShape };
