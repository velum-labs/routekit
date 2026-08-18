// The shareable artefact: one markdown file a user hands to somebody who was not
// at the terminal. Its own module, the way `comparison-report.ts` was split out,
// so `report.ts` keeps its one job (what the run printed to a terminal) and this
// one owns a document with a different audience and a different lifetime.
//
// The audience is the whole design. A reader here has no repo, no CLI, and no
// context: the file goes into Slack, a Notion page, a PR description, or an email,
// so it carries its own provenance and never names a path on the machine that
// produced it. Markdown rather than HTML or PDF for the same reason — it survives
// being pasted into all of those, and it stays diffable when the run is repeated
// next week.
//
// This file assembles and writes the document; `report-markdown-sections.ts` owns
// what each section says, including the rule that an unmeasured value is never
// rendered as zero.
import { DateTime, Effect, FileSystem, Option, Path } from "effect";

import type { EvalComparison } from "./baseline.ts";
import type { EvalHistoryEntry } from "./history.ts";
import type { EvalTestRow } from "./junit.ts";
import type { EvalResultRow } from "./results.ts";

import { readEvalHistory } from "./history.ts";
import { failureSection } from "./report-markdown-failures.ts";
import {
  comparisonSection,
  trendSection,
} from "./report-markdown-history.ts";
import {
  footerSection,
  judgeSection,
  modelSection,
  provenanceSection,
  testSection,
} from "./report-markdown-sections.ts";
import { OriDirectory } from "../../ori-directory.ts";

/**
 * Render the whole document.
 *
 * Pure, and separate from the write, so what the file says is testable without a
 * filesystem and the write stays about durability. A section with nothing to say
 * returns no lines rather than an empty heading, which is what keeps a first run
 * (no baseline, no history, no judge) reading as a complete short document instead
 * of a broken long one.
 */
export const renderEvalReportMarkdown = (input: {
  readonly comparison: Option.Option<EvalComparison>;
  readonly files: readonly string[];
  readonly generatedAt: string;
  readonly history: readonly EvalHistoryEntry[];
  readonly results: readonly EvalResultRow[];
  readonly tests: readonly EvalTestRow[];
}): string => {
  const sections: readonly (readonly string[])[] = [
    provenanceSection(input),
    modelSection(input.results, input.tests),
    testSection(input.tests),
    failureSection(input.results),
    judgeSection(input.results),
    comparisonSection(input.comparison),
    trendSection(input.history),
    footerSection(input),
  ];
  return `${sections
    .filter((section) => section.length > 0)
    .map((section) => section.join("\n"))
    .join("\n\n")}\n`;
};

/**
 * Read the runs recorded before this one, for the trend table.
 *
 * Best effort, the same way the history write and the baseline read are: no
 * workspace, no history file, or an unreadable one all answer "no earlier runs".
 * The trend is the one part of the document that is nice to have, so it degrades
 * to absent rather than taking the report down with it.
 */
const readReportHistory = Effect.fn("EvalReport.readHistory")(
  function* (workingDirectory: string) {
    const oriDirectory = yield* OriDirectory;
    const workspaceRoot =
      yield* oriDirectory.workspaceRootFrom(workingDirectory);
    if (Option.isNone(workspaceRoot)) {
      return [] as readonly EvalHistoryEntry[];
    }
    return yield* readEvalHistory(
      oriDirectory.evalHistoryPath(workspaceRoot.value)
    );
  },
  (effect) =>
    Effect.catchCause(effect, () =>
      Effect.succeed([] as readonly EvalHistoryEntry[])
    )
);

/**
 * Write the report where the user asked for it, and answer with the path written
 * so the command can say plainly where it went.
 *
 * A relative path resolves against the directory the evals ran in rather than the
 * process cwd, so `--report report.md` lands beside the evals the user was just
 * looking at. Unlike the history write, a failure here is NOT swallowed: the user
 * named a file, and silently not producing it leaves them pasting a stale document
 * into a client thread.
 */
export const writeEvalReportMarkdown = Effect.fn("EvalReport.write")(
  function* (input: {
    readonly comparison: Option.Option<EvalComparison>;
    readonly files: readonly string[];
    readonly reportPath: string;
    readonly results: readonly EvalResultRow[];
    readonly tests: readonly EvalTestRow[];
    readonly workingDirectory: string;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const resolved = path.resolve(input.workingDirectory, input.reportPath);
    const history = yield* readReportHistory(input.workingDirectory);
    const markdown = renderEvalReportMarkdown({
      comparison: input.comparison,
      files: input.files,
      generatedAt: DateTime.formatIso(yield* DateTime.now),
      history,
      results: input.results,
      tests: input.tests,
    });
    yield* fs.makeDirectory(path.dirname(resolved), { recursive: true });
    yield* fs.writeFileString(resolved, markdown);
    return resolved;
  }
);
