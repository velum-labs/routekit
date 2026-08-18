import type { ExperimentJobRecord, ExperimentSnapshot } from "@velum-labs/routekit-eval-contracts";

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index] ?? 0;
}

function dollars(value: number): string {
  return `$${value.toFixed(4)}`;
}

export function summarizeExperimentJobs(jobs: readonly ExperimentJobRecord[]): {
  total: number;
  pending: number;
  queued: number;
  running: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  providerCostUsd: number;
  infrastructureCostUsd: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
} {
  const count = (status: ExperimentJobRecord["status"]): number =>
    jobs.filter((job) => job.status === status).length;
  const latencies = jobs.flatMap((job) => (job.latencyMs === undefined ? [] : [job.latencyMs]));
  return {
    total: jobs.length,
    pending: count("pending"),
    queued: count("queued"),
    running: count("running"),
    succeeded: count("succeeded"),
    failed: count("failed"),
    cancelled: count("cancelled"),
    providerCostUsd: jobs.reduce((sum, job) => sum + job.providerCostUsd, 0),
    infrastructureCostUsd: jobs.reduce((sum, job) => sum + job.infrastructureCostUsd, 0),
    p50LatencyMs: percentile(latencies, 0.5),
    p95LatencyMs: percentile(latencies, 0.95)
  };
}

export function renderExperimentReport(snapshot: ExperimentSnapshot): string {
  const summary = summarizeExperimentJobs(snapshot.jobs);
  const treatments = new Map<
    string,
    { total: number; succeeded: number; failed: number; latency: number[]; cost: number }
  >();
  for (const record of snapshot.jobs) {
    const current = treatments.get(record.job.treatmentId) ?? {
      total: 0,
      succeeded: 0,
      failed: 0,
      latency: [],
      cost: 0
    };
    current.total += 1;
    current.succeeded += record.status === "succeeded" ? 1 : 0;
    current.failed += record.status === "failed" ? 1 : 0;
    if (record.latencyMs !== undefined) current.latency.push(record.latencyMs);
    current.cost += record.providerCostUsd + record.infrastructureCostUsd;
    treatments.set(record.job.treatmentId, current);
  }
  const treatmentRows = [...treatments.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([id, values]) =>
        `| ${id} | ${values.total} | ${values.succeeded} | ${values.failed} | ${percentile(
          values.latency,
          0.5
        )} | ${percentile(values.latency, 0.95)} | ${dollars(values.cost)} |`
    );

  return [
    `# Experiment report: ${snapshot.experiment.experimentId}`,
    "",
    `**Objective:** ${snapshot.experiment.manifest.objective}`,
    "",
    `**Status:** ${snapshot.experiment.status}`,
    "",
    `**Manifest hash:** \`${snapshot.experiment.manifestHash}\``,
    "",
    "## Execution summary",
    "",
    `- Jobs: ${summary.total}`,
    `- Succeeded: ${summary.succeeded}`,
    `- Failed: ${summary.failed}`,
    `- Still active: ${summary.pending + summary.queued + summary.running}`,
    `- Median latency: ${summary.p50LatencyMs} ms`,
    `- 95th-percentile latency: ${summary.p95LatencyMs} ms`,
    `- Provider cost: ${dollars(summary.providerCostUsd)}`,
    `- Infrastructure cost: ${dollars(summary.infrastructureCostUsd)}`,
    `- Provider budget: ${dollars(snapshot.experiment.manifest.budget.providerMaximumUsd)}`,
    `- Infrastructure budget: ${dollars(snapshot.experiment.manifest.budget.vercelMaximumUsd)}`,
    `- Provider budget exceeded: ${
      snapshot.experiment.providerSpentUsd >
      snapshot.experiment.manifest.budget.providerMaximumUsd + Number.EPSILON
        ? "yes"
        : "no"
    }`,
    `- Infrastructure budget exceeded: ${
      snapshot.experiment.infrastructureSpentUsd >
      snapshot.experiment.manifest.budget.vercelMaximumUsd + Number.EPSILON
        ? "yes"
        : "no"
    }`,
    ...(snapshot.experiment.error === undefined
      ? []
      : [`- Terminal reason: ${snapshot.experiment.error}`]),
    "",
    "## Treatment results",
    "",
    "| Treatment | Jobs | Succeeded | Failed | p50 ms | p95 ms | Total cost |",
    "| -- | --: | --: | --: | --: | --: | --: |",
    ...treatmentRows,
    "",
    "## Reproducibility",
    "",
    `- Source commit: \`${snapshot.experiment.manifest.code.sourceCommit}\``,
    `- Runner image: \`${snapshot.experiment.manifest.code.image}\``,
    `- Dataset: \`${snapshot.experiment.manifest.dataset.id}\``,
    `- Dataset hash: \`${snapshot.experiment.manifest.dataset.hash}\``,
    `- Data role: \`${snapshot.experiment.manifest.dataset.role}\``,
    `- Seeds: ${snapshot.experiment.manifest.matrix.seeds.join(", ")}`,
    "",
    "This report records execution, latency, and cost. Method-specific accuracy metrics should be",
    "written by the reducer as an additional immutable artifact.",
    ""
  ].join("\n");
}
