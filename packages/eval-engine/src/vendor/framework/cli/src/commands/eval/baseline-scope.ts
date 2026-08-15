// Which earlier runs a run is allowed to be held against. Split from
// `baseline.ts` because that file answers "did this get worse" and this one
// answers "worse than what, exactly" — and because the answer has to hold for
// every selector rather than just the default one.
//
// A workspace holds one history for all of its evals. Without this, two eval
// files in one project compared against each other: a fresh suite's first run was
// reported as a pass-rate collapse against an unrelated suite that happened to
// finish last, naming models it had never invoked.
import type { EvalHistoryEntry } from "./history.ts";

import { normalizeEvalFiles } from "./history-entry.ts";

/** The recorded file set as one comparable string, absent on a row that has none. */
const fileSetKey = (files: readonly string[] | undefined): string | undefined =>
  files === undefined ? undefined : normalizeEvalFiles(files).join("\n");

/**
 * The runs a given run may be compared with: the ones that covered exactly the
 * same eval files.
 *
 * Exact, not overlapping and not a subset. Two runs are comparable when they
 * measured the same thing, and a run of three evals put beside a run of one of
 * them reports a move that is really a change of subject.
 *
 * A row carrying no file set is skipped rather than matched. It was written before
 * the scope existed and there is no way to tell which evals it covered, so reading
 * it as a wildcard would keep exactly the bug this rules out. The cost is that the
 * first run after an upgrade finds no baseline and the next one does, which is the
 * right trade against reporting a regression that did not happen.
 */
export const comparableEvalRuns = (
  history: readonly EvalHistoryEntry[],
  files: readonly string[]
): readonly EvalHistoryEntry[] => {
  const wanted = fileSetKey(files);
  return history.filter((entry) => fileSetKey(entry.files) === wanted);
};
