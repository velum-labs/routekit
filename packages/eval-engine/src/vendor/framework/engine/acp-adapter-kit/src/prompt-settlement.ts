import { Deferred, Effect, Fiber, Option, Ref } from "effect";

import type { AcpClientRequestFailure } from "../../acp-agent/src/service.ts";

import type { PromptStopReason, PromptTurn } from "./prompt-turn.ts";

import { acpRequestFailure } from "./request-failure.ts";

// How many pending session cancellations to remember. A cancel that arrives
// before its prompt is held for that prompt to consume (see `takeCancelledFlag`);
// the bound keeps a client that only ever cancels from growing the list forever.
const CANCELLATION_RETENTION = 64;

/**
 * Settles the in-flight turn, if there is one, and clears the slot.
 *
 * `Err` is constrained to an object so a stop reason (always a string) is
 * distinguishable from a failure payload at runtime with a bare `typeof` check.
 */
export const settlePromptTurn = <Err extends object>(
  activePrompt: Ref.Ref<Option.Option<PromptTurn<Err>>>,
  result: PromptStopReason | Err
): Effect.Effect<void> =>
  Ref.getAndSet(activePrompt, Option.none()).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.void,
        onSome: ({ done }) =>
          typeof result === "string"
            ? Deferred.succeed(done, result)
            : Deferred.fail(done, result),
      })
    ),
    Effect.asVoid
  );

/**
 * The adapter state a `session/cancel` acts on: the fiber running any blocking
 * native interaction, the in-flight turn, and the pending-cancellation list for
 * a cancel that outruns its prompt.
 */
export interface SessionCancellationInput<Err extends object, AbortErr> {
  readonly activeInteraction: Ref.Ref<Option.Option<Fiber.Fiber<void>>>;
  readonly activePrompt: Ref.Ref<Option.Option<PromptTurn<Err>>>;
  readonly cancelledSessions: Ref.Ref<readonly string[]>;
  readonly errorMessage: (error: AbortErr) => string;
  readonly native: { readonly abort: Effect.Effect<void, AbortErr> };
}

/**
 * Tears the current turn down: interrupt any blocking interaction fiber, abort
 * the native turn, then settle the waiting prompt `cancelled`. Ordering matters —
 * the interaction is interrupted first so its own cancellation path answers the
 * native peer before the abort lands.
 */
const cancelActivePrompt = <Err extends object, AbortErr>(
  input: SessionCancellationInput<Err, AbortErr>
): Effect.Effect<boolean, AcpClientRequestFailure> =>
  Ref.get(input.activeInteraction).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.void,
        onSome: (fiber) => Fiber.interrupt(fiber),
      })
    ),
    Effect.andThen(input.native.abort),
    Effect.andThen(settlePromptTurn(input.activePrompt, "cancelled")),
    Effect.mapError((error) => acpRequestFailure(input.errorMessage(error))),
    Effect.as(true)
  );

/**
 * Builds the adapter's `cancelSession`. A cancel for the session that owns the
 * in-flight turn tears that turn down; anything else (no active prompt, or a
 * prompt for a different session) is remembered so the prompt it was racing can
 * consume it on arrival.
 */
export const makeCancelSession =
  <Err extends object, AbortErr>(
    input: SessionCancellationInput<Err, AbortErr>
  ): ((sessionId: string) => Effect.Effect<void, AcpClientRequestFailure>) =>
  (sessionId) =>
    Ref.get(input.activePrompt).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(false),
          onSome: (prompt) =>
            prompt.sessionId === sessionId
              ? cancelActivePrompt(input)
              : Effect.succeed(false),
        })
      ),
      Effect.flatMap((handled) =>
        handled
          ? Effect.void
          : Ref.update(input.cancelledSessions, (sessionIds) =>
              [...sessionIds, sessionId].slice(-CANCELLATION_RETENTION)
            )
      )
    );
