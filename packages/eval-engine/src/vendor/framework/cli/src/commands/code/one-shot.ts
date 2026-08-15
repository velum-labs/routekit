import { Effect, Ref, Stream } from "effect";

import type { AgentFailure } from "../../../../contracts/author/src/errors/agent-failure.ts";
import type { ChatInteractionResponse } from "../../../../contracts/author/src/chat.ts";
import type { InvokeRuntimeCommand } from "../../../../contracts/internal/src/runtime/command.ts";
import type { RuntimeStreamEvent } from "../../../../contracts/internal/src/runtime/stream-event.ts";
import type {
  AnsweredRequest,
  SettleInteraction,
} from "./one-shot-answers.ts";

import { formatAgentFailure } from "../../../../contracts/author/src/errors/agent-failure.ts";
import { CliIo } from "../../../../contracts/internal/src/cli/cli-io.ts";
import {
  renderStreamLine,
  toEnvelopeError,
} from "../../../../contracts/internal/src/cli/cli-output.ts";
import { CliFailureError } from "../../../../contracts/internal/src/errors.ts";
import { AgentRuntimeEventTag } from "../../../../contracts/internal/src/runtime/agent-runtime-event.ts";
import { respondInteraction } from "../../../../runloop/local/src/chat/index.ts";
import { invokeRuntime } from "../../../../runloop/local/src/daemon/client/client.ts";
import { OriCliExit } from "../../cli-exit.ts";
import { HEADLESS_FAILURE_EXIT } from "./headless-projection.ts";
import { attemptSettle } from "./one-shot-answers.ts";
import { formatUnknownError } from "../../../../utils/core/src/error-formatting.ts";

// The structured one-shot for `ori code --output jsonl` (RFC 0004 code.md
// "Structured output"): mirror every runtime stream event to stdout as a
// CliStreamLine `event` line, settle interactive requests with their safe
// fallback so the run never hangs on a question nobody answers, and always
// finish with exactly one terminal `result` line — even when the transport
// fails mid-stream, so a line-by-line parser never sees a malformed tail.

type StreamedAgentEvent = Extract<
  RuntimeStreamEvent,
  { readonly type: "runtime.event" }
>["event"];

/**
 * The turn outcome folded from the stream's terminal events. The pi harness
 * never emits `session.succeeded`, so success is judged from either the turn-
 * or session-level terminal; a stream that ends without one is a failure, not
 * a silent success (RFC 0004 code.md).
 */
export interface OneShotOutcome {
  readonly errorDetail: string | undefined;
  /** Machine identity of the failure behind `errorDetail`, when it had one. */
  readonly failureCode: string | undefined;
  readonly ok: boolean;
  readonly sawTerminal: boolean;
  readonly sessionId: string | undefined;
}

export const initialOneShotOutcome: OneShotOutcome = {
  errorDetail: undefined,
  failureCode: undefined,
  ok: false,
  sawTerminal: false,
  sessionId: undefined,
};

const eventFailure = (event: StreamedAgentEvent): AgentFailure | undefined =>
  event.type === AgentRuntimeEventTag.TurnFailed ||
  event.type === AgentRuntimeEventTag.SessionFailed ||
  event.type === AgentRuntimeEventTag.RuntimeError
    ? event.payload.failure
    : undefined;

// An if-chain rather than a switch: only a handful of the ~20 event tags
// change the outcome, so the switch-exhaustiveness rule would demand every
// silent tag be enumerated here (the same trade headless-projection.ts makes
// with its Match.orElse).
/** Fold one runtime stream event into the running outcome (last terminal wins). */
export const applyOneShotOutcomeEvent = (
  outcome: OneShotOutcome,
  streamEvent: RuntimeStreamEvent
): OneShotOutcome => {
  if (streamEvent.type !== "runtime.event") {
    return outcome;
  }
  const { event } = streamEvent;
  const sessionId = event.sessionId ?? outcome.sessionId;
  if (
    event.type === AgentRuntimeEventTag.SessionSucceeded ||
    event.type === AgentRuntimeEventTag.TurnSucceeded
  ) {
    return {
      errorDetail: undefined,
      failureCode: undefined,
      ok: true,
      sawTerminal: true,
      sessionId,
    };
  }
  if (
    event.type === AgentRuntimeEventTag.SessionFailed ||
    event.type === AgentRuntimeEventTag.TurnFailed
  ) {
    const failure = eventFailure(event);
    return {
      errorDetail:
        failure === undefined ? undefined : formatAgentFailure(failure),
      failureCode: failure?.code,
      ok: false,
      sawTerminal: true,
      sessionId,
    };
  }
  if (event.type === AgentRuntimeEventTag.RuntimeError) {
    // Not terminal by itself (the runner may retry the turn), but when the
    // stream ends here its message is the best failure detail available.
    const failure = eventFailure(event);
    return {
      ...outcome,
      errorDetail:
        failure === undefined ? undefined : formatAgentFailure(failure),
      failureCode: failure?.code,
      sessionId,
    };
  }
  return sessionId === outcome.sessionId
    ? outcome
    : {
        ...outcome,
        sessionId,
      };
};

/**
 * The interactive request an event carries, or `undefined` when it is not one
 * (or has no resolvable session id — nothing can be settled without one).
 */
export const oneShotInteractionRequest = (
  streamEvent: RuntimeStreamEvent,
  fallbackSessionId?: string
): AnsweredRequest | undefined => {
  if (streamEvent.type !== "runtime.event") {
    return undefined;
  }
  const { event } = streamEvent;
  if (
    event.type !== AgentRuntimeEventTag.PermissionRequested &&
    event.type !== AgentRuntimeEventTag.ElicitationRequested
  ) {
    return undefined;
  }
  const sessionId =
    event.payload.sessionId ?? event.sessionId ?? fallbackSessionId;
  if (sessionId === undefined) {
    return undefined;
  }
  return {
    correlationId: event.payload.correlationId,
    kind:
      event.type === AgentRuntimeEventTag.PermissionRequested
        ? "permission"
        : "elicitation",
    sessionId,
  };
};

/**
 * The safe deterministic settlement for a mid-run interactive request
 * (RFC 0003 Interactive Request Lifecycle): permission → cancelled,
 * elicitation → decline, never an approval.
 */
export const interactionFallbackFor = (
  request: AnsweredRequest
): ChatInteractionResponse =>
  request.kind === "permission"
    ? {
        correlationId: request.correlationId,
        kind: "permission",
        response: { outcome: "cancelled" },
        sessionId: request.sessionId,
      }
    : {
        correlationId: request.correlationId,
        kind: "elicitation",
        response: { action: "decline" },
        sessionId: request.sessionId,
      };

/**
 * The safe deterministic settlement for a mid-run interactive request, or
 * `undefined` when the event is not one. Retained as the composition of
 * {@link oneShotInteractionRequest} and {@link interactionFallbackFor}.
 */
export const oneShotInteractionFallback = (
  streamEvent: RuntimeStreamEvent,
  fallbackSessionId?: string
): ChatInteractionResponse | undefined => {
  const request = oneShotInteractionRequest(streamEvent, fallbackSessionId);
  return request === undefined ? undefined : interactionFallbackFor(request);
};

/**
 * The outcome for a run that died outside its event stream. Everything seen so
 * far survives except `failureCode`: a code folded from an earlier event
 * describes a different failure than the one that ended the run.
 */
const oneShotFailure = (outcome: OneShotOutcome): CliFailureError =>
  new CliFailureError({
    detail:
      outcome.errorDetail ??
      (outcome.sawTerminal
        ? "The coding turn failed."
        : "The runtime stream ended before the turn settled."),
    ...(outcome.failureCode === undefined
      ? {}
      : { failureCode: outcome.failureCode }),
    ...(outcome.sessionId === undefined
      ? {}
      : {
          hint: `Resume this session with \`ori code --session ${outcome.sessionId} -p "<follow-up>"\`.`,
        }),
  });

interface OneShotDaemon {
  readonly host: string;
  readonly port: number;
}

// Write the event line, fold the outcome, and settle any interactive request —
// advertising the surface is a promise this settle keeps, so the harness never
// blocks on a question nobody answers. A failed OR stalled settle must not kill
// the stream mid-turn (had no surface been advertised, the daemon's default-deny
// would have settled the same request), but it is noted on stderr since an
// unsettled request is what a hung-looking run traces back to.
const foldOneShotEvent =
  (cliIo: CliIo["Service"], settle: SettleInteraction) =>
  (
    outcome: OneShotOutcome,
    streamEvent: RuntimeStreamEvent
  ): Effect.Effect<OneShotOutcome> =>
    Effect.gen(function* () {
      yield* cliIo
        .writeStdout(
          renderStreamLine({
            event: streamEvent,
            kind: "event",
          })
        )
        .pipe(Effect.ignore);
      const next = applyOneShotOutcomeEvent(outcome, streamEvent);
      const request = oneShotInteractionRequest(streamEvent, next.sessionId);
      if (request !== undefined) {
        const settlement = interactionFallbackFor(request);
        yield* attemptSettle(cliIo, settle, settlement);
      }
      return next;
    });

const oneShotRuntimeFailure = (
  outcomeRef: Ref.Ref<OneShotOutcome>,
  error: unknown
): Effect.Effect<OneShotOutcome> =>
  Ref.get(outcomeRef).pipe(
    Effect.map(
      (current): OneShotOutcome => ({
        ...current,
        errorDetail: `The headless run could not be completed: ${formatUnknownError(error)}`,
        // The run died outside the event stream, so a code folded from an
        // earlier event describes a different failure than this one.
        failureCode: undefined,
        ok: false,
        sawTerminal: false,
      })
    )
  );

/**
 * Run one structured one-shot turn against the already-booted daemon: every
 * runtime stream event is mirrored to stdout as a compact `{"kind":"event"}`
 * line, then exactly one terminal `{"kind":"result"}` line reports the
 * outcome and the session id the run actually used (the handle a caller
 * chains a follow-up `--session` turn with).
 *
 * The result line is the contract, so every ending converges on it: a failed
 * turn, a stream that closes without a terminal event, and a mid-stream
 * transport failure (daemon crash, socket reset) all still emit it — never a
 * multi-line error envelope into the NDJSON a caller is parsing line-by-line.
 * The process exits non-zero via `OriCliExit`, which the entry point honors
 * without printing anything further.
 */
export const runCodeOneShotJsonlTurn = Effect.fn("CodeCommand.oneShotJsonl")(
  function* (input: {
    readonly command: InvokeRuntimeCommand;
    readonly daemon: OneShotDaemon;
    /** Test seam for the interaction settle; defaults to the daemon POST. */
    readonly settleInteraction?: SettleInteraction;
  }) {
    const cliIo = yield* CliIo;
    const settle =
      input.settleInteraction ??
      ((response: ChatInteractionResponse): Promise<void> =>
        respondInteraction(input.daemon, response));
    // Folded through a Ref (not the stream's fold state) so a mid-stream
    // transport failure keeps everything seen so far — above all the session
    // id, which is exactly the handle a caller needs to resume after a crash.
    const outcomeRef = yield* Ref.make(initialOneShotOutcome);
    const fold = foldOneShotEvent(cliIo, settle);
    const outcome = yield* invokeRuntime(input.daemon, input.command).pipe(
      Stream.runForEach((streamEvent) =>
        Ref.get(outcomeRef).pipe(
          Effect.flatMap((current) => fold(current, streamEvent)),
          Effect.flatMap((next) => Ref.set(outcomeRef, next))
        )
      ),
      Effect.andThen(Ref.get(outcomeRef)),
      Effect.catch((error) => oneShotRuntimeFailure(outcomeRef, error))
    );
    const ok = outcome.sawTerminal && outcome.ok;
    const failure = ok ? undefined : oneShotFailure(outcome);
    yield* cliIo
      .writeStdout(
        renderStreamLine({
          kind: "result",
          ok,
          ...(outcome.sessionId === undefined
            ? {}
            : { sessionId: outcome.sessionId }),
          ...(failure === undefined ? {} : { error: toEnvelopeError(failure) }),
        })
      )
      .pipe(Effect.ignore);
    if (!ok) {
      return yield* new OriCliExit({ exitCode: HEADLESS_FAILURE_EXIT });
    }
  }
);
