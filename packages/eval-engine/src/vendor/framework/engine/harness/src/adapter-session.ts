import { Effect, Ref, Stream } from "effect";

import type { AgentRuntimeEvent as AgentRuntimeEventContribution } from "../../../contracts/author/src/index.ts";
import type { AgentHarness } from "../../../contracts/internal/src/author-schemas/agent-harness.ts";
import type { HarnessError } from "../../../contracts/internal/src/errors.ts";
import type { AgentRuntimeEvent } from "../../../contracts/internal/src/runtime/agent-runtime-event-types.ts";
import type { AgentHarnessEventProjectorShape } from "./event-projector.ts";
import type {
  RuntimeHarnessCompactionOptions,
  RuntimeHarnessInvokeOptions,
} from "./options.ts";

import {
  HarnessName as HarnessNameSchema,
  SessionId as SessionIdSchema,
} from "../../../contracts/internal/src/ids.ts";

import type { HarnessEventIds } from "./events.ts";
import type { PublicHarnessLifecycle } from "./public-harness-lifecycle.ts";

export type ConnectedResult =
  | { readonly events: AsyncIterable<AgentRuntimeEventContribution> }
  | { readonly error: HarnessError }
  | undefined;

const noConnection: ConnectedResult = undefined;

// The connection happens before projection starts so its captured failure is
// projected as the turn's terminal record instead of dying unprojected.
export const eagerConnect = (
  lifecycle: PublicHarnessLifecycle,
  operation: string,
  publicOptions: Parameters<PublicHarnessLifecycle["connect"]>[0] | undefined
): Effect.Effect<ConnectedResult> =>
  operation === "connect" && publicOptions !== undefined
    ? lifecycle.connect(publicOptions).pipe(
        Effect.map((events) => ({ events })),
        Effect.catch((error) => Effect.succeed({ error }))
      )
    : Effect.succeed(noConnection);

// A captured connect failure is already typed, so it fails the effect
// directly and the terminal projection reports the connect failure instead
// of a stream failure wrapping it.
export const connectedSessionEvents = (
  lifecycle: PublicHarnessLifecycle,
  publicOptions: Parameters<PublicHarnessLifecycle["connect"]>[0],
  connected: ConnectedResult
): Effect.Effect<
  AsyncIterable<AgentRuntimeEventContribution>,
  HarnessError
> => {
  if (connected === undefined) {
    return lifecycle.connect(publicOptions);
  }
  return "events" in connected
    ? Effect.succeed(connected.events)
    : Effect.fail(connected.error);
};

// A connection acquired eagerly has no consumer yet, so a failure before the
// output stream exists must close the provider turn it opened.
export const closeConnected = (
  connected: ConnectedResult
): Effect.Effect<void> =>
  connected !== undefined && "events" in connected
    ? Effect.promise(async () => {
        await connected.events[Symbol.asyncIterator]().return?.();
      })
    : Effect.void;

export const withCancellation = (
  turn: Stream.Stream<AgentRuntimeEvent, HarnessError>,
  options: RuntimeHarnessInvokeOptions | RuntimeHarnessCompactionOptions,
  lifecycle: PublicHarnessLifecycle
): Stream.Stream<AgentRuntimeEvent, HarnessError> => {
  if (options.cancelSignal === undefined) {
    return turn;
  }
  const { cancelState } = options;
  return turn.pipe(
    Stream.interruptWhen(options.cancelSignal),
    Stream.ensuring(
      Effect.uninterruptible(
        Effect.gen(function* () {
          if (cancelState !== undefined && (yield* Ref.get(cancelState))) {
            yield* lifecycle.interrupt.pipe(Effect.ignore);
          }
        })
      )
    )
  );
};

const makeSessionId = (
  value: string | undefined
): ReturnType<typeof SessionIdSchema.make> | undefined =>
  value === undefined ? undefined : SessionIdSchema.make(value);

export const withLiveSessionId = (
  options: RuntimeHarnessInvokeOptions | RuntimeHarnessCompactionOptions,
  lifecycle: PublicHarnessLifecycle
): RuntimeHarnessInvokeOptions | RuntimeHarnessCompactionOptions => ({
  ...options,
  sessionId: options.sessionId ?? makeSessionId(lifecycle.sessionId()),
});

export const startProjection = Effect.fn("Adapter.startProjection")(function* (
  input: {
    readonly contribution: AgentHarness;
    readonly lifecycle: PublicHarnessLifecycle;
    readonly makeIds: Effect.Effect<HarnessEventIds, HarnessError>;
    readonly projector: AgentHarnessEventProjectorShape;
  },
  options: RuntimeHarnessInvokeOptions | RuntimeHarnessCompactionOptions
) {
  const projectorOptions = withLiveSessionId(options, input.lifecycle);
  return yield* input.projector.start({
    harness: HarnessNameSchema.make(input.contribution.name),
    ids: yield* input.makeIds,
    options:
      "prompt" in projectorOptions
        ? projectorOptions
        : {
            ...projectorOptions,
            prompt: "",
          },
  });
});
