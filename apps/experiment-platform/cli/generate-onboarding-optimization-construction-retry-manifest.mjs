#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { freezeExperimentPlan } from "@velum-labs/routekit-eval-core/experiment";
import { stringify } from "yaml";

import { assetRoot, image, root, seed } from "./onboarding-optimization-common.mjs";

const sourceCommit = process.argv[2];
if (!sourceCommit) throw new Error("source commit is required");

const datasetId = "onboarding-optimization-construction-retry-3-v1";
const inventory = JSON.parse(
  await readFile(
    path.join(assetRoot, "construction-retry", datasetId, "input-inventory.json"),
    "utf8"
  )
);
const outputDirectory = path.join(
  root,
  "apps/experiment-platform/examples/onboarding-optimization"
);
const treatment = {
  id: "registry_retry",
  executor: "hosted-model",
  configuration: {
    model: "openai/gpt-5.6-sol",
    evaluationRole: "registry_generation_retry",
    timeoutSeconds: 360
  },
  estimatedProviderCostUsd: 0.6,
  estimatedInfrastructureCostUsd: 0
};
const manifest = {
  schemaVersion: 1,
  experimentId: datasetId,
  objective:
    "Retry three registry-generation responses that exhausted the original completion-token limit.",
  code: { image, sourceCommit },
  dataset: { id: inventory.datasetId, hash: inventory.datasetHash, role: "construction" },
  matrix: { treatments: [treatment], seeds: [seed] },
  tasks: inventory.tasks.map((task) => ({
    id: task.id,
    inputArtifact: task.pathname,
    metadata: task.metadata
  })),
  schedule: {
    type: "paired_interleave",
    maximumHostedCallsInFlight: 3,
    maximumSandboxes: 1
  },
  selection: {
    primaryMetric: "construction_contract_validity",
    secondaryMetrics: ["provider_cost_usd"],
    maximumPromotedTreatments: 1
  },
  budget: {
    providerMaximumUsd: 2.07,
    vercelMaximumUsd: 0.25
  },
  dataAccess: { lockedTest: false }
};

await mkdir(outputDirectory, { recursive: true });
const plan = freezeExperimentPlan(manifest, "2026-08-19T00:00:00.000Z");
const file = path.join(outputDirectory, "construction-retry.yaml");
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
