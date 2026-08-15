import { Context, Deferred, Effect, Layer, Ref, Semaphore } from "effect";

import type { PermissionOptionKind } from "../../../contracts/author/src/agent-event.ts";
import type { SessionId } from "../../../contracts/internal/src/ids.ts";
import type {
  InteractionCapacityError,
  InteractionError,
} from "./errors.ts";
import type { InteractionEventSinkShape } from "./events.ts";
import type {
  ElicitationAcceptedContent,
  ElicitationResponse,
  InteractionConfig,
  InteractionCorrelationId,
  InteractionFailureState,
  InteractionHandle,
  InteractionTerminal,
  PermissionResponse,
  RegisterInput,
} from "./model.ts";
import type { InteractionState } from "./state.ts";

import { takeAll, takeSession } from "./drain.ts";
import {
  InteractionInvalidResponseError,
  InteractionNotPendingError,
} from "./errors.ts";
import {
  InteractionEventSink,
  cancelledResolvedEvent,
  elicitationRequestedEvent,
  permissionRequestedEvent,
} from "./events.ts";
import { defaultInteractionConfig } from "./model.ts";
import {
  awaitOutcomeWithin,
  settleAndEmit,
  settleMany,
  settleRespond,
} from "./settle.ts";
import {
  initialState,
  peekAcceptValidator,
  reserve,
  resolveElicitation,
  resolvePermission,
  resolvePermissionKind,
  takeOne,
} from "./state.ts";

export interface InteractionServiceShape {
  /**
   * Cancel one pending interaction because its transport request was cancelled
   * ($/cancel_request). Fails when the correlationId is not currently pending.
   */
  readonly cancelByRequest: (
    correlationId: InteractionCorrelationId
  ) => Effect.Effect<void, InteractionNotPendingError>;
  /**
   * Cancel every pending interaction for a session, settling permissions as
   * `cancelled` and waking every waiter. Never fails.
   */
  readonly cancelBySession: (sessionId: SessionId) => Effect.Effect<void>;
  /**
   * Fail one pending interaction, wake its waiter, and emit no resolved event.
   * Fails when the correlationId is not currently pending.
   */
  readonly fail: (
    correlationId: InteractionCorrelationId,
    reason: "failed-invalid" | "failed-surface-disconnect"
  ) => Effect.Effect<void, InteractionNotPendingError>;
  /**
   * Fail every pending interaction (peer exit / shutdown) and wake every
   * waiting fiber with the failure terminal. Never fails.
   */
  readonly failAll: (reason?: InteractionFailureState) => Effect.Effect<void>;
  /**
   * Register, publish the requested event, and return its settlement handle.
   * Fails when a pending bound is exceeded.
   */
  readonly register: (
    input: RegisterInput
  ) => Effect.Effect<InteractionHandle, InteractionCapacityError>;
  /**
   * Submit an elicitation response. Accepted content is schema-validated;
   * invalid content leaves the request pending.
   */
  readonly respondElicitation: (
    correlationId: InteractionCorrelationId,
    response: ElicitationResponse
  ) => Effect.Effect<void, InteractionError>;
  /**
   * Submit a permission outcome (selected optionId | cancelled) by
   * correlationId. Validates the kind and that a selected optionId was offered
   * before transitioning.
   */
  readonly respondPermission: (
    correlationId: InteractionCorrelationId,
    response: PermissionResponse
  ) => Effect.Effect<void, InteractionError>;
  /**
   * Select a permission by its journal-safe option kind. The service resolves
   * the kind to the one matching wire option id retained in memory.
   */
  readonly respondPermissionKind: (
    correlationId: InteractionCorrelationId,
    kind: PermissionOptionKind
  ) => Effect.Effect<void, InteractionError>;
}

const makeRegister = (deps: {
  readonly config: InteractionConfig;
  readonly sink: InteractionEventSinkShape;
  readonly state: Ref.Ref<InteractionState>;
  readonly transitionGate: Semaphore.Semaphore;
}): InteractionServiceShape["register"] =>
  Effect.fn("InteractionService.register")((input: RegisterInput) =>
    deps.transitionGate.withPermit(
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const deferred = yield* Deferred.make<InteractionTerminal>();
          const reservation = yield* reserve({
            config: deps.config,
            deferred,
            input,
            state: deps.state,
          });
          if (reservation.type === "capacity") {
            return yield* reservation.error;
          }
          const { correlationId } = reservation;
          const requestedEvent =
            input.kind === "permission"
              ? permissionRequestedEvent(correlationId, input)
              : elicitationRequestedEvent(correlationId, input);
          yield* restore(
            deps.sink.emit(requestedEvent).pipe(
              Effect.onInterrupt(() =>
                takeOne(deps.state, correlationId).pipe(
                  Effect.flatMap((result) => {
                    if (result.type !== "taken") {
                      return Effect.void;
                    }
                    return Deferred.succeed(result.pending.deferred, {
                      state: "cancelled-by-request",
                    }).pipe(Effect.asVoid);
                  })
                )
              )
            )
          );
          return {
            awaitOutcome: awaitOutcomeWithin(deps, correlationId, deferred),
            correlationId,
          } satisfies InteractionHandle;
        })
      )
    )
  );

const makeRespondPermission = (
  state: Ref.Ref<InteractionState>,
  sink: InteractionEventSinkShape
): InteractionServiceShape["respondPermission"] =>
  Effect.fn("InteractionService.respondPermission")(
    (correlationId: InteractionCorrelationId, response: PermissionResponse) =>
      Effect.uninterruptibleMask((restore) =>
        resolvePermission(state, correlationId, response).pipe(
          Effect.flatMap((result) =>
            settleRespond(
              {
                restore,
                sink,
              },
              correlationId,
              result
            )
          )
        )
      )
  );

const makeRespondPermissionKind = (
  state: Ref.Ref<InteractionState>,
  sink: InteractionEventSinkShape
): InteractionServiceShape["respondPermissionKind"] =>
  Effect.fn("InteractionService.respondPermissionKind")(
    (correlationId: InteractionCorrelationId, kind: PermissionOptionKind) =>
      Effect.uninterruptibleMask((restore) =>
        resolvePermissionKind(state, correlationId, kind).pipe(
          Effect.flatMap((result) =>
            settleRespond(
              {
                restore,
                sink,
              },
              correlationId,
              result
            )
          )
        )
      )
  );
// Validate before settling so invalid content leaves the request pending.
// If it settles concurrently, the atomic transition reports it as not pending.
const validateAcceptedContent = (
  state: Ref.Ref<InteractionState>,
  correlationId: InteractionCorrelationId,
  content: ElicitationAcceptedContent | undefined
): Effect.Effect<
  ElicitationAcceptedContent | undefined,
  InteractionInvalidResponseError
> =>
  peekAcceptValidator(state, correlationId).pipe(
    Effect.flatMap((validate) =>
      validate === undefined
        ? Effect.succeed(content)
        : validate(content ?? {}).pipe(
            Effect.map((validated) =>
              content === undefined ? undefined : validated
            ),
            Effect.mapError(
              (rejection) =>
                new InteractionInvalidResponseError({
                  correlationId,
                  detail: rejection.detail,
                })
            )
          )
    )
  );

const makeRespondElicitation = (
  state: Ref.Ref<InteractionState>,
  sink: InteractionEventSinkShape
): InteractionServiceShape["respondElicitation"] =>
  Effect.fn("InteractionService.respondElicitation")(
    (correlationId: InteractionCorrelationId, response: ElicitationResponse) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const content =
            response.action === "accept"
              ? yield* validateAcceptedContent(
                  state,
                  correlationId,
                  response.content
                )
              : undefined;
          const result = yield* resolveElicitation(state, correlationId, {
            action: response.action,
            content,
          });
          return yield* settleRespond(
            {
              restore,
              sink,
            },
            correlationId,
            result
          );
        })
      )
  );
const makeCancelByRequest = (
  state: Ref.Ref<InteractionState>,
  sink: InteractionEventSinkShape
): InteractionServiceShape["cancelByRequest"] =>
  Effect.fn("InteractionService.cancelByRequest")(
    (correlationId: InteractionCorrelationId) =>
      Effect.uninterruptibleMask((restore) =>
        takeOne(state, correlationId).pipe(
          Effect.flatMap((result) =>
            result.type === "not-pending"
              ? Effect.fail(
                  new InteractionNotPendingError({
                    correlationId,
                    reason: result.reason,
                  })
                )
              : settleAndEmit({
                  event: cancelledResolvedEvent(
                    correlationId,
                    result.pending.kind
                  ),
                  pending: result.pending,
                  restore,
                  sink,
                  terminal: { state: "cancelled-by-request" },
                })
          )
        )
      )
  );
const makeCancelBySession = (
  state: Ref.Ref<InteractionState>,
  sink: InteractionEventSinkShape,
  transitionGate: Semaphore.Semaphore
): InteractionServiceShape["cancelBySession"] =>
  Effect.fn("InteractionService.cancelBySession")((sessionId: SessionId) =>
    transitionGate.withPermit(
      Effect.uninterruptibleMask((restore) =>
        takeSession(state, sessionId).pipe(
          Effect.flatMap((taken) =>
            settleMany(
              {
                restore,
                sink,
              },
              taken.map((pending) => ({
                event: cancelledResolvedEvent(
                  pending.correlationId,
                  pending.kind
                ),
                pending,
                terminal: { state: "cancelled-by-session" },
              }))
            )
          )
        )
      )
    )
  );

const makeFail = (
  state: Ref.Ref<InteractionState>,
  sink: InteractionEventSinkShape
): InteractionServiceShape["fail"] =>
  Effect.fn("InteractionService.fail")(
    (
      correlationId: InteractionCorrelationId,
      reason: "failed-invalid" | "failed-surface-disconnect"
    ) =>
      Effect.uninterruptibleMask((restore) =>
        takeOne(state, correlationId).pipe(
          Effect.flatMap((result) =>
            result.type === "not-pending"
              ? Effect.fail(
                  new InteractionNotPendingError({
                    correlationId,
                    reason: result.reason,
                  })
                )
              : settleAndEmit({
                  event: null,
                  pending: result.pending,
                  restore,
                  sink,
                  terminal: { state: reason },
                })
          )
        )
      )
  );

const makeFailAll = (
  state: Ref.Ref<InteractionState>,
  sink: InteractionEventSinkShape,
  transitionGate: Semaphore.Semaphore
): InteractionServiceShape["failAll"] =>
  Effect.fn("InteractionService.failAll")(
    (reason: InteractionFailureState = "failed-peer-exit") =>
      transitionGate.withPermit(
        Effect.uninterruptibleMask((restore) =>
          takeAll(state).pipe(
            Effect.flatMap((taken) =>
              settleMany(
                {
                  restore,
                  sink,
                },
                taken.map((pending) => ({
                  event: null,
                  pending,
                  terminal: { state: reason },
                }))
              )
            )
          )
        )
      )
  );

const make = Effect.fn("InteractionService.make")(function* (
  config: InteractionConfig
) {
  const sink = yield* InteractionEventSink;
  const state = yield* Ref.make<InteractionState>(initialState);
  const transitionGate = yield* Semaphore.make(1);
  return {
    cancelByRequest: makeCancelByRequest(state, sink),
    cancelBySession: makeCancelBySession(state, sink, transitionGate),
    fail: makeFail(state, sink),
    failAll: makeFailAll(state, sink, transitionGate),
    register: makeRegister({
      config,
      sink,
      state,
      transitionGate,
    }),
    respondElicitation: makeRespondElicitation(state, sink),
    respondPermission: makeRespondPermission(state, sink),
    respondPermissionKind: makeRespondPermissionKind(state, sink),
  };
});

export class InteractionService extends Context.Service<
  InteractionService,
  InteractionServiceShape
>()("ori/engine/interaction/InteractionService") {
  static readonly layer = (
    config: InteractionConfig = defaultInteractionConfig
  ): Layer.Layer<InteractionService, never, InteractionEventSink> =>
    Layer.effect(InteractionService)(make(config));
}
