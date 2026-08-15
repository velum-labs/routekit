import type { Crypto } from "effect";

import { Clock, Effect, Option, Stream } from "effect";

import type { SessionId } from "../../../../contracts/internal/src/ids.ts";
import type { RuntimeSessionSnapshot } from "../../../../contracts/internal/src/runtime/session-snapshot-types.ts";
import type { AgentRunnerError } from "../agent-runner/service.ts";
import type {
  AgentRuntimeEvent,
  OriDaemonServices,
  RuntimeCommand,
  RuntimeStreamEvent,
} from "../daemon/core/types.ts";
import type {
  RolloverMode,
  RolloverPlan,
} from "./rollover.ts";

import {
  agentFailure,
  AgentRuntimeEventTag,
  isAssistantTextDelta,
} from "../../../../contracts/author/src/index.ts";
import {
  RuntimeJournalError,
  RuntimeValidationError,
} from "../../../../contracts/internal/src/errors.ts";
import { RunId, RuntimeEventId, TurnId } from "../../../../contracts/internal/src/ids.ts";
import {
  firstSessionPrompt,
  summarizeParentThread,
} from "./fork-thread.ts";
import {
  buildRolloverSeedPrompt,
  buildSummaryPrompt,
  planRollover,
} from "./rollover.ts";
import { OpenRouterModels } from "../openrouter/models-service.ts";

/**
 * Rollover orchestration (ORI-471): riding INSIDE the user's next turn, the
 * daemon summarizes the old session, emits compaction lifecycle events under
 * it, then swaps in a fresh child session seeded with the summary plus the
 * user's actual prompt. Both surfaces adopt the child purely from its
 * `SessionStarted`, so no client orchestration exists anywhere.
 */

export interface RolloverResolution {
  readonly plan: RolloverPlan;
  readonly sessionId: SessionId;
  readonly snapshot: RuntimeSessionSnapshot;
}

/**
 * Decide whether this command should roll its session over first. Forks and
 * fresh sessions never roll; everything else defers to the pure planner.
 */
export const resolveRollover = Effect.fn("Daemon.resolveRollover")(function* (
  services: OriDaemonServices,
  command: RuntimeCommand
): Effect.fn.Return<RolloverResolution | null> {
  const { sessionId } = command;
  if (
    command.fork !== undefined ||
    sessionId === undefined ||
    services.rollover.mode === "off"
  ) {
    return null;
  }
  const snapshotOption = yield* services.sessionStore.get(sessionId);
  const snapshot = Option.getOrUndefined(snapshotOption);
  // The usage-reported model is preferred, but through a gateway it may be an
  // id the catalog does not know (e.g. claude fronting a non-Anthropic model);
  // a miss retries with the invoked model slug rather than going dark.
  const contextWindow =
    (yield* services.contextWindowLookup
      .lookup(snapshot?.lastUsageModel)
      .pipe(
        Effect.provideService(OpenRouterModels, services.openRouterModels)
      )) ??
    (yield* services.contextWindowLookup
      .lookup(command.model)
      .pipe(
        Effect.provideService(OpenRouterModels, services.openRouterModels)
      ));
  const plan = planRollover({
    config: services.rollover,
    contextWindow,
    force: command.forceRollover === true,
    snapshot,
  });
  return plan === null || snapshot === undefined
    ? null
    : {
        plan,
        sessionId,
        snapshot,
      };
});

type CompactionEventBody =
  | {
      readonly payload: Extract<
        AgentRuntimeEvent,
        {
          readonly type:
            | typeof AgentRuntimeEventTag.CompactionStarted
            | typeof AgentRuntimeEventTag.CompactionCancelled;
        }
      >["payload"];
      readonly type: typeof AgentRuntimeEventTag.CompactionStarted;
    }
  | Pick<
      Extract<
        AgentRuntimeEvent,
        { readonly type: typeof AgentRuntimeEventTag.CompactionCompleted }
      >,
      "payload" | "type"
    >
  | Pick<
      Extract<
        AgentRuntimeEvent,
        { readonly type: typeof AgentRuntimeEventTag.CompactionFailed }
      >,
      "payload" | "type"
    >;

const makeCompactionEvent = (input: {
  readonly crypto: Crypto.Crypto;
  readonly event: CompactionEventBody;
  readonly snapshot: RuntimeSessionSnapshot;
}): Effect.Effect<AgentRuntimeEvent, RuntimeJournalError> =>
  Effect.all([
    input.crypto.randomUUIDv4,
    input.crypto.randomUUIDv4,
    input.crypto.randomUUIDv4,
    Clock.currentTimeMillis,
  ]).pipe(
    Effect.mapError(
      (cause) =>
        new RuntimeJournalError({
          cause,
          detail: "Could not generate rollover event ids",
          operation: "rollover",
        })
    ),
    Effect.map(
      ([eventId, runId, turnId, nowMs]): AgentRuntimeEvent => ({
        ...input.event,
        createdAt: new Date(nowMs).toISOString(),
        eventId: RuntimeEventId.make(eventId),
        harness: input.snapshot.harness,
        runId: RunId.make(runId),
        sessionId: input.snapshot.sessionId,
        turnId: TurnId.make(turnId),
      })
    )
  );

// Ask the OLD session for the handoff summary as a normal runner turn and fold
// its assistant text locally: the summary is transport, not conversation, so
// its content events are neither journaled nor streamed to the client.
const runSummaryTurn = (input: {
  readonly invokeSummary: (
    prompt: string
  ) => Stream.Stream<AgentRuntimeEvent, AgentRunnerError>;
}): Effect.Effect<string | undefined> =>
  input.invokeSummary(buildSummaryPrompt()).pipe(
    Stream.runFold(
      (): string => "",
      (acc, event): string =>
        isAssistantTextDelta(event) ? acc + event.payload.delta : acc
    ),
    Effect.map((text) => {
      const trimmed = text.trim();
      return trimmed.length === 0
        ? Option.none<string>()
        : Option.some(trimmed);
    }),
    Effect.catch(() => Effect.succeedNone),
    Effect.map(Option.getOrUndefined)
  );

type RolloverStreamError = RuntimeJournalError | RuntimeValidationError;

/** The slice of the daemon services the rollover stream actually touches. */
export interface RolloverStreamServices {
  readonly crypto: OriDaemonServices["crypto"];
  readonly daemonAddress: OriDaemonServices["daemonAddress"];
  readonly journal: Pick<OriDaemonServices["journal"], "entries">;
}

export interface RolloverStreamInput {
  readonly appendRuntimeEvent: (
    event: AgentRuntimeEvent
  ) => Effect.Effect<readonly RuntimeStreamEvent[], RolloverStreamError>;
  readonly command: RuntimeCommand;
  readonly invokeSummary: (
    prompt: string
  ) => Stream.Stream<AgentRuntimeEvent, AgentRunnerError>;
  /** Runs the re-seeded child command through the normal leased agent stream. */
  readonly makeChildStream: (
    command: RuntimeCommand
  ) => Stream.Stream<RuntimeStreamEvent, RolloverStreamError>;
  readonly resolution: RolloverResolution;
  readonly services: RolloverStreamServices;
}

// The re-seeded child: same invocation minus the resumed session and the
// force flag, its prompt replaced by the handoff seed.
const makeRolloverChildCommand = (input: {
  readonly baseUrl: string | undefined;
  readonly command: RuntimeCommand;
  readonly originalPrompt: string | undefined;
  readonly sessionId: SessionId;
  readonly summary: string;
}): RuntimeCommand => {
  const {
    forceRollover: _forceRollover,
    sessionId: _sessionId,
    ...rest
  } = input.command;
  return {
    ...rest,
    prompt: buildRolloverSeedPrompt({
      baseUrl: input.baseUrl,
      oldSessionId: input.sessionId,
      originalPrompt: input.originalPrompt,
      summary: input.summary,
      userPrompt: input.command.prompt,
    }),
  };
};

// Synthesize one compaction lifecycle event, journal it under the old
// session, and return its client-stream projection.
const emitCompaction = (
  input: RolloverStreamInput,
  event: CompactionEventBody
): Effect.Effect<readonly RuntimeStreamEvent[], RolloverStreamError> =>
  makeCompactionEvent({
    crypto: input.services.crypto,
    event,
    snapshot: input.resolution.snapshot,
  }).pipe(Effect.flatMap(input.appendRuntimeEvent));

// A failed or empty summary turn is journaled as a non-terminal
// compaction.failed (willRetry) before the projection fallback completes the
// rollover; a healthy summary emits nothing extra.
const emitSummaryFallback = (
  input: RolloverStreamInput,
  plan: RolloverPlan,
  summary: string | undefined
): Effect.Effect<readonly RuntimeStreamEvent[], RolloverStreamError> =>
  summary === undefined
    ? emitCompaction(input, {
        payload: {
          cause: plan.cause,
          failure: agentFailure({
            code: "ORI_COMPACTION_SUMMARY_FAILED",
            message:
              "Summary turn failed; falling back to the journal projection.",
            stage: "runtime",
          }),
          trigger: plan.trigger,
          willRetry: true,
        },
        type: AgentRuntimeEventTag.CompactionFailed,
      })
    : Effect.succeed([]);

// Everything after compaction.started: the summary turn, its fallback, the
// completion event, and the re-seeded child stream.
const makeRolloverTail = Effect.fn(function* (
  input: RolloverStreamInput,
  startMs: number
) {
  const { command, resolution, services } = input;
  const { plan, sessionId, snapshot } = resolution;
  const summary = yield* runSummaryTurn(input);
  const entries = yield* services.journal.entries();
  // The deterministic journal projection backstops a failed or empty
  // summary turn: rollover always completes once started, and the user's
  // prompt is never sacrificed to it.
  const effectiveSummary = summary ?? summarizeParentThread(entries, sessionId);

  const failedStream = yield* emitSummaryFallback(input, plan, summary);

  const endMs = yield* Clock.currentTimeMillis;
  const completedStream = yield* emitCompaction(input, {
    payload: {
      cause: plan.cause,
      durationMs: Math.max(0, Math.round(endMs - startMs)),
      tokensBefore: snapshot.lastContextTokens,
      trigger: plan.trigger,
    },
    type: AgentRuntimeEventTag.CompactionCompleted,
  });

  const childCommand = makeRolloverChildCommand({
    baseUrl: Option.getOrUndefined(yield* services.daemonAddress.get),
    command,
    originalPrompt: firstSessionPrompt(entries, sessionId),
    sessionId,
    summary: effectiveSummary,
  });

  return Stream.fromIterable([...failedStream, ...completedStream]).pipe(
    Stream.concat(input.makeChildStream(childCommand))
  );
});

/**
 * A bare /compact rides an empty prompt that only the rollover seed replaces;
 * when the rollover cannot resolve, fail the command cleanly rather than
 * sending an empty turn to the harness. Must fail inside the invoke stream
 * (not before it) so the ORI-450 conversion renders it as terminal runtime
 * events instead of an opaque mid-stream HTTP error.
 */
export const guardUnresolvedForcedRollover = (
  command: RuntimeCommand,
  rollover: RolloverResolution | null,
  mode: RolloverMode
): Effect.Effect<void, RuntimeValidationError> =>
  command.forceRollover === true &&
  rollover === null &&
  command.prompt.trim().length === 0
    ? new RuntimeValidationError({
        cause: undefined,
        detail:
          mode === "off"
            ? "nothing to compact: compaction rollover is disabled (ORI_COMPACTION_ROLLOVER=off)"
            : "nothing to compact: the session has no recorded state to summarize",
      })
    : Effect.void;

export const makeRolloverStream = (
  input: RolloverStreamInput
): Stream.Stream<RuntimeStreamEvent, RolloverStreamError> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const { plan } = input.resolution;
      const startMs = yield* Clock.currentTimeMillis;
      const startedStream = yield* emitCompaction(input, {
        payload: {
          cause: plan.cause,
          trigger: plan.trigger,
        },
        type: AgentRuntimeEventTag.CompactionStarted,
      });
      // compaction.started must reach the client BEFORE the summary turn
      // blocks (it can take many seconds); the tail is unwrapped lazily so
      // the progress line streams while the wait happens.
      return Stream.fromIterable(startedStream).pipe(
        Stream.concat(Stream.unwrap(makeRolloverTail(input, startMs)))
      );
    })
  );
