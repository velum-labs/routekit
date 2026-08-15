import { Data, Option, Schema } from "effect";

import type { SchemaIssueDetail } from "../errors.ts";

import {
  CliFailureError,
  formatSchemaIssues,
} from "../errors.ts";
import { formatUnknownError } from "../../../../utils/core/src/error-formatting.ts";

const JSON_INDENT = 2;

/**
 * Marker failure for a command that has already written its terminal output.
 * The CLI entry point takes the non-zero exit without printing a second error;
 * `command` preserves the operation for telemetry when a handler self-reports.
 */
class CliOutputAlreadyReported extends Data.TaggedError(
  "CliOutputAlreadyReported"
)<{
  readonly cause: unknown;
  readonly command?: string | undefined;
}> {}

/**
 * Structured fields preserved from a command failure so a `--json` consumer can
 * diagnose it without grepping the message: the operation/command that failed,
 * a harness `exitCode`/`stderr`, a registry `name`/`kind`, a decode `reason`,
 * and the field-level schema `issues` when the failure was a decode error.
 */
interface CliEnvelopeErrorDetails {
  readonly operation?: string;
  readonly command?: string;
  readonly exitCode?: number;
  readonly stderr?: string;
  readonly name?: string;
  readonly kind?: string;
  readonly reason?: string;
  readonly issues?: readonly SchemaIssueDetail[];
}

interface CliEnvelopeError {
  readonly message: string;
  readonly hint?: string | undefined;
  /** The failure's tagged discriminant (`_tag`) when it is a known ROUTEKIT_EVAL error, for machine branching. */
  readonly code?: string | undefined;
  /** Structured, diagnosable fields preserved from the failure (omitted when there is nothing to add). */
  readonly details?: CliEnvelopeErrorDetails | undefined;
}

// The diagnosable fields ROUTEKIT_EVAL's tagged errors carry. Decoding the thrown value
// once against this schema projects whichever fields are present (excess keys
// like `detail`/`cause`/`message` are ignored) without ad hoc property probing.
const EnvelopeErrorSource = Schema.Struct({
  _tag: Schema.optionalKey(Schema.String),
  command: Schema.optionalKey(Schema.String),
  exitCode: Schema.optionalKey(Schema.Number),
  kind: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  operation: Schema.optionalKey(Schema.String),
  reason: Schema.optionalKey(Schema.String),
  stderr: Schema.optionalKey(Schema.String),
});

const decodeEnvelopeErrorSource =
  Schema.decodeUnknownOption(EnvelopeErrorSource);

/**
 * Unified machine-readable result for a one-shot command. `data` carries the
 * payload and `ok` reflects the operation's outcome: report-style commands
 * (`features validate`, `harness test`) set `ok: false` on a negative result
 * while still returning the full report in `data`, so a machine consumer can
 * branch on `ok` alone. A command-level failure (the command could not run) sets
 * `ok: false` and `error` carries the message (and an optional actionable hint).
 */
interface CliEnvelope<T> {
  readonly ok: boolean;
  readonly command: string;
  readonly data?: T;
  readonly error?: CliEnvelopeError;
}

/**
 * One NDJSON line emitted by a streaming command in machine mode: `event` lines
 * carry raw runtime/log records as they arrive, and a single terminal `result`
 * line reports overall success or failure. A chat-turn stream (`routekit-eval code`'s
 * headless `--output jsonl`, RFC 0004 code.md) also stamps the session id the
 * run actually used on the `result` line, so a caller can chain a follow-up
 * turn with `--session <id>` without parsing the event lines.
 */
type CliStreamLine =
  | { readonly kind: "event"; readonly event: unknown }
  | {
      readonly kind: "result";
      readonly ok: boolean;
      readonly error?: CliEnvelopeError;
      readonly sessionId?: string;
    };

/**
 * Pretty single-document result envelope (with a trailing newline). `ok` defaults
 * to `true` for a command that produced its payload; report-style commands pass the
 * actual outcome (e.g. `report.ok`) so a negative result renders `ok: false` while
 * still carrying the structured report in `data`. Command-level failures (the
 * command could not run) go through {@link renderErrorEnvelope} instead.
 */
const renderEnvelope = (command: string, data: unknown, ok = true): string =>
  `${JSON.stringify(
    {
      ok,
      command,
      data,
    } satisfies CliEnvelope<unknown>,
    undefined,
    JSON_INDENT
  )}\n`;

/** Pretty single-document error envelope (with a trailing newline). */
const renderErrorEnvelope = (
  command: string,
  error: CliEnvelopeError
): string =>
  `${JSON.stringify(
    {
      ok: false,
      command,
      error,
    } satisfies CliEnvelope<never>,
    undefined,
    JSON_INDENT
  )}\n`;

/** Compact NDJSON line for streaming machine output (with a trailing newline). */
const renderStreamLine = (line: CliStreamLine): string =>
  `${JSON.stringify(line)}\n`;

/**
 * The failure an interactive command raises when asked to run in machine/JSON
 * output mode (piped or `--json`): it needs a terminal, so point the caller at a
 * TTY or the machine-readable sub-APIs instead of launching a full-screen UI.
 * A command with its own machine-mode escape hatch (e.g. `routekit-eval code`'s headless
 * one-shot) passes a `hint` naming it.
 */
const interactiveCommandError = (
  command: string,
  hint?: string
): CliFailureError =>
  new CliFailureError({
    detail: `\`routekit-eval ${command}\` is interactive and needs a terminal; it can't produce machine/JSON output.`,
    hint:
      hint ??
      "Run it in a TTY, or use the JSON sub-APIs (`routekit-eval sessions`, `routekit-eval logs`, `routekit-eval schedules`) for machine output.",
  });

const envelopeDetails = (
  source: typeof EnvelopeErrorSource.Type | undefined,
  issues: readonly SchemaIssueDetail[] | undefined
): CliEnvelopeErrorDetails | undefined => {
  const details: CliEnvelopeErrorDetails = {
    ...(source?.command === undefined ? {} : { command: source.command }),
    ...(source?.exitCode === undefined ? {} : { exitCode: source.exitCode }),
    ...(source?.kind === undefined ? {} : { kind: source.kind }),
    ...(source?.name === undefined ? {} : { name: source.name }),
    ...(source?.operation === undefined ? {} : { operation: source.operation }),
    ...(source?.reason === undefined ? {} : { reason: source.reason }),
    ...(source?.stderr === undefined ? {} : { stderr: source.stderr }),
    ...(issues === undefined ? {} : { issues }),
  };
  return Object.keys(details).length > 0 ? details : undefined;
};

/**
 * Project any thrown value into the envelope error shape, mirroring
 * `formatCliFailure`: the rendered message, plus the actionable `hint` when the
 * failure is a {@link CliFailureError} that carries one.
 *
 * `code` prefers the originating `AgentFailure.code` over the error class's tag.
 * The tag answers "who reported this", which is the same string for every
 * agent-run failure, so a caller branching on it cannot tell a rejected
 * credential from a crashed peer and is pushed into grepping `message`.
 */
export const toEnvelopeError = (error: unknown): CliEnvelopeError => {
  const message = formatUnknownError(error);
  const isCliFailure = Schema.is(CliFailureError)(error);
  const hint =
    isCliFailure && error.hint !== undefined && error.hint.length > 0
      ? error.hint
      : undefined;
  const source = Option.getOrUndefined(decodeEnvelopeErrorSource(error));
  const code = (isCliFailure ? error.failureCode : undefined) ?? source?._tag;
  const details = envelopeDetails(source, formatSchemaIssues(error));
  return {
    message,
    hint,
    code,
    details,
  };
};

export {
  CliOutputAlreadyReported,
  renderEnvelope,
  renderErrorEnvelope,
  renderStreamLine,
  interactiveCommandError,
};
export type {
  CliEnvelopeErrorDetails,
  CliEnvelopeError,
  CliEnvelope,
  CliStreamLine,
};
