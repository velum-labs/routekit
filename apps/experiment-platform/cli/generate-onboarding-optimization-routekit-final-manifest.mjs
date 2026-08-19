#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { freezeExperimentPlan } from "@velum-labs/routekit-eval-core/experiment";
import { stringify } from "yaml";

import { assetRoot, image, root, seed } from "./onboarding-optimization-common.mjs";

const sourceCommit = process.argv[2];
if (!sourceCommit) throw new Error("source commit is required");
const datasetId = "onboarding-optimization-routekit-assistance-final-5x3-v1";
const inventory = JSON.parse(
  await readFile(
    path.join(assetRoot, "routekit-assistance", datasetId, "input-inventory.json"),
    "utf8"
  )
);
const treatments = inventory.metadata.treatmentDefinitions.map((definition) => ({
  id: definition.id,
  executor: "hosted-model",
  configuration: {
    model: definition.model,
    evaluationRole: definition.evaluationRole,
    comparisonGroup: definition.comparisonGroup,
    timeoutSeconds: 240
  },
  estimatedProviderCostUsd: definition.evaluationRole === "composition_reference" ? 0.045 : 0.003,
  estimatedInfrastructureCostUsd: 0
}));
const expected =
  inventory.tasks.length *
  treatments.reduce((sum, treatment) => sum + treatment.estimatedProviderCostUsd, 0);
const manifest = {
  schemaVersion: 1,
  experimentId: datasetId,
  objective:
    "Compare human, automatic, and validation-repaired RouteKit registries on five held-out real conversational test tasks.",
  code: { image, sourceCommit },
  dataset: { id: inventory.datasetId, hash: inventory.datasetHash, role: "development" },
  matrix: { treatments, seeds: [seed] },
  tasks: inventory.tasks.map((task) => ({
    id: task.id,
    inputArtifact: task.pathname,
    metadata: task.metadata
  })),
  schedule: {
    type: "paired_interleave",
    maximumHostedCallsInFlight: 8,
    maximumSandboxes: 1
  },
  selection: {
    primaryMetric: "composition_mean_active_area_absolute_error",
    secondaryMetrics: [
      "composition_mean_cosine_similarity",
      "composition_active_area_f1",
      "composition_top_area_agreement",
      "composition_unknown_absolute_error"
    ],
    maximumPromotedTreatments: 3
  },
  budget: {
    providerMaximumUsd: Number((expected * 1.15).toFixed(2)),
    vercelMaximumUsd: 0.25
  },
  dataAccess: { lockedTest: false }
};
const outputDirectory = path.join(
  root,
  "apps/experiment-platform/examples/onboarding-optimization"
);
await mkdir(outputDirectory, { recursive: true });
const plan = freezeExperimentPlan(manifest, "2026-08-19T00:00:00.000Z");
const file = path.join(outputDirectory, "routekit-assistance-final.yaml");
await writeFile(file, stringify(manifest, { lineWidth: 0 }));
console.log(
  JSON.stringify(
    {
      ok: true,
      file,
      jobs: plan.jobs.length,
      providerBudgetUsd: manifest.budget.providerMaximumUsd
    },
    null,
    2
  )
);
