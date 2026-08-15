import type { Scope } from "effect";

import { Deferred, Effect, Fiber, Option, Ref, Stream } from "effect";

import type {
  AgentAdapterEvent,
  AgentAdapterObservation,
} from "../../../contracts/internal/src/runtime/agent-adapter-event.ts";
import type { AcpAgentConnectionError } from "../../acp-agent/src/errors.ts";
import type { AcpAgentConnectionShape } from "../../acp-agent/src/service.ts";

import type { PromptTurn } from "./prompt-turn.ts";

import { settlePromptTurn } from "./prompt-settlement.ts";

/**
 * Runs a blocking native interaction (an elicitation or permission round trip) as
 * a scoped fiber and publishes it as the adapter's cancellable interaction, so a
 * `session/cancel` can interrupt it mid-request.
 *
 * The slot is cleared by a forked waiter rather than inline because the caller is
 * the event loop: blocking it on this interaction would stall the very stream
 * that carries the native peer's answer. The compare-and-clear keeps a later
 * interaction that already claimed the slot from being wiped out by this one's
 * completion.
 */
export const forkTrackedInteraction = (
  activeInteraction: Ref.Ref<Option.Option<Fiber.Fiber<void>>>,
  interaction: Effect.Effect<void>
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.forkScoped(interaction).pipe(
    Effect.flatMap((fiber) =>
      Ref.set(activeInteraction, Option.some(fiber)).pipe(
        Effect.andThen(
          Fiber.await(fiber).pipe(
            Effect.andThen(
              Ref.update(activeInteraction, (current) =>
                Option.isSome(current) && current.value === fiber
                  ? Option.none()
                  : current
              )
            ),
            Effect.forkScoped
          )
        )
      )
    ),
    Effect.asVoid
  );

/**
 * Builds the adapter's session-scoped fan-out: project one native event, then
 * send each `acp.session_update` across the ACP wire and hand every other
 * observation to the adapter's out-of-band reporter (per ROUTEKIT_EVAL-405/423, retry and
 * compaction observations never join `AcpSessionUpdate`).
 *
 * `project` is passed as a closure rather than a projector value because each
 * adapter's projector takes its own extra arguments (Pi threads a cumulative-cost
 * ref through it).
 */
export const makeNotifyUpdates = <Event, ProjectErr>(input: {
  readonly agent: Deferred.Deferred<AcpAgentConnectionShape>;
  readonly project: (
    event: Event
  ) => Effect.Effect<readonly AgentAdapterEvent[], ProjectErr>;
  readonly reportObservation: (
    observation: AgentAdapterObservation
  ) => Effect.Effect<void>;
  readonly spanPrefix: string;
}): ((
  sessionId: string,
  event: Event
) => Effect.Effect<void, AcpAgentConnectionError | ProjectErr>) =>
  Effect.fn(`${input.spanPrefix}.notifyUpdates`)(function* (
    sessionId: string,
    event: Event
  ) {
    const connection = yield* Deferred.await(input.agent);
    const projected = yield* input.project(event);
    for (const item of projected) {
      yield* item.event === "acp.session_update"
        ? connection.notify("session/update", {
            sessionId,
            update: item.update,
          })
        : input.reportObservation(item);
    }
  });

/**
 * The adapter's `run`: pump the native event stream until the peer closes.
 *
 * A stream failure settles the waiting prompt rather than propagating, so a dead
 * native connection surfaces as a failed turn instead of a failed adapter. The
 * loop only ends when the native peer closes (graceful shutdown, process exit, or
 * interruption of this fiber); however it ends, `onEnded` settles any prompt still
 * awaiting its turn so the client is never left hanging on a dead connection.
 * `ensuring` also covers interruption, which `andThen` would miss.
 */
export const makeNativeEventLoop = <
  Event,
  Err extends object,
  StreamErr,
  ProjectErr,
>(input: {
  readonly activePrompt: Ref.Ref<Option.Option<PromptTurn<Err>>>;
  readonly events: Stream.Stream<Event, StreamErr>;
  readonly onEnded: Effect.Effect<void>;
  readonly onStreamFailure: (error: ProjectErr | StreamErr) => Err;
  readonly projectEvent: (
    event: Event
  ) => Effect.Effect<void, ProjectErr, Scope.Scope>;
}): Effect.Effect<void, never, Scope.Scope> =>
  input.events.pipe(
    Stream.runForEach((event) => input.projectEvent(event)),
    Effect.catch((error) =>
      settlePromptTurn(input.activePrompt, input.onStreamFailure(error))
    ),
    Effect.ensuring(input.onEnded)
  );
