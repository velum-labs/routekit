import { notFound } from "next/navigation";

import {
  requiredExperimentApprovalStages,
  summarizeExperimentJobs
} from "@velum-labs/routekit-eval-core/experiment";

import { getExperimentLedger } from "@/lib/platform";

import { ApprovalForm } from "./approval-form";

export const dynamic = "force-dynamic";

export default async function ExperimentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ledger = await getExperimentLedger();
  const snapshot = await ledger.getExperiment(decodeURIComponent(id));
  if (snapshot === undefined) notFound();
  const summary = summarizeExperimentJobs(snapshot.jobs);
  const approvedStages = new Set(snapshot.approvals.map((approval) => approval.stage));
  const missingApprovalStages = requiredExperimentApprovalStages({
    manifest: snapshot.experiment.manifest,
    jobs: snapshot.jobs.map((record) => record.job)
  }).filter((stage) => !approvedStages.has(stage));

  return (
    <div className="page">
      <section className="hero">
        <div>
          <div className={`status ${snapshot.experiment.status}`}>{snapshot.experiment.status}</div>
          <h1>{snapshot.experiment.experimentId}</h1>
          <p className="subtitle">{snapshot.experiment.manifest.objective}</p>
        </div>
      </section>

      <section className="grid">
        <div className="metric">
          <div className="metric-label">Jobs</div>
          <div className="metric-value">{summary.total}</div>
        </div>
        <div className="metric">
          <div className="metric-label">Succeeded / failed</div>
          <div className="metric-value">
            {summary.succeeded} / {summary.failed}
          </div>
        </div>
        <div className="metric">
          <div className="metric-label">p50 / p95</div>
          <div className="metric-value">
            {summary.p50LatencyMs} / {summary.p95LatencyMs}
          </div>
        </div>
        <div className="metric">
          <div className="metric-label">Total spend</div>
          <div className="metric-value">
            ${(summary.providerCostUsd + summary.infrastructureCostUsd).toFixed(2)}
          </div>
        </div>
      </section>

      {snapshot.experiment.status === "awaiting_approval" ? (
        <section className="panel">
          <div className="panel-header">
            <h2>Approval required</h2>
          </div>
          <div className="panel-body">
            <ApprovalForm
              experimentId={snapshot.experiment.experimentId}
              stages={missingApprovalStages}
            />
          </div>
        </section>
      ) : null}

      {snapshot.experiment.metricsArtifact !== undefined ||
      snapshot.experiment.reportArtifact !== undefined ? (
        <section className="panel">
          <div className="panel-header">
            <h2>Results</h2>
          </div>
          <div className="panel-body actions">
            {snapshot.experiment.reportArtifact === undefined ? null : (
              <a
                className="button"
                href={`/experiments/${encodeURIComponent(snapshot.experiment.experimentId)}/artifacts/report`}
              >
                Open Markdown report
              </a>
            )}
            {snapshot.experiment.metricsArtifact === undefined ? null : (
              <a
                className="button secondary"
                href={`/experiments/${encodeURIComponent(snapshot.experiment.experimentId)}/artifacts/metrics`}
              >
                Download metrics JSON
              </a>
            )}
          </div>
        </section>
      ) : null}

      <div className="detail-grid">
        <section className="panel">
          <div className="panel-header">
            <h2>Jobs</h2>
          </div>
          <div className="panel-body">
            <table>
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Treatment</th>
                  <th>Status</th>
                  <th>Attempts</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.jobs.slice(0, 200).map((record) => (
                  <tr key={record.job.id}>
                    <td>{record.job.taskId}</td>
                    <td>{record.job.treatmentId}</td>
                    <td className={`status ${record.status}`}>{record.status}</td>
                    <td>{record.attemptCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <section className="panel">
          <div className="panel-header">
            <h2>Frozen manifest</h2>
          </div>
          <div className="panel-body">
            <div className="hash">{snapshot.experiment.manifestHash}</div>
            <pre>{JSON.stringify(snapshot.experiment.manifest, null, 2)}</pre>
          </div>
        </section>
      </div>
    </div>
  );
}
