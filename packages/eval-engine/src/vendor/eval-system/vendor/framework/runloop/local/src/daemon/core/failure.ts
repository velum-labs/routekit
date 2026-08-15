import type { Crypto } from "effect";

import { Clock, Effect, Schema } from "effect";

import type { AgentFailure } from "../../../../../contracts/author/src/errors/agent-failure.ts";
import type { RouteKitEvalDaemonShape } from "./service.ts";

import { agentFailure } from "../../../../../contracts/author/src/errors/agent-failure.ts";
import {
  RuntimeJournalError,
  RuntimeValidationError,
} from "../../../../../contracts/internal/src/errors.ts";
import {
  HarnessName,
  RunId as RunIdSchema,
  TurnId as TurnIdSchema,
} from "../../../../../contracts/internal/src/ids.ts";
import {
  initialHarnessEventState,
  makeHarnessStartEvents,
  makeRuntimeErrorEvent,
  makeTurnCompletedEvent,
  markHarnessTerminalEvent,
  withHarnessEventSequence,
  withHarnessSessionId,
} from "../../../../../engine/harness/src/events.ts";

type RuntimeCommand = Parameters<RouteKitEvalDaemonShape["invoke"]>[0];
type RunId = ReturnType<typeof RunIdSchema.make>;
type TurnId = ReturnType<typeof TurnIdSchema.make>;

interface HarnessStartOptions {
  readonly cwd: string;
  readonly model?: string | null | undefined;
  readonly prompt: string;
  readonly userId?: string | undefined;
}

/** A run the client has already seen announced, and how far its ids got. */
interface AnnouncedRun {
  /** The `eventSequence` of the last event observed for this run. */
  readonly eventSequence: number;
  readonly runId: RunId;
  readonly turnId: TurnId;
}

interface RuntimeFailureEventsInput {
  readonly command: RuntimeCommand;
  readonly error: unknown;
  readonly cwd: string;
  readonly crypto: Crypto.Crypto;
  /**
   * Set once the agent stream emitted its own `run.started`. The terminal
   * events then join that run instead of opening a second one: synthesizing
   * another pair reads as a duplicate dispatch, and it carries `command.model`,
   * unset whenever the model came from the resolved default, so the phantom run
   * looks model-less (ROUTEKIT_EVAL-846). Absent, a fresh run is announced as before, so
   * a failure always reaches the client inside a run frame it has seen.
   */
  readonly announcedRun?: AnnouncedRun | undefined;
}

const runtimeInvocationFailure = (error: unknown): AgentFailure =>
  Schema.is(RuntimeValidationError)(error)
    ? agentFailure({
        code: "ROUTEKIT_EVAL_RUNTIME_VALIDATION_FAILED",
        kind: "invalid-input",
        message: error.detail,
        stage: "runtime",
      })
    : agentFailure({
        code: "ROUTEKIT_EVAL_RUNTIME_INVOKE_FAILED",
        stage: "runtime",
      });

const makeRuntimeFailureEventIds = (
  crypto: Crypto.Crypto
): Effect.Effect<
  { readonly runId: RunId; readonly turnId: TurnId },
  RuntimeJournalError
> =>
  Effect.all([crypto.randomUUIDv4, crypto.randomUUIDv4]).pipe(
    Effect.map(([runId, turnId]) => ({
      runId: RunIdSchema.make(runId),
      turnId: TurnIdSchema.make(turnId),
    })),
    Effect.mapError(
      (cause) =>
        new RuntimeJournalError({
          cause,
          detail: "Could not generate runtime failure event ids",
          operation: "failure",
        })
    )
  );

const makeHarnessOptions = (
  command: RuntimeCommand,
  cwd: string
): HarnessStartOptions => ({
  cwd,
  model: command.model,
  prompt: command.prompt,
  userId: command.userId,
});

export const makeRuntimeFailureEvents = Effect.fn(
  "DaemonFailure.makeRuntimeFailureEvents"
)(function* (input: RuntimeFailureEventsInput) {
  const { command, error, cwd, crypto, announcedRun } = input;
  const currentTimeMillis = yield* Clock.currentTimeMillis;
  // Reuse the live run's ids when there is one, so the terminal events belong
  // to the run the client already opened rather than to a run id it never saw.
  const ids = announcedRun ?? (yield* makeRuntimeFailureEventIds(crypto));
  const freshState = initialHarnessEventState(
    command.harnessName ?? HarnessName.make("unknown"),
    currentTimeMillis,
    ids
  );
  // Resume the live run's numbering; a fresh run starts from zero as usual.
  const baseState =
    announcedRun === undefined
      ? freshState
      : withHarnessEventSequence(freshState, announcedRun.eventSequence);
  const state = command.sessionId
    ? withHarnessSessionId(baseState, command.sessionId)
    : baseState;
  // A run that already announced itself gets no second pair, and skipping the
  // build keeps its id numbering contiguous rather than burning two ids.
  const [stateAfterStartEvents, startEvents] =
    announcedRun === undefined
      ? makeHarnessStartEvents(state, makeHarnessOptions(command, cwd))
      : ([state, []] as const);
  const terminalState = markHarnessTerminalEvent(stateAfterStartEvents);
  const failure = runtimeInvocationFailure(error);
  const [errorState, runtimeError] = makeRuntimeErrorEvent(
    terminalState,
    failure,
    error
  );
  const [, turnCompleted] = makeTurnCompletedEvent(errorState, {
    failure,
    ok: false,
    raw: error,
  });
  return [...startEvents, runtimeError, turnCompleted];
});

export type { AnnouncedRun, RuntimeFailureEventsInput };
