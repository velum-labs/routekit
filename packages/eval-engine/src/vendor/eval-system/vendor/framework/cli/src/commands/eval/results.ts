// The `routekit-eval eval` results channel. `routekit-eval eval` spawns `node --test` as a child, so the
// SDK running *inside* that child cannot hand rows back in-process. The command
// exports `ROUTEKIT_EVAL_RESULTS_FILE` pointing at a JSONL file in a scoped temp dir;
// the SDK appends a line announcing each run and a line reporting it when it
// finishes, and the command reads them back after the child exits. JSONL (not one
// JSON document) is what makes it crash-tolerant: a line is durable the moment it
// is flushed, so a later failure — or a kill -9 — still leaves the earlier lines
// readable, and a run killed before it reported still left its announcement.
//
// The line shapes and the join live in `results-lines.ts`; this file owns the file
// itself and what a joined row means.
import { Array as Arr, Effect, FileSystem, Option, Path, Schema } from "effect";

import type {
  EvalResultLine,
  EvalResultRow,
} from "./results-lines.ts";

import { AgentFailureSchema } from "../../../../contracts/internal/src/author-schemas/agent-runtime-event.ts";
import {
  decodeLine,
  EvalRecordedOutcomeSchema,
  EvalResultLineSchema,
  EvalResultRowSchema,
  EvalRunRoleSchema,
  EvalRunStartLineSchema,
  joinOutcomes,
} from "./results-lines.ts";

/**
 * Env var carrying the absolute path of the JSONL results file into the
 * `node --test` child. The SDK-side appender reads this name; an unset value
 * means "no results channel", which every non-`routekit-eval eval` `node --test` run sees.
 */
export const ROUTEKIT_EVAL_RESULTS_FILE_ENV = "ROUTEKIT_EVAL_RESULTS_FILE";

const RESULTS_DIR_PREFIX = "routekit-eval-eval-results-";
const RESULTS_FILE_NAME = "results.jsonl";

/** The terminal types that mean the run did not finish its work. */
const FAILED_TERMINAL_TYPES: ReadonlySet<string> = new Set([
  "session.failed",
  "turn.failed",
]);

/**
 * Create the scoped directory holding the results file and return the path the
 * child should append to. The directory is removed when the caller's scope
 * closes, so no eval run leaves a temp dir behind.
 */
export const makeEvalResultsPath = Effect.fn("EvalResults.makePath")(
  function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({
      prefix: RESULTS_DIR_PREFIX,
    });
    return path.join(directory, RESULTS_FILE_NAME);
  }
);

/**
 * Read back the rows the child appended.
 *
 * Absent file → `[]`: an eval that never calls `agent.run` writes nothing, and
 * that is a normal outcome, not an error. A partial or corrupt line is skipped
 * rather than fatal, because a killed child truncates mid-line and the completed
 * rows above the truncation are still the whole point of the file.
 */
export const readEvalResults = Effect.fn("EvalResults.read")(function* (
  resultsPath: string
) {
  const fs = yield* FileSystem.FileSystem;
  const contents = yield* fs.readFileString(resultsPath).pipe(Effect.option);
  if (Option.isNone(contents)) {
    return [];
  }
  return joinOutcomes(
    Arr.getSomes(
      contents.value
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => decodeLine(line))
    )
  );
});

/**
 * Which model to file a run under.
 *
 * `terminal.model` is the model the run was actually invoked with, while a row's
 * own `model` is the slug the eval asked for — which is the literal `"unknown"`
 * whenever the eval let the workspace pick its default, the common case. A series
 * keyed on "unknown" cannot answer "is this model getting better", so the resolved
 * model wins wherever the runtime reported one. The two agree for an eval that pins
 * its model, which is why this is a preference and not a repair.
 *
 * One definition rather than one per reader, so the report and the history both
 * group the same rows under the same name.
 */
export const runModel = (row: EvalResultRow): string =>
  row.terminal?.model ?? row.model;

/** Whether the run ended in a failed turn or session. */
export const isFailedRun = (row: EvalResultRow): boolean =>
  row.terminal !== undefined && FAILED_TERMINAL_TYPES.has(row.terminal.type);

/** Whether the run was the LLM judge grading somebody else's answer. */
export const isJudgeRun = (row: EvalResultRow): boolean => row.role === "judge";

/**
 * Whether the run is a model under evaluation. An unmarked row counts as one.
 *
 * This is the one place a missing field is read as a value rather than as
 * unknown, and it is deliberate. `role` is not a measurement: the absent-not-zero
 * rule elsewhere in this channel exists so an unreported duration or cost is never
 * rendered as `0`, and inventing a number nobody measured is a different act from
 * classifying a row that has to be classified before anything can be printed.
 *
 * Every row written by this version of `routekit/eval` carries an explicit `role`,
 * including `"candidate"`, so absence means exactly one thing: a workspace whose
 * generated SDK predates the field. Reading those as candidates keeps them
 * reporting exactly as they did before, which is the reading every one of them was
 * written under. The alternative — treating unmarked as unknown and holding it out
 * of the rollup — makes a stale SDK report zero candidates and no cost at all,
 * trading a wrong number for a missing one.
 */
export const isCandidateRun = (row: EvalResultRow): boolean => !isJudgeRun(row);

/**
 * Whether the run came back. A cut-off run was started and then killed before it
 * reported anything, so every measurement on it is absent rather than zero.
 */
export const isCompletedRun = (row: EvalResultRow): boolean => !row.cutOff;

// The one field of the forwarded payload the CLI renders itself. Decoded here
// rather than read off `unknown`, and separate from the row schema so naming
// `error` cannot strip the rest of the payload out of the json envelope.
const decodeFailurePayload = Schema.decodeUnknownOption(
  Schema.Struct({ failure: AgentFailureSchema })
);

// Results written before the structured standard carried the reason as
// `payload.error`. Result files outlive the CLI that wrote them, and the report
// is a comparison across runs: a row whose reason silently emptied reads as a
// model that failed for no stated cause. Projected at read time only — the file
// is evidence and is never rewritten.
const decodeLegacyFailurePayload = Schema.decodeUnknownOption(
  Schema.Struct({ error: Schema.String })
);

/** The failure text the runtime reported, when it reported one. */
export const runErrorText = (row: EvalResultRow): Option.Option<string> =>
  Option.orElse(
    Option.map(
      decodeFailurePayload(row.terminal?.payload),
      (payload) => payload.failure.message
    ),
    () =>
      Option.map(
        decodeLegacyFailurePayload(row.terminal?.payload),
        (payload) => payload.error
      )
  );

/**
 * The usage figures the CLI renders, read out of the forwarded payload.
 *
 * Decoded here rather than named on the row schema, for the same reason `error` is:
 * naming them would make `Schema.Struct` strip everything else out of the payload
 * on its way to the json envelope. Every field is optional because this is a report
 * from whichever harness ran, not a contract it owes us.
 *
 * Only the two figures that describe the run as a whole are read. `costUsd` is
 * accumulated across the run's model calls, and `contextTokens` is the context
 * after the final one. The token counts are NOT read here: the harness reports them
 * per call and the engine keeps the last call's, which is right for the chat footer
 * they were built for and wrong beside a run-total cost. They stay in `--json`
 * rather than being rendered next to a figure of a different scope.
 */
const decodeUsagePayload = Schema.decodeUnknownOption(
  Schema.Struct({
    usage: Schema.optional(
      Schema.Struct({
        contextTokens: Schema.optional(Schema.Finite),
        costUsd: Schema.optional(Schema.Finite),
      })
    ),
  })
);

interface EvalRunUsage {
  readonly contextTokens?: number | undefined;
  readonly costUsd?: number | undefined;
}

/** What the run spent, when the harness reported it. */
export const runUsage = (row: EvalResultRow): Option.Option<EvalRunUsage> =>
  Option.flatMapNullishOr(
    decodeUsagePayload(row.terminal?.payload),
    (payload) => payload.usage
  );

/** What the harness reported this one run cost, when it reported anything. */
export const rowCostUsd = (row: EvalResultRow): number | undefined =>
  Option.getOrUndefined(
    Option.flatMapNullishOr(runUsage(row), (usage) => usage.costUsd)
  );

/**
 * What a set of runs cost together, where "absent" is not zero.
 *
 * Runs none of which reported spend total to `undefined` rather than to `0`:
 * starting the accumulator at zero would report a harness that reports no usage as
 * having run for free.
 */
export const totalCostUsd = (
  rows: readonly EvalResultRow[]
): number | undefined => {
  let total: number | undefined;
  for (const row of rows) {
    const cost = rowCostUsd(row);
    if (cost !== undefined) {
      total = (total ?? 0) + cost;
    }
  }
  return total;
};

export {
  EvalRecordedOutcomeSchema,
  EvalResultLineSchema,
  EvalResultRowSchema,
  EvalRunRoleSchema,
  EvalRunStartLineSchema,
};
export type { EvalResultLine, EvalResultRow };
