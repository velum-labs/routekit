// The history side of a finished `routekit-eval eval` run, in the order it has to happen:
// project the run once, compare it against an earlier one, then record it. Split
// out of `command.ts` so that file stays about wiring the run itself.
//
// Both halves are best-effort and independent. A history that cannot be read must
// not stop the run from being recorded, and a history that cannot be written must
// not stop the comparison from being reported. Neither can fail the command.
import { DateTime, Effect } from "effect";

import type { EvalBaselineSelector } from "./baseline-selector.ts";
import type { EvalTestRow } from "./junit.ts";
import type { EvalResultRow } from "./results.ts";

import { evalBaselineComparison } from "./baseline.ts";
import {
  evalRunFiles,
  recordEvalRunForWorkspace,
  summarizeEvalRun,
} from "./history.ts";

/**
 * Compare this run against the workspace's history, then append it.
 *
 * The entry is projected once and used twice, so the run that gets compared and
 * the line that gets written are the same run down to the timestamp. Comparing
 * happens first, which is what keeps a run from being its own baseline.
 *
 * `--no-history` skips only the write. Reading runs already on disk is what makes
 * "try something without keeping it, but tell me if it got worse" work. The read
 * is told about it all the same, so that outside a workspace it can tell someone
 * who opted out from someone whose runs are silently going nowhere.
 *
 * `files` is the run's resolved targets, which the entry carries so the baseline
 * can be scoped to runs that measured the same evals. Resolved once here and used
 * for both halves, so the scope a run is compared under is the scope it is
 * recorded under.
 */
export const recordAndCompareEvalRun = Effect.fn("EvalCommand.runHistory")(
  function* (input: {
    readonly exitCode: number;
    readonly files: readonly string[];
    readonly recordEnabled: boolean;
    readonly results: readonly EvalResultRow[];
    readonly selector: EvalBaselineSelector;
    readonly tests: readonly EvalTestRow[];
    readonly workingDirectory: string;
  }) {
    const entry = summarizeEvalRun({
      exitCode: input.exitCode,
      files: yield* evalRunFiles({
        files: input.files,
        workingDirectory: input.workingDirectory,
      }),
      recordedAt: DateTime.formatIso(yield* DateTime.now),
      results: input.results,
      tests: input.tests,
    });

    const baseline = yield* evalBaselineComparison({
      current: entry,
      recordEnabled: input.recordEnabled,
      selector: input.selector,
      workingDirectory: input.workingDirectory,
    });

    yield* recordEvalRunForWorkspace({
      enabled: input.recordEnabled,
      entry,
      workingDirectory: input.workingDirectory,
    });

    return baseline;
  }
);
