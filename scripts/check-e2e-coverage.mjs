import { readFileSync } from "node:fs";

const reportPath = process.argv[2];
if (reportPath === undefined) throw new Error("usage: check-e2e-coverage <report.json>");
const report = JSON.parse(readFileSync(reportPath, "utf8"));
const summary = report.summary;
if (summary?.status !== "pass") throw new Error(`E2E matrix status is ${summary?.status ?? "unknown"}`);
if ((summary.caseCounts?.skip ?? 0) !== 0) {
  throw new Error(`E2E matrix skipped ${summary.caseCounts.skip} deterministic cases`);
}
if ((summary.caseCounts?.fail ?? 0) !== 0) {
  throw new Error(`E2E matrix failed ${summary.caseCounts.fail} deterministic cases`);
}
