import Link from "next/link";

import { freezeExperimentPlan } from "@velum-labs/routekit-eval-core/experiment";

import { getExperimentLedger, platformConfiguration } from "@/lib/platform";

import { SubmitForm } from "./submit-form";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const ledger = await getExperimentLedger();
  const experiments = await ledger.listExperiments();
  const active = experiments.filter((experiment) =>
    ["queued", "running", "aggregating"].includes(experiment.status)
  ).length;
  const awaiting = experiments.filter(
    (experiment) => experiment.status === "awaiting_approval"
  ).length;
  const providerSpent = experiments.reduce(
    (sum, experiment) => sum + experiment.providerSpentUsd,
    0
  );
  const infrastructureSpent = experiments.reduce(
    (sum, experiment) => sum + experiment.infrastructureSpentUsd,
    0
  );
  const configuration = platformConfiguration();

  return (
    <div className="page">
      <section className="hero">
        <div>
          <h1>Run more experiments without losing scientific control.</h1>
          <p className="subtitle">
            Immutable manifests, paired jobs, resumable execution, hard budget checks, content
            hashes, Functions for hosted models, and Sandboxes for repository work.
          </p>
        </div>
        <span className="pill">{configuration.mode}</span>
      </section>

      {!configuration.productionReady ? (
        <div className="notice">
          Production configuration is incomplete. The implementation is usable locally, but a
          protected Vercel deployment still needs:{" "}
          {configuration.missingProductionConfiguration.join(", ")}.
        </div>
      ) : null}

      <section className="grid">
        <div className="metric">
          <div className="metric-label">Experiments</div>
          <div className="metric-value">{experiments.length}</div>
        </div>
        <div className="metric">
          <div className="metric-label">Active / approval</div>
          <div className="metric-value">
            {active} / {awaiting}
          </div>
        </div>
        <div className="metric">
          <div className="metric-label">Provider spend</div>
          <div className="metric-value">${providerSpent.toFixed(2)}</div>
        </div>
        <div className="metric">
          <div className="metric-label">Infrastructure spend</div>
          <div className="metric-value">${infrastructureSpent.toFixed(2)}</div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Experiments</h2>
          <span className="small">{configuration.ledger} ledger</span>
        </div>
        {experiments.length === 0 ? (
          <div className="panel-body small">No experiments have been submitted yet.</div>
        ) : (
          experiments.map((experiment) => {
            const plannedJobs = freezeExperimentPlan(
              experiment.manifest,
              experiment.createdAt
            ).jobs;
            const expectedProviderCost = plannedJobs.reduce(
              (sum, job) => sum + job.estimatedProviderCostUsd,
              0
            );
            return (
              <Link
                className="experiment-row"
                href={`/experiments/${encodeURIComponent(experiment.experimentId)}`}
                key={experiment.experimentId}
              >
                <div>
                  <div className="experiment-title">{experiment.experimentId}</div>
                  <div className="small">{experiment.manifest.objective}</div>
                </div>
                <div className={`status ${experiment.status}`}>{experiment.status}</div>
                <div className="small">{experiment.manifest.dataset.role}</div>
                <div>
                  <div className="hash">{experiment.manifestHash.slice(0, 12)}</div>
                  <div className="small">${expectedProviderCost.toFixed(2)} planned</div>
                </div>
              </Link>
            );
          })
        )}
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Submit an experiment</h2>
          <span className="small">The manifest is hashed before any job is created.</span>
        </div>
        <div className="panel-body">
          <SubmitForm />
        </div>
      </section>
    </div>
  );
}
