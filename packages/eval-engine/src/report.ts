import type { EvalRunSummary } from "./model.js";

const measured = (value: number | undefined, suffix = ""): string =>
  value === undefined ? "unknown" : `${value.toLocaleString("en-US")}${suffix}`;

/** Render a deterministic, shareable Markdown report without writing global state. */
export const renderEvalReport = (summary: EvalRunSummary): string => {
  const passed = summary.tests.filter((test) => test.status === "pass").length;
  const failed = summary.tests.filter((test) => test.status === "fail").length;
  const skipped = summary.tests.filter((test) => test.status === "skipped").length;
  const lines = [
    "# Evaluation report",
    "",
    `- Target: \`${summary.searchRoot}\``,
    `- Working directory: \`${summary.workingDirectory}\``,
    `- Files: ${summary.files.length}`,
    `- Exit code: ${summary.exitCode}`,
    `- Duration: ${measured(summary.durationMs, " ms")}`,
    `- Tests: ${passed} passed, ${failed} failed, ${skipped} skipped`,
    "",
    "## Agent runs",
    "",
    "| Suite | Case | Role | Model | Outcome | Score | Cut off | Duration | Tool calls | Cost |",
    "| --- | --- | --- | --- | --- | ---: | --- | ---: | ---: | ---: |"
  ];

  if (summary.results.length === 0) {
    lines.push("| — | — | — | — | unknown | — | — | — | — | — |");
  } else {
    for (const result of summary.results) {
      lines.push(
        `| ${result.suiteId ?? "—"} | ${result.caseId ?? "—"} | ${result.role ?? "candidate"} | ${result.terminal?.model ?? result.model} | ${result.outcome} | ${measured(result.score)} | ${result.cutOff ? "yes" : "no"} | ${measured(result.durationMs, " ms")} | ${measured(result.toolCalls?.length)} | ${measured(result.usage?.costUsd, " USD")} |`
      );
    }
  }

  lines.push("", "## Test cases", "", "| Test | Status | Duration |", "| --- | --- | ---: |");
  for (const test of summary.tests) {
    lines.push(`| ${test.name} | ${test.status} | ${measured(test.durationMs, " ms")} |`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
};
