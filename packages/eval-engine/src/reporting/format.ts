// How a single value reads in the shareable report, and nothing else. The
// sections (`report-markdown-sections.ts`) and the run-to-run blocks
// (`report-markdown-history.ts`) both render through these, so the rule below is
// enforced in one place rather than restated at every call site.
//
// THE RULE: an unmeasured value renders as {@link UNMEASURED}, never as `0`. Every
// formatter here takes `number | undefined` and answers the word rather than a
// number when the value is absent, which is what makes a missing measurement
// impossible to accidentally print as zero.
//
// The temptation is strongest in a document, because `$0.00` makes a table look
// finished and `unmeasured` looks unpolished. The damage is worst here too: this
// document goes to a client or a room of strangers, so a fabricated zero is a
// false claim made on the user's behalf.

/**
 * How every absent measurement reads.
 *
 * One spelling everywhere, so a reader learns it once and the report's footer
 * defines it once. Deliberately a word rather than a dash or an empty cell: a
 * blank reads as an oversight, and this is a statement about what the harness
 * reported.
 */
export const UNMEASURED = "unmeasured";

// Matches the per-run line and the terminal comparison block. A bakeoff costs a
// fraction of a cent, so the usual two-decimal money format prints every model as
// $0.00 and hides the entire comparison.
const COST_DECIMALS = 6;

const PERCENT_SCALE = 100;

const PERCENT_DECIMALS = 1;

/**
 * The file name of a path, with the directories dropped.
 *
 * The report names the eval files that ran, because "what was compared" means
 * little without them, but an absolute path leaks the producer's home directory
 * and checkout layout into a document that gets pasted into a client thread. Both
 * separators, so a report produced on Windows reads like one produced on Linux.
 */
export const fileName = (value: string): string =>
  value
    .split(/[/\\]/u)
    .filter((segment) => segment.length > 0)
    .at(-1) ?? value;

/**
 * Make a value safe to sit in a markdown table cell.
 *
 * A pipe ends the cell early and a newline ends the row, either of which turns the
 * rest of the table into loose text in somebody's Slack message. Test names are
 * whatever the eval author wrote and model slugs come from a provider, so neither
 * is trusted to be table-safe.
 */
export const cell = (value: string): string =>
  value
    .replaceAll("|", "\\|")
    .replaceAll(/\s*\n\s*/gu, " ")
    .trim();

/**
 * How much model-authored text the document carries before it stops.
 *
 * A judge's reason is a sentence or two, but nothing bounds it: the text is
 * whatever a model wrote, and a runaway answer pasted whole would bury the report
 * it is supposed to explain. The cap is stated in the document when it bites,
 * because silently ending a sentence mid-word reads as the model trailing off.
 */
const QUOTE_MAX_CHARS = 2000;

const MIN_FENCE_LENGTH = 3;

/**
 * Quote untrusted text so it cannot restructure the document around it.
 *
 * A judge's verdict and a provider's failure message are both model-authored, and
 * this file gets forwarded into Slack, a Notion page, and a PR description. Left
 * inline, a backtick opens a code span that swallows everything up to the next
 * backtick anywhere below it, a pipe ends a table cell, a newline ends a row, and
 * a leading `#` becomes somebody else's heading. A fence makes all of that
 * literal, and the fence is grown past the longest backtick run inside the text so
 * the text cannot close its own container.
 *
 * Newlines are kept rather than collapsed the way {@link cell} collapses them,
 * because a verdict that argues in two paragraphs is the part a reader is
 * persuaded by. That is the whole reason this renders as a block and not a cell.
 */
export const quote = (value: string): readonly string[] => {
  const trimmed = value.trim();
  const clipped = trimmed.length > QUOTE_MAX_CHARS;
  const text = clipped ? trimmed.slice(0, QUOTE_MAX_CHARS) : trimmed;
  const longestBacktickRun = Math.max(
    0,
    ...[...text.matchAll(/`+/gu)].map((match) => match[0].length)
  );
  const fence = "`".repeat(Math.max(MIN_FENCE_LENGTH, longestBacktickRun + 1));
  return [
    fence,
    ...text.split("\n"),
    fence,
    ...(clipped ? ["", `Quoted text stops at ${QUOTE_MAX_CHARS} characters.`] : [])
  ];
};

export const formatCost = (cost: number | undefined): string =>
  cost === undefined ? UNMEASURED : `$${cost.toFixed(COST_DECIMALS)}`;

export const formatPercent = (rate: number | undefined): string =>
  rate === undefined ? UNMEASURED : `${(rate * PERCENT_SCALE).toFixed(PERCENT_DECIMALS)}%`;

export const formatDuration = (durationMs: number | undefined): string =>
  durationMs === undefined ? UNMEASURED : `${Math.round(durationMs)} ms`;

export const table = (
  header: readonly string[],
  alignment: readonly string[],
  rows: readonly (readonly string[])[]
): readonly string[] => [
  `| ${header.join(" | ")} |`,
  `| ${alignment.join(" | ")} |`,
  ...rows.map((row) => `| ${row.join(" | ")} |`)
];
