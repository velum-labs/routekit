#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { freezeExperimentPlan } from "@velum-labs/routekit-eval-core/experiment";
import { stringify } from "yaml";

import { assetRoot, image, root, seed } from "./onboarding-optimization-common.mjs";

const sourceCommit = process.argv[2];
if (!sourceCommit) throw new Error("source commit is required");

const datasetId = "onboarding-optimization-final-retry-1-v1";
const inventory = JSON.parse(
  await readFile(path.join(assetRoot, "final-retry", datasetId, "input-inventory.json"), "utf8")
);
const outputDirectory = path.join(
  root,
  "apps/experiment-platform/examples/onboarding-optimization"
);
const manifest = {
  schemaVersion: 1,
  experimentId: datasetId,
  objective:
    "Retry one final-test Luna response that exhausted its reasoning limit before emitting JSON.",
  code: { image, sourceCommit },
  dataset: { id: inventory.datasetId, hash: inventory.datasetHash, role: "development" },
  matrix: {
    treatments: [
      {
        id: "final_retry",
        executor: "hosted-model",
        configuration: {
          model: "openai/gpt-5.6-luna",
          evaluationRole: "composition_candidate_retry",
          comparisonGroup: "human",
          timeoutSeconds: 240
        },
        estimatedProviderCostUsd: 0.02,
        estimatedInfrastructureCostUsd: 0
      }
    ],
    seeds: [seed]
  },
  tasks: inventory.tasks.map((task) => ({
    id: task.id,
    inputArtifact: task.pathname,
    metadata: task.metadata
  })),
  schedule: {
    type: "paired_interleave",
    maximumHostedCallsInFlight: 1,
    maximumSandboxes: 1
  },
  selection: {
    primaryMetric: "composition_contract_validity",
    secondaryMetrics: ["provider_cost_usd"],
    maximumPromotedTreatments: 1
  },
  budget: {
    providerMaximumUsd: 0.03,
    vercelMaximumUsd: 0.25
  },
  dataAccess: { lockedTest: false }
};

await mkdir(outputDirectory, { recursive: true });
const plan = freezeExperimentPlan(manifest, "2026-08-19T00:00:00.000Z");
const file = path.join(outputDirectory, "final-retry.yaml");
await writeFile(file, stringify(manifest, { lineWidth: 0 }));
console.log(
  JSON.stringify(
    {
      ok: true,
      file,
      experimentId: manifest.experimentId,
      jobs: plan.jobs.length,
      providerBudgetUsd: manifest.budget.providerMaximumUsd
    },
    null,
    2
  )
);
