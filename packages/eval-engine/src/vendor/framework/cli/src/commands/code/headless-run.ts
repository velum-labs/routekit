import { Effect, Option, Ref, Stream } from "effect";

import type { InvokeRuntimeCommand } from "../../../../contracts/internal/src/runtime/command.ts";
import type { RuntimeStreamEvent } from "../../../../contracts/internal/src/runtime/stream-event.ts";
import type {
  HeadlessRunSummary,
  HeadlessTermination,
} from "./headless-projection.ts";

import { CliIo } from "../../../../contracts/internal/src/cli/cli-io.ts";
import { invokeRuntime } from "../../../../runloop/local/src/daemon/client/client.ts";
import { OriCliExit } from "../../cli-exit.ts";
import {
  HEADLESS_DIAGNOSTIC_PREFIX,
  HEADLESS_FAILURE_EXIT,
  HEADLESS_WARNING_PREFIX,
  headlessStreamEndedEarly,
  projectHeadlessEvent,
} from "./headless-projection.ts";
import { formatUnknownError } from "../../../../utils/core/src/error-formatting.ts";

const HEADLESS_NEWLINE = "\n";
const COST_DECIMALS = 6;
const SUMMARY_PREFIX = "summary";

interface HeadlessRunState {
  /** The last diagnostic already on stderr, so the terminal write can skip a repeat. */
  readonly lastDiagnostic: string | undefined;
  readonly sawText: boolean;
  readonly startedAt: string | undefined;
  readonly termination: HeadlessTermination | undefined;
  /** Assistant prose accumulated for the single stdout write at the end of the run. */
  readonly text: string;
}

const INITIAL: HeadlessRunState = {
  lastDiagnostic: undefined,
  sawText: false,
  startedAt: undefined,
  termination: undefined,
  text: "",
};

const durationSince = (
  startedAt: string | undefined,
  endedAt: string
): number | undefined => {
  if (startedAt === undefined) {
    return undefined;
  }
  const durationMs = Date.parse(endedAt) - Date.parse(startedAt);
  return Number.isFinite(durationMs) && durationMs >= 0
    ? durationMs
    : undefined;
};

const withDuration = (
  termination: HeadlessTermination,
  startedAt: string | undefined,
  endedAt: string
): HeadlessTermination => ({
  ...termination,
  summary:
    termination.summary === undefined
      ? undefined
      : {
          ...termination.summary,
          durationMs: durationSince(startedAt, endedAt),
        },
});

/**
 * Fold one event into the run state, writing only its diagnostics. Assistant
 * prose is accumulated instead of written: stdout carries the answer as one
 * write once the turn settles, so a caller reads a whole response rather than
 * a live token feed. The stderr write is ignored because a closed stream (the
 * reader hung up) must not turn into a run failure.
 */
const foldEventIntoState =
  (cliIo: CliIo["Service"], state: Ref.Ref<HeadlessRunState>) =>
  (event: RuntimeStreamEvent): Effect.Effect<void> =>
    Effect.gen(function* () {
      const projected = projectHeadlessEvent(event);
      if (projected.stderr !== "") {
        yield* cliIo.writeStderr(projected.stderr).pipe(Effect.ignore);
      }
      yield* Ref.update(state, (current) => ({
        lastDiagnostic:
          projected.stderr === "" ? current.lastDiagnostic : projected.stderr,
        sawText: current.sawText || projected.stdout !== "",
        startedAt: current.startedAt ?? projected.startedAt,
        termination:
          projected.termination === undefined
            ? current.termination
            : withDuration(
                projected.termination,
                current.startedAt ?? projected.startedAt,
                event.type === "runtime.event" ? event.event.createdAt : ""
              ),
        text: current.text + projected.stdout,
      }));
    });

/**
 * Print the collected answer as the run's single stdout write, newline
 * terminated. The write is ignored because a closed stdout (the reader hung
 * up) must not turn into a run failure.
 */
const writeAnswer = (
  cliIo: CliIo["Service"],
  text: string
): Effect.Effect<void> =>
  cliIo
    .writeStdout(
      text.endsWith(HEADLESS_NEWLINE) ? text : `${text}${HEADLESS_NEWLINE}`
    )
    .pipe(Effect.ignore);

const formatSummary = (summary: HeadlessRunSummary): string | undefined => {
  const segments: string[] = [];
  if (summary.model !== undefined) {
    segments.push(`model=${summary.model}`);
  }
  if (summary.requestedModel !== undefined) {
    segments.push(`requested-model=${summary.requestedModel}`);
  }
  if (summary.durationMs !== undefined) {
    segments.push(`duration=${Math.round(summary.durationMs)}ms`);
  }
  if (summary.inputTokens !== undefined) {
    segments.push(`input=${summary.inputTokens} tok`);
  }
  if (summary.outputTokens !== undefined) {
    segments.push(`output=${summary.outputTokens} tok`);
  }
  if (summary.contextTokens !== undefined) {
    segments.push(`context=${summary.contextTokens} tok`);
  }
  if (summary.costUsd !== undefined) {
    segments.push(`$${summary.costUsd.toFixed(COST_DECIMALS)}`);
  }
  return segments.length === 0
    ? undefined
    : `${SUMMARY_PREFIX}  ${segments.join("  ")}${HEADLESS_NEWLINE}`;
};

const writeSummary = Effect.fn("CodeCommand.writeSummary")(function* (input: {
  readonly cliIo: CliIo["Service"];
  readonly summary: HeadlessRunSummary;
  readonly sawText: boolean;
}) {
  const { cliIo, summary, sawText } = input;
  const formatted = formatSummary(summary);
  if (formatted === undefined) {
    return;
  }
  if (sawText) {
    yield* cliIo.writeStdout(HEADLESS_NEWLINE).pipe(Effect.ignore);
  }
  yield* cliIo.writeStdout(formatted).pipe(Effect.ignore);
});

/**
 * The terminal event's own diagnostic, unless the identical line is already on
 * stderr. A harness failure arrives twice (once as `runtime.error`, once as
 * the terminal event's detail) with the same message, so this carries the
 * `error: ` prefix the `runtime.error` arm writes and the comparison holds.
 */
const unduplicatedDetailLine = (
  detail: string | undefined,
  lastDiagnostic: string | undefined
): string | undefined => {
  if (detail === undefined) {
    return undefined;
  }
  const line = `${HEADLESS_DIAGNOSTIC_PREFIX}${detail}${HEADLESS_NEWLINE}`;
  return line === lastDiagnostic ? undefined : line;
};

const reportTransportFailure = (
  cliIo: CliIo["Service"],
  failure: string
): Effect.Effect<never, OriCliExit> =>
  cliIo
    .writeStderr(
      `The headless run could not be completed: ${failure}${HEADLESS_NEWLINE}`
    )
    .pipe(
      Effect.ignore,
      Effect.andThen(new OriCliExit({ exitCode: HEADLESS_FAILURE_EXIT }))
    );

/**
 * Run one headless turn against the already-booted daemon: collect the
 * assistant's prose, stream diagnostics to stderr, then print the answer in a
 * single write and resolve the process exit code from the run's terminal
 * event. A stream that closes without a terminal event is a failure, not a
 * silent success.
 */
export const runCodeHeadlessTurn = Effect.fn("CodeCommand.headlessTurn")(
  function* (input: {
    readonly command: InvokeRuntimeCommand;
    readonly daemon: { readonly host: string; readonly port: number };
  }) {
    const cliIo = yield* CliIo;
    const stateRef = yield* Ref.make(INITIAL);
    // Preserve collected prose when a transport fails, then report the failure
    // on stderr without rendering a structured envelope onto stdout.
    const transportFailure = yield* invokeRuntime(
      input.daemon,
      input.command
    ).pipe(
      Stream.runForEach(foldEventIntoState(cliIo, stateRef)),
      Effect.as(Option.none<string>()),
      Effect.catch((error) =>
        Effect.succeed(Option.some(formatUnknownError(error)))
      )
    );

    const final = yield* Ref.get(stateRef);
    const sawText = final.text !== "";
    if (sawText) {
      yield* writeAnswer(cliIo, final.text);
    }

    if (Option.isSome(transportFailure)) {
      return yield* reportTransportFailure(cliIo, transportFailure.value);
    }

    const termination = final.termination ?? headlessStreamEndedEarly();
    if (termination.summary !== undefined) {
      yield* writeSummary({
        cliIo,
        summary: termination.summary,
        sawText: final.sawText,
      });
    }
    if (termination.outcome === "succeeded") {
      // A turn can complete having emitted only reasoning and tool calls, with
      // no assistant prose at all, which reaches a piped caller as an empty
      // stdout and a zero exit — indistinguishable from a run that had nothing
      // to say. Observed on roughly half of tool-using turns. The exit code
      // stays 0 because the turn did succeed; this only makes the silence
      // legible on the stream a caller is not parsing.
      if (!sawText) {
        yield* cliIo
          .writeStderr(
            `${HEADLESS_WARNING_PREFIX}the turn completed without producing any output; see \`ori logs\` for the full stream${HEADLESS_NEWLINE}`
          )
          .pipe(Effect.ignore);
      }
      return;
    }
    const detailLine = unduplicatedDetailLine(
      termination.detail,
      final.lastDiagnostic
    );
    if (detailLine !== undefined) {
      yield* cliIo.writeStderr(detailLine).pipe(Effect.ignore);
    }
    return yield* new OriCliExit({ exitCode: termination.exitCode });
  }
);
