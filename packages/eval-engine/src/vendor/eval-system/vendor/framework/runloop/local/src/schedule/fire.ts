import { Data, Effect, Option } from "effect";

import type { AgentRuntimeEvent } from "../../../../contracts/author/src/agent-event.ts";
import type { AgentFailure } from "../../../../contracts/author/src/errors/agent-failure.ts";
import type { ApiFeatureContext } from "../../../../contracts/author/src/api.ts";
import type { McpResolver } from "../../../../contracts/author/src/mcp.ts";
import type {
  AgentRun,
  ScheduleDefinition,
  ScheduleHandlerArgs,
  ScheduleInvokeInput,
} from "../../../../contracts/author/src/schedule.ts";
import type { ScheduleFireTarget } from "./catch-up.ts";
import type { ScheduleRuntimeShape } from "./types.ts";

import { AgentRuntimeEventTag } from "../../../../contracts/author/src/agent-event.ts";
import { selectMoreSpecificAgentFailure } from "../../../../contracts/author/src/errors/agent-failure.ts";
import { RuntimeServerError } from "../../../../contracts/internal/src/errors.ts";
import { makeAgentRun } from "../agent/run.ts";
import { noopFeatureLogger } from "../logging/support.ts";
import {
  recordFireFailure,
  recordFireOutcome,
} from "./record.ts";
import { formatUnknownError } from "../../../../utils/core/src/error-formatting.ts";

const EMPTY_BUFFER = 0;

/**
 * The rejection a fire throws for a terminal failure it already wrote to run
 * history. Exported so catch-up can tell it apart from an unrelated rejection
 * rather than inferring "this is the one already recorded" from having seen a
 * failed turn — a run can recover from one and then die for another reason.
 */
export class ScheduleAgentFailureError extends Data.TaggedError(
  "ScheduleAgentFailureError"
)<{
  readonly failure: AgentFailure;
}> {
  override get message(): string {
    return this.failure.message;
  }
}

/** Observes every agent event a fire produces, in order, as it is drained. */
export type ScheduleFireObserver = (event: AgentRuntimeEvent) => void;

interface ScheduleFireObservation {
  failure?: AgentFailure | undefined;
  readonly sessionIds: Set<string>;
}

const makeScheduleFireObservation = (): ScheduleFireObservation => ({
  sessionIds: new Set(),
});

const observeScheduleEvent = (
  observation: ScheduleFireObservation,
  event: AgentRuntimeEvent
): void => {
  if (
    (event.type === AgentRuntimeEventTag.SessionStarted ||
      event.type === AgentRuntimeEventTag.SessionFailed) &&
    event.payload.sessionId !== undefined
  ) {
    observation.sessionIds.add(event.payload.sessionId);
  }
  if (
    event.type === AgentRuntimeEventTag.SessionFailed ||
    event.type === AgentRuntimeEventTag.TurnFailed
  ) {
    observation.failure = selectMoreSpecificAgentFailure(
      observation.failure,
      event.payload.failure
    );
    return;
  }
  // A terminal success after a failure means the run recovered — a retried
  // turn, or a resume after a stale session. Without this the recovery still
  // lands in run history as an error, and the operator chases a failure that
  // already fixed itself.
  if (
    event.type === AgentRuntimeEventTag.SessionSucceeded ||
    event.type === AgentRuntimeEventTag.TurnSucceeded
  ) {
    observation.failure = undefined;
  }
};

/**
 * Fire a single schedule once: dispatch its `markdown` prompt (drained) or call
 * its `run` handler, recording any started session ids. Powers both the cron
 * fire loop and the dev dispatch route (RFC 0002 schedule.md, RFC 0008).
 *
 * `onEvent` taps every agent event as it is drained — used by the streaming
 * dispatch route to forward the run live — without changing how the fire runs.
 */
export const fireScheduleOnce = async (fireInput: {
  readonly definition: ScheduleDefinition;
  readonly onEvent?: ScheduleFireObserver | undefined;
  readonly runtime: ScheduleRuntimeShape;
  readonly use: ApiFeatureContext["use"];
  readonly mcp: McpResolver;
}): Promise<readonly string[]> => {
  const observation = makeScheduleFireObservation();
  const handlerArgs: ScheduleHandlerArgs = {
    invoke: <A = unknown>(invokeInput: ScheduleInvokeInput<A>): AgentRun<A> =>
      makeAgentRun<A>({
        onEvent: (event) => {
          observeScheduleEvent(observation, event);
          fireInput.onEvent?.(event);
        },
        output: Option.fromNullishOr(invokeInput.output),
        prompt: invokeInput.prompt,
        source: (prompt) =>
          fireInput.runtime.invoke({
            ...invokeInput,
            prompt,
          }),
      }),
    logger: Option.getOrElse(fireInput.runtime.logger, () => noopFeatureLogger),
    mcp: fireInput.mcp,
    use: fireInput.use,
    store: fireInput.runtime.store,
  };

  const customRun = fireInput.definition.run !== undefined;
  if (customRun) {
    await fireInput.definition.run(handlerArgs);
  } else if (fireInput.definition.markdown !== undefined) {
    for await (const _event of handlerArgs.invoke({
      prompt: fireInput.definition.markdown,
    })) {
      // Drain so the run completes before the fire resolves.
    }
  }

  // A custom handler owns the control flow around each invoke and may recover,
  // retry, or deliberately tolerate a failed turn. Markdown schedules have no
  // such handler, so their terminal failure must fail the fire.
  if (!customRun && observation.failure !== undefined) {
    throw new ScheduleAgentFailureError({
      failure: observation.failure,
    });
  }
  return [...observation.sessionIds];
};

/**
 * Fire a schedule once and persist the outcome to run history (RFC 0002 schedule.md). On
 * success records the started session ids; on failure records the error and
 * rethrows. History writes are best-effort and never break or mask a fire.
 */
export interface ScheduleFireOptions {
  readonly now?: () => number;
  readonly onEvent?: ScheduleFireObserver;
}

// Tagged wrapper that keeps `fireAndRecord`'s failure channel typed instead of
// the raw `unknown` the language-service flags (unknownInEffectCatch), WITHOUT
// changing the "reject with the raw cause, not a wrapped error" contract below:
// its `message` delegates to `formatUnknownError(cause)`, and every downstream
// consumer (`fireScheduleDetachedEffect`'s `RuntimeServerError` mapping,
// `recordFireFailure`, the `tapError` breadcrumb) reads the cause back through
// `formatUnknownError`, which returns that same `.message` — so the detail text
// is neither nested nor otherwise changed. The original cause stays available on
// `.cause` for any structural inspection.
class ScheduleFireError extends Data.TaggedError("ScheduleFireError")<{
  readonly cause: unknown;
}> {
  override get message(): string {
    return formatUnknownError(this.cause);
  }
}

/**
 * The structured failure that ended this fire, when the rejection is the
 * terminal agent failure itself.
 *
 * Keyed on the rejection rather than on "a failed turn was seen at some point":
 * a run that recovered from one and then died for an unrelated reason would
 * otherwise be filed in history under the problem it had already moved past,
 * pointing whoever investigates at the wrong thing.
 */
const terminalFailureOf = (
  error: unknown
): { readonly failure?: AgentFailure } => {
  const cause = error instanceof ScheduleFireError ? error.cause : error;
  return cause instanceof ScheduleAgentFailureError
    ? { failure: cause.failure }
    : {};
};

export const fireAndRecord = (
  target: ScheduleFireTarget,
  options: ScheduleFireOptions = {}
): Promise<readonly string[]> => {
  const { name, definition, runtime } = target;
  const now = options.now ?? ((): number => Date.now());
  const { onEvent } = options;
  const observation = makeScheduleFireObservation();
  const observeEvent = (event: AgentRuntimeEvent): void => {
    observeScheduleEvent(observation, event);
    onEvent?.(event);
  };
  const startedAt = now();
  const firedAt = new Date(startedAt).toISOString();
  return Effect.runPromise(
    Effect.tryPromise({
      // Carry the raw cause through unchanged (not a re-detailed error):
      // `fireScheduleDetachedEffect` is the single boundary that maps a fire
      // failure to a typed `RuntimeServerError` for HTTP callers, and the
      // `tapError` handlers below only stringify the cause for run history /
      // logs. `ScheduleFireError` is a transparent typed wrapper whose `message`
      // is exactly `formatUnknownError(cause)`, so none of those consumers see
      // nested or altered detail text; the original cause stays on `.cause`.
      catch: (cause) => new ScheduleFireError({ cause }),
      try: () =>
        fireScheduleOnce({
          definition,
          onEvent: observeEvent,
          runtime,
          use: runtime.useFor(target.featureId),
          mcp: runtime.mcpFor(target.featureId),
        }),
    }).pipe(
      Effect.tap((sessionIds) =>
        recordFireOutcome({
          firedAt,
          name,
          now,
          runtime,
          sessionIds,
          startedAt,
        })
      ),
      // Human-facing breadcrumb on the diagnostic logger (RFC 0011); run history
      // remains the durable record.
      Effect.tapError((error) =>
        recordFireFailure({
          error,
          ...terminalFailureOf(error),
          firedAt,
          name,
          now,
          runtime,
          sessionIds: [...observation.sessionIds],
          startedAt,
        })
      )
    )
  );
};

/**
 * Fire a schedule for the dev dispatch route **without blocking on the full run**
 * (RFC 0008). The fire starts in the background; this resolves as soon as the
 * first session id is known (the first `SessionStarted`) or the fire settles —
 * whichever comes first — so the HTTP response returns promptly even when a
 * complex agent run takes minutes. The run keeps going after this resolves, and
 * its outcome is still durably recorded by {@link fireAndRecord}; observe it via
 * `routekit-eval schedules list <name>`.
 *
 * The resolved array is a prompt **handle**, not an exhaustive session list: a
 * multi-invoke `run` handler resolves with only the session id(s) known at the
 * first `SessionStarted`, since waiting for every `invoke` would reintroduce the
 * blocking this path exists to avoid. The full set is durably recorded in run
 * history, and the streaming dispatch ({@link streamScheduleFire}) surfaces every
 * session live for callers that need them all.
 *
 * A fire that fails *before* starting any session (a `run` handler that throws
 * immediately, or an `/api/invoke` connection failure) rejects so the caller can
 * surface it as a 500. A fire that fails *after* a session has started has
 * already resolved, so that error is observable only in run history — the same
 * fire-never-blocks-the-caller tradeoff cron fires make.
 */
export const fireScheduleDetached = (
  target: ScheduleFireTarget,
  now: () => number = () => Date.now(),
  // Called once the fire has fully completed (not at first session). The dev
  // dispatch route passes this to close its per-request runtime's MCP
  // connections; cron/catch-up omit it, since they share a long-lived runtime.
  onComplete?: () => void
): Promise<readonly string[]> => {
  const sessionIds = new Set<string>();
  const ready = Promise.withResolvers<readonly string[]>();
  let settled = false;
  const resolveStarted = (): void => {
    if (!settled) {
      settled = true;
      ready.resolve([...sessionIds]);
    }
  };

  void fireAndRecord(target, {
    now,
    onEvent: (event) => {
      if (
        event.type === AgentRuntimeEventTag.SessionStarted &&
        event.payload.sessionId !== undefined
      ) {
        sessionIds.add(event.payload.sessionId);
        resolveStarted();
      }
    },
  })
    .then(resolveStarted, (error: unknown) => {
      if (!settled) {
        settled = true;
        ready.reject(error);
      }
      // A failure after a session was already surfaced is left to run history.
    })
    .finally(() => onComplete?.());

  return ready.promise;
};

/**
 * Effect wrapper over {@link fireScheduleDetached} for HTTP callers (the dev
 * dispatch route, RFC 0008). A fire that fails before any session started becomes
 * a typed `RuntimeServerError` instead of an uncatchable defect, so the daemon's
 * error handler returns a clean 500.
 */
export const fireScheduleDetachedEffect = (
  target: ScheduleFireTarget,
  // Forwarded to {@link fireScheduleDetached}: the dispatch route passes a
  // per-request MCP teardown; catch-up omits it (shared runtime).
  onComplete?: () => void
): Effect.Effect<readonly string[], RuntimeServerError> =>
  Effect.tryPromise({
    catch: (cause) =>
      new RuntimeServerError({
        cause,
        detail: `Schedule "${target.name}" fire failed: ${formatUnknownError(cause)}`,
        operation: "firing schedule",
      }),
    try: () => fireScheduleDetached(target, undefined, onComplete),
  });

/**
 * Fire a schedule once and yield its agent events live, in order, as they
 * arrive — then settle when the run finishes. Run history is still recorded by
 * {@link fireAndRecord}; a fire failure is swallowed here (it is durably
 * recorded, and any error is normally already reflected in a streamed
 * `session.failed`/`runtime.error` event) so a truncation never masks an
 * otherwise-complete stream. Powers the dev dispatch route's `--stream` mode
 * (RFC 0008): the daemon pipes these events straight to the client.
 */
export const streamScheduleFire = (
  target: ScheduleFireTarget,
  // Called once the fire completes; the dispatch route closes its per-request
  // runtime's MCP connections here (cron/catch-up do not stream).
  onComplete?: () => void
): AsyncIterable<AgentRuntimeEvent> => {
  const buffered: AgentRuntimeEvent[] = [];
  // `finished` lives on a mutable container rather than a `let`: it is flipped to
  // `true` inside the `.then()` callbacks below, which TS control-flow analysis
  // cannot track. A bare `let finished = false` would narrow to the literal
  // `false`, making the load-bearing `state.finished` termination check read as
  // always-falsy; a `: boolean` annotation would instead trip `no-inferrable-types`.
  // A field access is not subject to that literal-narrowing.
  const state = { finished: false };
  let wake = Promise.withResolvers<undefined>();
  const resume = (): void => {
    wake.resolve(undefined);
  };

  void fireAndRecord(target, {
    onEvent: (event) => {
      buffered.push(event);
      resume();
    },
  })
    .then(
      () => {
        state.finished = true;
        resume();
      },
      () => {
        state.finished = true;
        resume();
      }
    )
    .finally(() => onComplete?.());

  return (async function* drainFire() {
    for (;;) {
      while (buffered.length > EMPTY_BUFFER) {
        const next = buffered.shift();
        if (next !== undefined) {
          yield next;
        }
      }
      if (state.finished) {
        return;
      }
      await wake.promise;
      wake = Promise.withResolvers<undefined>();
    }
  })();
};
