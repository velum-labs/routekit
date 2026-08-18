import type { Ref } from "effect";

import { Deferred, Effect } from "effect";

import type { InteractionError } from "./errors.ts";
import type {
  InteractionEventSinkShape,
  InteractionRuntimeEvent,
} from "./events.ts";
import type {
  InteractionConfig,
  InteractionCorrelationId,
  InteractionTerminal,
} from "./model.ts";
import type {
  InteractionState,
  PendingInteraction,
  RespondResult,
} from "./state.ts";

import {
  InteractionInvalidResponseError,
  InteractionNotPendingError,
} from "./errors.ts";
import {
  cancelledResolvedEvent,
  respondedResolvedEvent,
} from "./events.ts";
import { takeOne } from "./state.ts";

// Restore an effect to the caller's interruptibility inside an
// `uninterruptibleMask`. The event emit runs under this so it stays
// interruptible while the removal + wakeup around it do not.
export type Restore = <A, E, R>(
  effect: Effect.Effect<A, E, R>
) => Effect.Effect<A, E, R>;

// Wake a waiter, then emit its resolved event (if any). The caller runs this
// inside an `uninterruptibleMask` that already made the state removal
// uninterruptible, so a committed terminal transition always wakes whoever
// awaits the handle even if the fiber is interrupted. The (potentially
// blocking) emit is restored to interruptible and ordered after the wakeup,
// because journaling is downstream and must never strand a waiter.
export interface SettleContext {
  readonly restore: Restore;
  readonly sink: InteractionEventSinkShape;
}

interface SettleOptions extends SettleContext {
  readonly event: InteractionRuntimeEvent | null;
  readonly pending: PendingInteraction;
  readonly terminal: InteractionTerminal;
}

export const settleMany = (
  context: SettleContext,
  settlements: readonly Omit<SettleOptions, keyof SettleContext>[]
): Effect.Effect<void> =>
  Effect.forEach(
    settlements,
    ({ pending, terminal }) =>
      Deferred.succeed(pending.deferred, terminal).pipe(Effect.asVoid),
    { discard: true }
  ).pipe(
    Effect.andThen(
      Effect.forEach(
        settlements,
        ({ event }) =>
          event === null
            ? Effect.void
            : context.restore(context.sink.emit(event)),
        { discard: true }
      )
    )
  );

export const settleAndEmit = ({
  event,
  pending,
  restore,
  sink,
  terminal,
}: SettleOptions): Effect.Effect<void> =>
  Deferred.succeed(pending.deferred, terminal).pipe(
    Effect.andThen(event === null ? Effect.void : restore(sink.emit(event))),
    Effect.asVoid
  );

// Apply a validated response result: settle the waiter and emit the resolved
// event, or fail with the typed rejection. Shared by permission and elicitation
// responses so the branch handling stays in one place.
export const settleRespond = (
  context: SettleContext,
  correlationId: InteractionCorrelationId,
  result: RespondResult
): Effect.Effect<void, InteractionError> => {
  switch (result.type) {
    case "not-pending": {
      return Effect.fail(
        new InteractionNotPendingError({
          correlationId,
          reason: result.reason,
        })
      );
    }
    case "invalid": {
      return Effect.fail(
        new InteractionInvalidResponseError({
          correlationId,
          detail: result.detail,
        })
      );
    }
    case "resolved": {
      return settleAndEmit({
        ...context,
        event: respondedResolvedEvent(correlationId, result.response),
        pending: result.pending,
        terminal: {
          response: result.response,
          state: "responded",
        },
      });
    }
    default: {
      return result satisfies never;
    }
  }
};

/*
 * The lifetime bound (RFC 0003): take a request out of pending and settle it as
 * cancelled, exactly as a `$/cancel_request` would. Going through `takeOne`
 * rather than only completing the deferred is what frees the session's admission
 * slot — waking the waiter alone would hold the reservation for the life of the
 * connection. `takeOne` also makes this a no-op when a real response won the
 * race.
 *
 * Uninterruptible as a whole, and the emit's `restore` is identity rather than a
 * mask's: this runs from the timeout's `orElse`, where the awaiting fiber is
 * already being interrupted, so re-enabling interruption around the emit would
 * kill it and drop the `resolved` event — leaving a settled request that never
 * told anyone.
 */
const expirePending = ({
  correlationId,
  sink,
  state,
}: {
  readonly correlationId: InteractionCorrelationId;
  readonly sink: InteractionEventSinkShape;
  readonly state: Ref.Ref<InteractionState>;
}): Effect.Effect<void> =>
  takeOne(state, correlationId).pipe(
    Effect.flatMap((result) =>
      result.type === "taken"
        ? settleAndEmit({
            event: cancelledResolvedEvent(correlationId, result.pending.kind),
            pending: result.pending,
            restore: (effect) => effect,
            sink,
            terminal: { state: "cancelled-by-request" },
          })
        : Effect.void
    ),
    Effect.uninterruptible
  );

/**
 * Await a settlement, bounded by the config's pending lifetime when it sets one
 * (RFC 0003). With no `pendingTimeout` the await is unbounded, which is the
 * default: a pending request is normally a human being asked something, and a
 * user who walks away from a prompt must find it still waiting.
 */
export const awaitOutcomeWithin = (
  context: {
    readonly config: InteractionConfig;
    readonly sink: InteractionEventSinkShape;
    readonly state: Ref.Ref<InteractionState>;
  },
  correlationId: InteractionCorrelationId,
  deferred: Deferred.Deferred<InteractionTerminal>
): Effect.Effect<InteractionTerminal> => {
  const { pendingTimeout } = context.config;
  if (pendingTimeout === undefined) {
    return Deferred.await(deferred);
  }
  return Deferred.await(deferred).pipe(
    Effect.timeoutOrElse({
      duration: pendingTimeout,
      orElse: () =>
        expirePending({
          ...context,
          correlationId,
        }).pipe(
          Effect.as({
            state: "cancelled-by-request",
          } satisfies InteractionTerminal)
        ),
    })
  );
};
