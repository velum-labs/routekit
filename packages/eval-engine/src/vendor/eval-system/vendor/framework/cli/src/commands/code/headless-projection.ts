import { Match } from "effect";

import type { RuntimeStreamEvent } from "../../../../contracts/internal/src/runtime/stream-event.ts";

import { formatAgentFailure } from "../../../../contracts/author/src/errors/agent-failure.ts";
import { AgentRuntimeEventTag } from "../../../../contracts/internal/src/runtime/agent-runtime-event.ts";

/**
 * How a headless run ended, and with which process exit code. `succeeded` is
 * the only zero-exit outcome; a stream that closes without a terminal event is
 * an `incomplete` failure rather than a silent success.
 */
interface HeadlessTermination {
  readonly detail: string | undefined;
  readonly exitCode: number;
  readonly outcome: "failed" | "incomplete" | "succeeded";
  readonly summary: HeadlessRunSummary | undefined;
}

interface HeadlessRunSummary {
  readonly contextTokens: number | undefined;
  readonly costUsd: number | undefined;
  readonly durationMs: number | undefined;
  readonly inputTokens: number | undefined;
  readonly model: string | undefined;
  readonly outputTokens: number | undefined;
  readonly requestedModel: string | undefined;
}

/**
 * What a single stream event contributes to a headless run's output. Assistant
 * prose is streamed to stdout, while the terminal event carries the narrow
 * summary data rendered after the stream. Reasoning, tool traffic, and item
 * lifecycle are dropped here and belong to the structured `--output jsonl`
 * stream instead.
 */
interface HeadlessProjection {
  readonly stderr: string;
  readonly stdout: string;
  readonly startedAt: string | undefined;
  readonly termination: HeadlessTermination | undefined;
}

const HEADLESS_FAILURE_EXIT = 1;
const HEADLESS_SUCCESS_EXIT = 0;

/**
 * Prefix for every error line this run puts on stderr. Shared with the run's
 * terminal-diagnostic write so the two produce byte-identical text for the same
 * message: a harness failure arrives twice (as `runtime.error`, then as the
 * terminal event's detail), and the run dedups them by string equality.
 */
const HEADLESS_DIAGNOSTIC_PREFIX = "error: ";
const HEADLESS_WARNING_PREFIX = "warning: ";

const EMPTY: HeadlessProjection = {
  stderr: "",
  stdout: "",
  startedAt: undefined,
  termination: undefined,
};

const failure = (
  outcome: "failed" | "incomplete",
  detail: string | undefined,
  summary?: HeadlessRunSummary
): HeadlessTermination => ({
  detail,
  exitCode: HEADLESS_FAILURE_EXIT,
  outcome,
  summary: summary ?? undefined,
});

const terminalSummary = (
  event: Extract<
    Extract<RuntimeStreamEvent, { readonly type: "runtime.event" }>["event"],
    {
      readonly type:
        | typeof AgentRuntimeEventTag.SessionFailed
        | typeof AgentRuntimeEventTag.TurnFailed
        | typeof AgentRuntimeEventTag.TurnSucceeded;
    }
  >
): HeadlessRunSummary => ({
  contextTokens: event.payload.usage?.contextTokens,
  costUsd: event.payload.usage?.costUsd,
  durationMs: undefined,
  inputTokens: event.payload.usage?.inputTokens,
  model: event.payload.usage?.model,
  outputTokens: event.payload.usage?.outputTokens,
  requestedModel:
    event.payload.usage?.model === undefined
      ? (event.model ?? undefined)
      : undefined,
});

// Sets the detail WITHOUT writing stderr: the run's single terminal-diagnostic
// write owns that text. Emitting it here too printed the same harness error
// three times (once here, once from the terminal write, once from the
// `runtime.error` arm) on a real bad-model run.
const terminatedBy = (
  label: string,
  error: string | undefined,
  summary: HeadlessRunSummary
): HeadlessProjection => ({
  stderr: "",
  stdout: "",
  startedAt: undefined,
  termination: failure("failed", error ?? label, summary),
});

const matchAgentEvent = Match.type<
  Extract<RuntimeStreamEvent, { readonly type: "runtime.event" }>["event"]
>().pipe(
  Match.discriminator("type")(
    AgentRuntimeEventTag.AssistantTextDelta,
    (event): HeadlessProjection => ({
      stderr: "",
      stdout: event.payload.delta,
      startedAt: undefined,
      termination: undefined,
    })
  ),
  Match.discriminator("type")(
    AgentRuntimeEventTag.TurnStarted,
    (event): HeadlessProjection => ({
      stderr: "",
      stdout: "",
      startedAt: event.createdAt,
      termination: undefined,
    })
  ),
  Match.discriminator("type")(
    AgentRuntimeEventTag.TurnSucceeded,
    (event): HeadlessProjection => ({
      stderr: "",
      stdout: "",
      startedAt: undefined,
      termination: {
        detail: undefined,
        exitCode: HEADLESS_SUCCESS_EXIT,
        outcome: "succeeded",
        summary: terminalSummary(event),
      },
    })
  ),
  Match.discriminator("type")(AgentRuntimeEventTag.TurnFailed, (event) =>
    terminatedBy(
      "turn failed",
      formatAgentFailure(event.payload.failure),
      terminalSummary(event)
    )
  ),
  Match.discriminator("type")(AgentRuntimeEventTag.SessionFailed, (event) =>
    terminatedBy(
      "session failed",
      formatAgentFailure(event.payload.failure),
      terminalSummary(event)
    )
  ),
  Match.discriminator("type")(
    AgentRuntimeEventTag.RuntimeError,
    (event): HeadlessProjection => ({
      stderr: `${HEADLESS_DIAGNOSTIC_PREFIX}${formatAgentFailure(event.payload.failure)}\n`,
      stdout: "",
      startedAt: undefined,
      termination: undefined,
    })
  ),
  Match.discriminator("type")(
    AgentRuntimeEventTag.RuntimeWarning,
    (event): HeadlessProjection => ({
      stderr: `${HEADLESS_WARNING_PREFIX}${event.payload.message}\n`,
      stdout: "",
      startedAt: undefined,
      termination: undefined,
    })
  ),
  Match.orElse((): HeadlessProjection => EMPTY)
);

/**
 * Project one runtime stream event onto a headless run's stdout/stderr and its
 * terminal outcome. Pure and total: an event this projection does not model
 * contributes nothing, so a future event tag degrades to silence rather than a
 * type error or a crash.
 */
const projectHeadlessEvent = (event: RuntimeStreamEvent): HeadlessProjection =>
  event.type === "runtime.event" ? matchAgentEvent(event.event) : EMPTY;

/** The outcome for a stream that closed without any terminal event. */
const headlessStreamEndedEarly = (): HeadlessTermination =>
  failure(
    "incomplete",
    "the run ended without completing a turn; see `routekit-eval logs` for the full stream"
  );

export {
  HEADLESS_DIAGNOSTIC_PREFIX,
  HEADLESS_FAILURE_EXIT,
  HEADLESS_SUCCESS_EXIT,
  HEADLESS_WARNING_PREFIX,
  headlessStreamEndedEarly,
  projectHeadlessEvent,
};
export type { HeadlessProjection, HeadlessRunSummary, HeadlessTermination };
