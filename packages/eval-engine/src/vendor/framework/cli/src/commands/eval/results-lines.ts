// The shapes the `ori eval` results channel carries, and folding them back into
// one row per run. Split out of `results.ts` so that file stays about the channel
// itself (where the file lives, reading it back, and what a row means) rather than
// also holding every schema the channel decodes.
//
// Three line shapes reach this module and they are disjoint by construction: a
// start line requires `requestedModel`, a run's own row requires `model`, and an
// assertion's verdict requires `outcome`. No line can decode as the wrong shape,
// so the union's order carries no meaning and a reader never has to know it.
import { Effect, Option, Schema } from "effect";

/**
 * Decode a field as absent rather than failing the row it sits on.
 *
 * The rows come from a child process over a file, and every field past `model` is
 * a diagnostic. A harness that reports one of them in an unexpected shape must
 * cost that one field, not the whole row: losing the row would take the model and
 * the duration with it and report the run as if it never happened.
 */
const tolerant = <S extends Schema.Schema<unknown>>(
  schema: S
): Schema.middlewareDecoding<S, S["DecodingServices"]> =>
  schema.pipe(Schema.catchDecoding(() => Effect.succeed(Option.none())));

/**
 * The event that ended the run, forwarded exactly as the runtime emitted it.
 *
 * Named field-by-field because a `Schema.Struct` keeps only the keys it names, and
 * `payload` is `Unknown` so nothing inside it can be dropped: the failure text
 * arrives there as `error` and the token counts and cost arrive there as `usage`,
 * neither of them named by this schema. A field a harness starts reporting reaches
 * the reader through this channel with no change here. Untrusted enough that only `type` is required — a
 * terminal event with no type says nothing about the outcome.
 *
 * `createdAt`, `runId`, and `turnId` are stamped by the runtime and are NOT on the
 * event type an author sees, so they arrive on the daemon path `ori eval` uses and
 * are absent for an eval that binds its own in-process harness. Optional for that
 * reason, not merely for tolerance. `model` is the model the run was invoked with,
 * which is the resolved workspace default when the request named none; no harness
 * reports a served model here.
 */
const EvalTerminalEventSchema = Schema.Struct({
  createdAt: Schema.optional(Schema.String),
  harness: Schema.optional(Schema.String),
  model: Schema.optional(Schema.NullOr(Schema.String)),
  payload: Schema.optional(Schema.Unknown),
  runId: Schema.optional(Schema.String),
  turnId: Schema.optional(Schema.String),
  type: Schema.String,
});

/**
 * What a run was for: a model under evaluation, or the LLM judge grading one.
 *
 * A bakeoff grades every candidate with the same judge, and a judge model can cost
 * a hundred times what the cheap models it grades cost per call. Without this, the
 * only answer to "which model is cheapest" is the name of the grader.
 */
const EvalRunRoleSchema = Schema.Literals(["candidate", "judge"]);

/**
 * One completed agent run, as the SDK appended it.
 *
 * Everything past `model` is optional, and each field decodes independently of the
 * others (see {@link tolerant}), because a row is a report on what one model call
 * did rather than a fixed contract the harness owes us. Reading it means asking
 * what is there, not assuming.
 *
 * Nothing here is defaulted to `0`. A duration, a terminal event, or a character
 * count that is absent is unknown, and rendering unknown as `0` would report a
 * model that never answered as having answered instantly.
 *
 * `eventCounts` is a census of the stream by event type, so retries, compactions,
 * and runtime warnings are all readable under their own tags without this schema
 * naming any of them.
 *
 * `runKey` is the SDK's own per-run id, and the join key an outcome line names. It
 * is optional because a workspace can be running a generated `ori/eval` older than
 * this command; a run with no key simply has no outcome to find.
 *
 */
const EvalRunLineSchema = Schema.Struct({
  durationMs: tolerant(Schema.optional(Schema.Finite)),
  eventCounts: tolerant(
    Schema.optional(Schema.Record(Schema.String, Schema.Finite))
  ),
  model: Schema.String,
  outputChars: tolerant(Schema.optional(Schema.Finite)),
  role: tolerant(Schema.optional(EvalRunRoleSchema)),
  runKey: tolerant(Schema.optional(Schema.String)),
  terminal: tolerant(Schema.optional(EvalTerminalEventSchema)),
  toolCalls: tolerant(Schema.optional(Schema.Array(Schema.String))),
});

/**
 * That a run was asked for, written by the SDK before the run starts.
 *
 * The run's own row is appended after the run finishes, so until this line existed
 * a run that never finished left nothing at all. A bakeoff written as `Promise.all`
 * over N models inside one `test()` ends the moment any candidate's assertion
 * throws, and every sibling still in flight is killed before its row is written, so
 * the report named only the models that happened to come back and read as a
 * complete comparison of them (ORI-792).
 *
 * It carries only what is known before the run starts. Nothing measurable is here
 * because none of it has happened yet, and this line never overrides a row: see
 * {@link joinOutcomes}.
 *
 * `requestedModel` rather than `model` is what makes the three line shapes disjoint
 * by construction — a row requires `model`, an outcome requires `outcome`, a start
 * requires `requestedModel` — so no line can decode as the wrong shape and the
 * union's order stays free of meaning.
 */
const EvalRunStartLineSchema = Schema.Struct({
  requestedModel: Schema.String,
  role: tolerant(Schema.optional(EvalRunRoleSchema)),
  runKey: Schema.String,
});

/**
 * What an assertion that actually ran decided. The only two verdicts anything
 * writes down: nothing on the channel can say "unknown", it can only stay silent.
 */
const EvalRecordedOutcomeSchema = Schema.Literals(["failed", "passed"]);

/**
 * What the assertions made about a run decided.
 *
 * `unknown` is a real answer, not a placeholder. An eval that asserted nothing
 * about a run, and a test killed before it got to its assertions, both land here —
 * and neither is the same as passing. Only an assertion that actually ran and
 * returned makes a run `passed`, which is why this widens the recorded verdicts
 * rather than re-listing them.
 */
const EvalRunOutcomeSchema = Schema.Union([
  EvalRecordedOutcomeSchema,
  Schema.Literal("unknown"),
]);

/**
 * One assertion's verdict about one run, written as its own line.
 *
 * A second line rather than more fields on the run's row, because the row is
 * appended when the run completes and every assertion about it happens after
 * that. Holding the row back until the test body finished would trade this
 * channel's append-only crash tolerance for a deferred flush a killed child loses.
 */
const EvalRunOutcomeLineSchema = Schema.Struct({
  message: tolerant(Schema.optional(Schema.String)),
  outcome: EvalRecordedOutcomeSchema,
  runKey: Schema.String,
  score: tolerant(Schema.optional(Schema.Finite)),
});

// The three line shapes the channel carries. Disjoint by construction: each arm
// requires a key the other two never write — `outcome`, `requestedModel`, `model`
// — so no line decodes as the wrong shape and the order here carries no meaning.
const EvalResultLineSchema = Schema.Union([
  EvalRunOutcomeLineSchema,
  EvalRunStartLineSchema,
  EvalRunLineSchema,
]);

type EvalResultLine = typeof EvalResultLineSchema.Type;

/**
 * One agent run with the verdict on it folded back in.
 *
 * This is what the command reports and what `--json` carries: the model, what the
 * run cost and did, and whether it was RIGHT. `outcomeDetail` is the failing
 * assertion's own message, so a reader can say why rather than only that.
 *
 * `cutOff` says whether the run came back. It is required rather than optional
 * because every row can answer it: a row built from a run's own line finished by
 * definition, and a row built from a start line alone did not. That is a fact about
 * which lines were on the channel, not a measurement, so the absent-not-zero rule
 * the rest of this file follows does not apply to it. A cut-off row carries the
 * requested model, the role, and nothing else — no duration, no cost, no terminal
 * event — because nothing about that run was ever observed.
 */
const EvalResultRowSchema = Schema.Struct({
  ...EvalRunLineSchema.fields,
  cutOff: Schema.Boolean,
  outcome: EvalRunOutcomeSchema,
  outcomeDetail: Schema.optional(Schema.String),
  score: Schema.optional(Schema.Finite),
});

type EvalResultRow = typeof EvalResultRowSchema.Type;

// One line at a time, decoded from its JSON text. `Schema.fromJsonString` keeps the
// parse and the shape check in a single decode, so a malformed line and a
// well-formed line of the wrong shape fail the same way — as a skip, not a throw.
const decodeLine = Schema.decodeUnknownOption(
  Schema.fromJsonString(EvalResultLineSchema)
);

const isRunLine = (
  line: EvalResultLine
): line is typeof EvalRunLineSchema.Type => "model" in line;

const isStartLine = (
  line: EvalResultLine
): line is typeof EvalRunStartLineSchema.Type => "requestedModel" in line;

const isOutcomeLine = (
  line: EvalResultLine
): line is typeof EvalRunOutcomeLineSchema.Type => "outcome" in line;

interface RecordedOutcome {
  readonly message?: string | undefined;
  readonly outcome: typeof EvalRecordedOutcomeSchema.Type;
  readonly score?: number | undefined;
}

/**
 * The row a start line becomes when its run never came back.
 *
 * `unknown` is forced rather than looked up. A verdict cannot be recorded against a
 * run the author never received — the SDK hands the run over only after its row is
 * written — so there is nothing here to find, and a cut-off run must read `unknown`
 * either way. A run nobody finished was not measured, and calling it a pass or a
 * failure would be inventing the one thing this row exists to say is missing.
 */
const cutOffRow = (
  line: typeof EvalRunStartLineSchema.Type
): EvalResultRow => ({
  cutOff: true,
  model: line.requestedModel,
  outcome: "unknown",
  ...(line.role === undefined ? {} : { role: line.role }),
  runKey: line.runKey,
});

/**
 * Fold every outcome line onto the run it names, and keep the runs that never
 * came back.
 *
 * A failure is sticky: once any assertion about a run failed, the run failed, and
 * a later passing assertion cannot undo it. Nothing invents an outcome — a run
 * with no key, or a key no line ever mentioned, comes back `unknown`, which is why
 * a child killed mid-test reports unknown runs rather than a sweep of passes.
 *
 * A start line yields a row only when no row for its key ever arrived, so a run
 * that finished is reported exactly once and the row wins every field: the row
 * watched the run happen and the start line only knows it was asked for. That is
 * what keeps `Agent runs: 2` meaning two runs rather than one run and its own
 * announcement.
 *
 * Emitted in the order the channel carried them, so a cut-off candidate is
 * reported where it was requested rather than swept to the end.
 */
const joinOutcomes = (
  lines: readonly EvalResultLine[]
): readonly EvalResultRow[] => {
  const byRunKey = new Map<string, RecordedOutcome>();
  for (const line of lines) {
    if (
      !isOutcomeLine(line) ||
      byRunKey.get(line.runKey)?.outcome === "failed"
    ) {
      continue;
    }
    byRunKey.set(line.runKey, {
      message: line.message,
      outcome: line.outcome,
      score: line.score ?? byRunKey.get(line.runKey)?.score,
    });
  }
  const completed = new Set(
    lines.flatMap((line) =>
      isRunLine(line) && line.runKey !== undefined ? [line.runKey] : []
    )
  );
  return lines.flatMap((line) => {
    if (isStartLine(line)) {
      return completed.has(line.runKey) ? [] : [cutOffRow(line)];
    }
    if (!isRunLine(line)) {
      return [];
    }
    const recorded =
      line.runKey === undefined ? undefined : byRunKey.get(line.runKey);
    return [
      {
        ...line,
        cutOff: false,
        outcome: recorded?.outcome ?? "unknown",
        ...(recorded?.message === undefined
          ? {}
          : { outcomeDetail: recorded.message }),
        ...(recorded?.score === undefined ? {} : { score: recorded.score }),
      },
    ];
  });
};

export {
  decodeLine,
  EvalRecordedOutcomeSchema,
  EvalResultLineSchema,
  EvalResultRowSchema,
  EvalRunLineSchema,
  EvalRunOutcomeSchema,
  EvalRunRoleSchema,
  EvalRunStartLineSchema,
  joinOutcomes,
};
export type { EvalResultLine, EvalResultRow };
