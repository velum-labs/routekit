import type {
  ExperimentJobRecord,
  ExperimentQueueMessage
} from "@velum-labs/routekit-eval-contracts";
import {
  evaluateClassificationPredictions,
  extractClassificationPrediction,
  renderClassificationMetrics,
  renderExperimentReport,
  type LabeledClassificationPrediction
} from "@velum-labs/routekit-eval-core/experiment";
import { putJsonArtifact } from "@velum-labs/routekit-eval-store/platform";
import { sleep } from "workflow";

import { artifactReferenceFromPath } from "@/lib/artifact-reference";
import { processExperimentJob } from "@/lib/execute-job";
import { getArtifactStore, getExperimentLedger } from "@/lib/platform";
import { DuplicateMessageError, send } from "@/lib/queue";

function topicFor(record: ExperimentJobRecord): string {
  if (record.job.executor === "hosted-model") return "hosted-model-call";
  if (record.job.executor === "sandbox") return "experiment-sandbox";
  throw new Error("local-command jobs are only supported by the local inline backend");
}

async function mapWithConcurrency<T>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T, index: number) => Promise<void>
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      const value = values[index];
      if (value !== undefined) await operation(value, index);
    }
  });
  await Promise.all(workers);
}

type ExperimentPreflightResult =
  | { outcome: "verified"; inputArtifacts: number }
  | { outcome: "cancelled" | "failed"; inputArtifacts: 0 };

async function preflightExperiment(experimentId: string): Promise<ExperimentPreflightResult> {
  "use step";

  const ledger = await getExperimentLedger();
  const snapshot = await ledger.getExperiment(experimentId);
  if (snapshot === undefined) throw new Error(`unknown experiment ${experimentId}`);
  if (snapshot.experiment.status === "cancelled") {
    return { outcome: "cancelled", inputArtifacts: 0 };
  }
  const paths = [
    ...new Set(snapshot.experiment.manifest.tasks.map((task) => task.inputArtifact))
  ].sort();
  try {
    const artifacts = getArtifactStore();
    await mapWithConcurrency(paths, 16, async (pathname) => {
      await artifacts.get(artifactReferenceFromPath(pathname));
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ledger.setExperimentStatus(
      experimentId,
      "failed",
      `input artifact preflight failed: ${message}`
    );
    return { outcome: "failed", inputArtifacts: 0 };
  }
  return { outcome: "verified", inputArtifacts: paths.length };
}

async function dispatchExperiment(experimentId: string): Promise<number> {
  "use step";

  const ledger = await getExperimentLedger();
  await ledger.queuePendingJobs(experimentId);
  const current = await ledger.getExperiment(experimentId);
  if (current === undefined) throw new Error(`unknown experiment ${experimentId}`);
  const queued = current.jobs.filter((record) => record.status === "queued");
  const useQueues =
    process.env.VERCEL === "1" || process.env.EXPERIMENT_PLATFORM_USE_VERCEL_QUEUES === "1";
  if (useQueues) {
    await mapWithConcurrency(queued, 32, async (record) => {
      const message: ExperimentQueueMessage = {
        experimentId,
        jobId: record.job.id
      };
      try {
        await send(topicFor(record), message, {
          idempotencyKey: record.job.idempotencyKey,
          retentionSeconds: 7 * 24 * 60 * 60
        });
      } catch (error) {
        if (!(error instanceof DuplicateMessageError)) throw error;
      }
    });
  } else {
    const concurrency = Math.max(
      1,
      Math.min(
        32,
        Math.max(
          current.experiment.manifest.schedule.maximumHostedCallsInFlight,
          current.experiment.manifest.schedule.maximumSandboxes
        )
      )
    );
    await mapWithConcurrency(queued, concurrency, async (record, index) => {
      await processExperimentJob(record.job.id, `local-workflow-${index}`);
    });
  }
  return queued.length;
}

async function experimentProgress(experimentId: string): Promise<{
  active: number;
  failed: number;
  terminal: boolean;
}> {
  "use step";

  const snapshot = await (await getExperimentLedger()).getExperiment(experimentId);
  if (snapshot === undefined) throw new Error(`unknown experiment ${experimentId}`);
  const active = snapshot.jobs.filter((record) =>
    ["pending", "queued", "running"].includes(record.status)
  ).length;
  const failed = snapshot.jobs.filter((record) => record.status === "failed").length;
  return {
    active,
    failed,
    terminal: active === 0
  };
}

async function aggregateExperiment(experimentId: string): Promise<string> {
  "use step";

  const ledger = await getExperimentLedger();
  const snapshot = await ledger.getExperiment(experimentId);
  if (snapshot === undefined) throw new Error(`unknown experiment ${experimentId}`);
  if (snapshot.experiment.status === "cancelled") return "cancelled";
  await ledger.setExperimentStatus(experimentId, "aggregating");
  const reportSnapshot = await ledger.getExperiment(experimentId);
  if (reportSnapshot === undefined) throw new Error(`unknown experiment ${experimentId}`);
  const artifacts = getArtifactStore();
  const taskMetadata = new Map(
    reportSnapshot.experiment.manifest.tasks.map((task) => [task.id, task.metadata])
  );
  const predictions: LabeledClassificationPrediction[] = [];
  const succeeded = reportSnapshot.jobs.filter(
    (record) => record.status === "succeeded" && record.outputArtifact !== undefined
  );
  for (let offset = 0; offset < succeeded.length; offset += 32) {
    const batch = await Promise.all(
      succeeded.slice(offset, offset + 32).map(async (record) => {
        if (record.outputArtifact === undefined) return undefined;
        const raw = JSON.parse(
          new TextDecoder().decode(await artifacts.get(record.outputArtifact))
        ) as unknown;
        const prediction = extractClassificationPrediction(raw);
        if (prediction === undefined) return undefined;
        const metadata = taskMetadata.get(record.job.taskId);
        const expectedScope =
          typeof metadata?.expectedScope === "string" ? metadata.expectedScope : undefined;
        const expectedArea =
          typeof metadata?.expectedArea === "string" ? metadata.expectedArea : undefined;
        if (expectedScope === undefined && expectedArea === undefined) return undefined;
        return {
          treatmentId: record.job.treatmentId,
          taskId: record.job.taskId,
          seed: record.job.seed,
          expectedScope,
          expectedArea,
          prediction: {
            ...prediction,
            latencyMs: record.latencyMs ?? prediction.latencyMs,
            providerCostUsd: record.providerCostUsd,
            infrastructureCostUsd: record.infrastructureCostUsd
          }
        } satisfies LabeledClassificationPrediction;
      })
    );
    predictions.push(...batch.filter((entry) => entry !== undefined));
  }
  const classificationMetrics = evaluateClassificationPredictions(predictions);
  const failedJobs = reportSnapshot.jobs.some((record) => record.status === "failed");
  const providerBudgetExceeded =
    reportSnapshot.experiment.providerSpentUsd >
    reportSnapshot.experiment.manifest.budget.providerMaximumUsd + Number.EPSILON;
  const infrastructureBudgetExceeded =
    reportSnapshot.experiment.infrastructureSpentUsd >
    reportSnapshot.experiment.manifest.budget.vercelMaximumUsd + Number.EPSILON;
  const budgetExceeded = providerBudgetExceeded || infrastructureBudgetExceeded;
  const finalStatus = failedJobs || budgetExceeded ? "failed" : "completed";
  const failureReasons = [
    ...(failedJobs ? ["one or more jobs failed"] : []),
    ...(providerBudgetExceeded ? ["actual provider cost exceeded its budget"] : []),
    ...(infrastructureBudgetExceeded ? ["actual Vercel cost exceeded its budget"] : [])
  ];
  const finalError = failureReasons.length === 0 ? undefined : failureReasons.join("; ");
  const metricsArtifact = await putJsonArtifact(
    artifacts,
    `metrics/${experimentId}/classification`,
    {
      schemaVersion: 1,
      experimentId,
      manifestHash: reportSnapshot.experiment.manifestHash,
      status: finalStatus,
      successfulJobs: succeeded.length,
      labeledPredictions: predictions.length,
      budget: {
        providerMaximumUsd: reportSnapshot.experiment.manifest.budget.providerMaximumUsd,
        providerSpentUsd: reportSnapshot.experiment.providerSpentUsd,
        providerExceeded: providerBudgetExceeded,
        vercelMaximumUsd: reportSnapshot.experiment.manifest.budget.vercelMaximumUsd,
        vercelSpentUsd: reportSnapshot.experiment.infrastructureSpentUsd,
        vercelExceeded: infrastructureBudgetExceeded
      },
      treatments: classificationMetrics
    }
  );
  await ledger.attachMetrics(experimentId, metricsArtifact);
  const report = [
    renderExperimentReport({
      ...reportSnapshot,
      experiment: { ...reportSnapshot.experiment, status: finalStatus, error: finalError }
    }).trimEnd(),
    "",
    renderClassificationMetrics(classificationMetrics).trimEnd(),
    "",
    "## Metric artifacts",
    "",
    `- Classification metrics: \`${metricsArtifact.pathname}\``,
    `- Labeled standardized predictions: ${predictions.length}`,
    ""
  ].join("\n");
  const artifact = await artifacts.put(report, {
    kind: `reports/${experimentId}`,
    contentType: "text/markdown",
    extension: "md"
  });
  await ledger.attachReport(experimentId, artifact);
  await ledger.setExperimentStatus(experimentId, finalStatus, finalError);
  return artifact.pathname;
}

export async function runExperimentWorkflow(experimentId: string): Promise<{
  experimentId: string;
  verifiedInputArtifacts: number;
  dispatched: number;
  report: string;
}> {
  "use workflow";

  const preflight = await preflightExperiment(experimentId);
  if (preflight.outcome !== "verified") {
    return {
      experimentId,
      verifiedInputArtifacts: 0,
      dispatched: 0,
      report: preflight.outcome
    };
  }
  const verifiedInputArtifacts = preflight.inputArtifacts;
  const dispatched = await dispatchExperiment(experimentId);
  while (true) {
    const progress = await experimentProgress(experimentId);
    if (progress.terminal) break;
    await sleep("10s");
  }
  const report = await aggregateExperiment(experimentId);
  return { experimentId, verifiedInputArtifacts, dispatched, report };
}
