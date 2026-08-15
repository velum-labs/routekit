// Why anything in the run is not a pass, quoted in the words of whatever decided
// that. Split out of `report-markdown-sections.ts` so neither file outgrows the
// max-file-lines budget; the cases live in `report-markdown-failures.test.ts`.
import { Option } from "effect";

import type { EvalResultRow } from "../routekit-eval/results.js";
import { isFailedRun, runErrorText } from "../routekit-eval/results.js";
import { cell, quote, UNMEASURED } from "./format.js";
import { runModel } from "./sections.js";

/**
 * One failure, headed by the model it belongs to and quoting whatever said so.
 *
 * The reason is quoted through {@link quote} rather than dropped into a bullet:
 * it is model-authored text of unbounded length in a document somebody forwards,
 * so backticks, pipes, newlines, and table syntax inside it have to be inert.
 *
 * A reason nobody recorded says so and stops. Never an empty quote and never a
 * blank line under a heading, either of which reads as "nothing to say here"
 * about a run that in fact said nothing back.
 */
const failureEntry = (input: {
  readonly headline: string;
  readonly model: string;
  readonly reason: string | undefined;
}): readonly string[] => {
  const reason = input.reason?.trim();
  const heading = `**${cell(input.model)}** ${input.headline}`;
  return reason === undefined || reason.length === 0
    ? [`${heading} with no reported reason (${UNMEASURED}).`]
    : [`${heading}:`, "", ...quote(reason)];
};

/**
 * Why a run is not a pass, in the words of whatever decided that.
 *
 * Two different failures land here and the reader is told which is which. A run
 * can fail outright, and then the runtime's sentence is the story: "insufficient
 * credits" and "the model refused the request" are read identically off a red
 * cell. A run can also answer perfectly and then be rejected by an assertion or an
 * LLM judge, and that verdict's own reason is the raw material for fixing the
 * prompt (RK-EVAL-762) rather than merely for knowing the run was wrong.
 *
 * Filtering on only the first was the RK-EVAL-794 defect: a judged-failed run has no
 * failed terminal event, so a report could read `0/1 passed` with nothing anywhere
 * in the document saying why. Both are read off the row, and a run unlucky enough
 * to do both is listed twice under the same model rather than having one story
 * silently win.
 */
export const failureSection = (results: readonly EvalResultRow[]): readonly string[] => {
  const entries = results.flatMap((row) => [
    ...(isFailedRun(row)
      ? [
          failureEntry({
            headline: "did not finish the run",
            model: runModel(row),
            reason: Option.getOrUndefined(runErrorText(row))
          })
        ]
      : []),
    ...(row.outcome === "failed"
      ? [
          failureEntry({
            headline: "was judged failed",
            model: runModel(row),
            reason: row.outcomeDetail
          })
        ]
      : [])
  ]);
  return entries.length === 0
    ? []
    : [
        "## Failures",
        "",
        ...entries.flatMap((entry, index) => (index === 0 ? entry : ["", ...entry]))
      ];
};
