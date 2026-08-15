// The line `.routekit/eval/history.jsonl` is made of, and reading it back. Split out
// of `history.ts` so the prune (`history-prune.ts`) can render and re-read the
// file without importing the module that records into it.
//
// The shape here is frozen: `--baseline` compares two entries field for field,
// and a run recorded by one version of the CLI is read by the next. Frozen means
// no existing field changes, is renamed, or is re-meant — an OPTIONAL addition is
// the compatible change and is what the freeze permits, because `Schema.Struct`
// drops keys it does not name, so an older CLI reading a newer row still decodes
// and a newer CLI reading an older row sees the field absent.
import { Array as Arr, Effect, FileSystem, Option, Schema } from "effect";

/**
 * How many runs the history keeps, newest wins.
 *
 * Bounded by count rather than by age: a team that evals once a week still wants
 * its last two hundred data points, and a project evaluating in a CI loop must
 * not grow a file without a bound. A summary line is a few hundred bytes, so the
 * file tops out around a hundred kilobytes.
 */
const EVAL_HISTORY_MAX_RUNS = 200;

/** One model's share of a run: how many times it answered, and what it cost. */
const EvalHistoryModelSchema = Schema.Struct({
  costUsd: Schema.optional(Schema.Finite),
  failedRuns: Schema.Int,
  model: Schema.String,
  runs: Schema.Int,
});

/**
 * The per-test census, kept three-valued for the same reason the JUnit row is: a
 * skipped test is not a pass and not a failure, and a history that collapses it
 * either way reports a movement in the number that never happened.
 */
const EvalHistoryTestsSchema = Schema.Struct({
  failed: Schema.Int,
  passed: Schema.Int,
  skipped: Schema.Int,
});

/**
 * One run, as the history remembers it.
 *
 * `costUsd` is optional rather than defaulted to `0`, the same rule the result
 * rows follow: a harness that reported no cost did not report a cost of zero, and
 * charting the two the same way invents a free run. `runs` counts completed agent
 * runs while `tests` counts `test()` bodies, which are different questions — a
 * model can answer perfectly and still fail the assertion about its answer.
 *
 * `files` names which evals the run covered, in {@link normalizeEvalFiles} form,
 * and is what makes a baseline mean anything: a workspace with two eval files used
 * to compare each against whichever ran last, so a fresh suite reported a pass-rate
 * collapse against an unrelated one. Optional because rows written before it
 * existed do not carry it; those rows are skipped by the selector rather than
 * treated as matching everything, which would preserve the bug.
 */
const EvalHistoryEntrySchema = Schema.Struct({
  costUsd: Schema.optional(Schema.Finite),
  exitCode: Schema.Int,
  failedRuns: Schema.Int,
  files: Schema.optional(Schema.Array(Schema.String)),
  models: Schema.Array(EvalHistoryModelSchema),
  recordedAt: Schema.String,
  runs: Schema.Int,
  tests: EvalHistoryTestsSchema,
});

/**
 * The canonical form of {@link EvalHistoryEntrySchema}'s `files`: deduped and
 * sorted, so two runs over the same evals produce the same list whatever order
 * discovery walked them in and a set comparison is a string comparison.
 */
const normalizeEvalFiles = (files: readonly string[]): readonly string[] =>
  [...new Set(files)].toSorted((left, right) => left.localeCompare(right));

type EvalHistoryEntry = typeof EvalHistoryEntrySchema.Type;

// One entry per line, parse and shape check in a single step, so a half-written
// line and a well-formed line of the wrong shape both come back as a skip rather
// than a throw. Same contract the results reader keeps, for the same reason: a
// process killed mid-append truncates the last line and the lines above it are
// still the whole point of the file.
const decodeEntry = Schema.decodeUnknownOption(
  Schema.fromJsonString(EvalHistoryEntrySchema)
);

// `encodeOption`, not `encodeSync`: a throw here would be a defect rather than a
// failure, and a defect escapes the error handling that keeps this whole path
// from turning a green eval red.
const encodeEntry = Schema.encodeOption(
  Schema.fromJsonString(EvalHistoryEntrySchema)
);

/**
 * Read the history back, oldest first.
 *
 * Absent file → `[]`: the first run in a workspace has no history to read, and
 * that is the normal case rather than an error. An undecodable line is skipped
 * for the same reason a corrupt results line is.
 */
const readEvalHistory = Effect.fn("EvalHistory.read")(function* (
  historyPath: string
) {
  const fs = yield* FileSystem.FileSystem;
  const contents = yield* fs.readFileString(historyPath).pipe(Effect.option);
  if (Option.isNone(contents)) {
    return [];
  }
  return Arr.getSomes(
    contents.value
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => decodeEntry(line))
  );
});

const renderLines = (entries: readonly EvalHistoryEntry[]): string =>
  Arr.getSomes(entries.map((entry) => encodeEntry(entry)))
    .map((line) => `${line}\n`)
    .join("");

export {
  EVAL_HISTORY_MAX_RUNS,
  EvalHistoryEntrySchema,
  EvalHistoryModelSchema,
  encodeEntry,
  normalizeEvalFiles,
  readEvalHistory,
  renderLines,
};
export type { EvalHistoryEntry };
