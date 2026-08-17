import type { ClassifierPredictionV1, SilverLabelV1 } from "./types.ts";
import { calculateExtendedMetrics } from "./experiment-metrics.ts";

export interface ReportInput {
  runId: string;
  repositoryIds: string[];
  labels: SilverLabelV1[];
  predictions: Record<string, ClassifierPredictionV1[]>;
  notes?: string[];
}

const percent = (value: number | null): string => value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;

export const renderClassificationReport = (input: ReportInput): string => {
  const rows = Object.entries(input.predictions).map(([method, predictions]) => ({ method, metrics: calculateExtendedMetrics(input.labels, predictions) }));
  const ranked = [...rows].sort((left, right) => {
    const leftFalse = left.metrics.core.falseKnownRate ?? 0, rightFalse = right.metrics.core.falseKnownRate ?? 0;
    return leftFalse - rightFalse || right.metrics.core.topTwoRecall - left.metrics.core.topTwoRecall || right.metrics.routingCoverage - left.metrics.routingCoverage;
  });
  const recommendation = ranked[0]
    ? `Use **${ranked[0].method}** as the current candidate, subject to held-out confirmation and the limitations below.`
    : "No production recommendation is possible because no prediction sets were supplied.";
  return `# Runtime classifier experiment report

Run: \`${input.runId}\`

## Recommendation

${recommendation}

## Scope

- Repositories: ${input.repositoryIds.map((id) => `\`${id}\``).join(", ") || "none"}
- Silver-labeled cases: ${input.labels.length}
- Classifiers compared: ${rows.length}
- This report compares repository-area classification only. It does not select a coding harness or final coding model.

## Results

| Method | Top-two recall | Exact set | False-known | False-unknown | Coverage | Routed correctness | p50 ms | p95 ms | Cost/case |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
${rows.map(({ method, metrics }) => `| ${method} | ${percent(metrics.core.topTwoRecall)} | ${percent(metrics.core.exactLabelSetMatch)} | ${percent(metrics.core.falseKnownRate)} | ${percent(metrics.core.falseUnknownRate)} | ${percent(metrics.routingCoverage)} | ${percent(metrics.correctnessAmongRouted)} | ${metrics.latencyMs.p50?.toFixed(1) ?? "n/a"} | ${metrics.latencyMs.p95?.toFixed(1) ?? "n/a"} | ${metrics.costUsd.perCase === null ? "n/a" : `$${metrics.costUsd.perCase.toFixed(6)}`} |`).join("\n")}

## Per-area results

${rows.map(({ method, metrics }) => `### ${method}

| Area | Precision | Recall | F1 | TP | FP | FN |
|---|---:|---:|---:|---:|---:|---:|
${Object.entries(metrics.perArea).map(([area, item]) => `| ${area} | ${percent(item.precision)} | ${percent(item.recall)} | ${percent(item.f1)} | ${item.truePositive} | ${item.falsePositive} | ${item.falseNegative} |`).join("\n")}`).join("\n\n")}

## Limitations and next checks

${[
  "Results apply only to the tested users, repositories, time period, Area Registry, task-envelope version, and model configurations.",
  "Silver labels are repository-aware model judgments, not ground truth.",
  "Private prompts are intentionally omitted from this report.",
  ...(input.notes ?? []),
].map((note) => `- ${note}`).join("\n")}
`;
};
