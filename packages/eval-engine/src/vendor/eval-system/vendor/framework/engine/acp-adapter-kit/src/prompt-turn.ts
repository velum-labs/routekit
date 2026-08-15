import { Deferred, Effect, Option, Ref } from "effect";

import type { AcpClientRequestFailure } from "../../acp-agent/src/service.ts";

import type {
  SessionPromptContent,
  SessionPromptParams,
} from "./session-requests.ts";

import { acpRequestFailure } from "./request-failure.ts";

export type PromptStopReason = "cancelled" | "end_turn";

/**
 * The in-flight turn an adapter holds while a `session/prompt` is outstanding.
 * `Err` is whatever the adapter's own event loop settles the turn with when it
 * fails.
 */
export interface PromptTurn<Err> {
  readonly done: Deferred.Deferred<PromptStopReason, Err>;
  readonly sessionId: string;
}

export interface PromptTurnResult {
  readonly method: "session/prompt";
  readonly result: { readonly stopReason: PromptStopReason };
}

/**
 * Neither native agent accepts anything but text in a prompt, so the blocks are
 * flattened to one string and any richer block is refused by name.
 */
export const promptText = (
  agentLabel: string,
  prompt: SessionPromptContent
): Effect.Effect<string, AcpClientRequestFailure> => {
  const chunks: string[] = [];
  for (const block of prompt) {
    if (block.type !== "text") {
      return Effect.fail(
        acpRequestFailure(
          `${agentLabel} does not support ${block.type} prompts`
        )
      );
    }
    chunks.push(block.text);
  }
  return Effect.succeed(chunks.join("\n"));
};

/**
 * Consumes a pending cancellation for a session, if one arrived before the
 * prompt did. Reading and clearing in one `modify` keeps two concurrent prompts
 * from both observing the same flag.
 */
export const takeCancelledFlag = (
  cancelledSessions: Ref.Ref<readonly string[]>,
  sessionId: string
): Effect.Effect<boolean> =>
  Ref.modify(cancelledSessions, (sessionIds) => {
    const index = sessionIds.indexOf(sessionId);
    return index === -1
      ? [false, sessionIds]
      : [true, [...sessionIds.slice(0, index), ...sessionIds.slice(index + 1)]];
  });

/**
 * The provider-specific step run inside an admitted turn, just before the text
 * reaches the native process.
 */
export type PromptTurnBeforeSend<BeforeErr, R> = (turn: {
  readonly message: string;
  readonly sessionId: string;
}) => Effect.Effect<void, BeforeErr, R>;

/**
 * The slice of a native connection a prompt turn drives. Both adapters fail
 * `abort` and `prompt` with the same connection error, and an abort failure is
 * always ignored (the turn is already ending), so one error parameter covers
 * both.
 */
export interface PromptTurnNative<PromptErr> {
  readonly abort: Effect.Effect<void, PromptErr>;
  readonly prompt: (message: string) => Effect.Effect<void, PromptErr>;
}

/**
 * The body of an already-admitted turn: honour a cancellation that arrived
 * before the prompt did, otherwise hand the text to the native process and wait
 * for the adapter's event loop to settle `done`.
 */
const runAdmittedTurn = Effect.fn(function* <
  Err,
  PromptErr,
  BeforeErr,
  R,
>(input: {
  readonly beforeSend: PromptTurnBeforeSend<BeforeErr, R>;
  readonly cancelledSessions: Ref.Ref<readonly string[]>;
  readonly done: Deferred.Deferred<PromptStopReason, Err>;
  readonly message: string;
  readonly native: PromptTurnNative<PromptErr>;
  readonly sessionId: string;
}) {
  const { beforeSend, cancelledSessions, done, message, native, sessionId } =
    input;
  const cancelled = yield* takeCancelledFlag(cancelledSessions, sessionId);
  if (cancelled) {
    return {
      method: "session/prompt" as const,
      result: { stopReason: "cancelled" as const },
    };
  }
  yield* beforeSend({
    message,
    sessionId,
  });
  yield* native.prompt(message);
  // A cancel that lands between admission and this send settles `done`
  // without aborting the agent (the turn had not started yet), which would
  // orphan the just-sent native turn. If that raced in, abort it now.
  const cancelledDuringSend = yield* Deferred.isDone(done);
  if (cancelledDuringSend) {
    yield* native.abort.pipe(Effect.ignore);
  }
  const stopReason = yield* Deferred.await(done).pipe(
    Effect.onInterrupt(() => native.abort.pipe(Effect.ignore))
  );
  return {
    method: "session/prompt" as const,
    result: { stopReason },
  };
});

/**
 * The `session/prompt` turn both native-wire adapters run: admit one prompt at a
 * time against the active session, run it, and release the slot afterwards.
 *
 * `beforeSend` is the one provider-specific step inside the admitted turn (the
 * Pi adapter rolls a previously failed prompt back before re-sending); the
 * Claude adapter has nothing to do there.
 */
export const runPromptTurn = Effect.fn(function* <
  Err,
  PromptErr,
  BeforeErr,
  R,
>(input: {
  readonly activePrompt: Ref.Ref<Option.Option<PromptTurn<Err>>>;
  readonly agentLabel: string;
  readonly beforeSend: PromptTurnBeforeSend<BeforeErr, R>;
  readonly cancelledSessions: Ref.Ref<readonly string[]>;
  readonly currentSession: Ref.Ref<Option.Option<string>>;
  readonly native: PromptTurnNative<PromptErr>;
  readonly params: SessionPromptParams;
}) {
  const {
    activePrompt,
    agentLabel,
    beforeSend,
    cancelledSessions,
    currentSession,
    native,
    params,
  } = input;
  const current = yield* Ref.get(currentSession);
  if (Option.isNone(current) || current.value !== params.sessionId) {
    return yield* Effect.fail(
      acpRequestFailure(`${agentLabel} session is not active`)
    );
  }
  const sessionId = current.value;
  const message = yield* promptText(agentLabel, params.prompt);
  const done = yield* Deferred.make<PromptStopReason, Err>();
  const turn: PromptTurn<Err> = {
    done,
    sessionId,
  };
  // Atomic admission: only the caller that finds the slot empty claims it, so
  // a concurrent second prompt is rejected without transiently overwriting the
  // active prompt (which `getAndSet` + restore would expose to a racing event).
  const registered = yield* Ref.modify(activePrompt, (active) =>
    Option.isNone(active) ? [true, Option.some(turn)] : [false, active]
  );
  if (!registered) {
    return yield* Effect.fail(
      acpRequestFailure(`${agentLabel} already has an active prompt`)
    );
  }
  return yield* runAdmittedTurn({
    beforeSend,
    cancelledSessions,
    done,
    message,
    native,
    sessionId,
  }).pipe(
    Effect.ensuring(
      Ref.update(activePrompt, (active) =>
        Option.isSome(active) && active.value === turn ? Option.none() : active
      )
    )
  );
});
