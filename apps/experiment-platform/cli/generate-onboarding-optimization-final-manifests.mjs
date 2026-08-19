#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { freezeExperimentPlan } from "@velum-labs/routekit-eval-core/experiment";
import { stringify } from "yaml";

import { assetRoot, image, root, seed } from "./onboarding-optimization-common.mjs";

const sourceCommit = process.argv[2];
if (!sourceCommit) throw new Error("source commit is required");
const datasetId = "onboarding-optimization-final-84x4x3-v1";
const inventory = JSON.parse(
  await readFile(path.join(assetRoot, "final", datasetId, "input-inventory.json"), "utf8")
);
const outputDirectory = path.join(
  root,
  "apps/experiment-platform/examples/onboarding-optimization"
);

function manifest(experimentId, objective, tasks, budgetMultiplier = 1.15) {
  const treatments = inventory.metadata.treatmentDefinitions.map((definition) => {
    const estimate =
      definition.evaluationRole === "composition_reference"
        ? 0.045
        : definition.evaluationRole === "composition_independent_reference"
          ? 0.015
          : 0.003;
    return {
      id: definition.id,
      executor: "hosted-model",
      configuration: {
        model: definition.model,
        evaluationRole: definition.evaluationRole,
        comparisonGroup: definition.comparisonGroup,
        timeoutSeconds: 240
      },
      estimatedProviderCostUsd: estimate,
      estimatedInfrastructureCostUsd: 0
    };
  });
  const expected =
    tasks.length *
    treatments.reduce((sum, treatment) => sum + treatment.estimatedProviderCostUsd, 0);
  return {
    schemaVersion: 1,
    experimentId,
    objective,
    code: { image, sourceCommit },
    dataset: { id: inventory.datasetId, hash: inventory.datasetHash, role: "development" },
    matrix: { treatments, seeds: [seed] },
    tasks: tasks.map((task) => ({
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
        "composition_unknown_absolute_error",
        "composition_contract_validity"
      ],
      maximumPromotedTreatments: 4
    },
    budget: {
      providerMaximumUsd: Number((expected * budgetMultiplier).toFixed(2)),
      vercelMaximumUsd: 0.75
    },
    dataAccess: { lockedTest: false }
  };
}

const canaryTasks = [];
const seen = new Set();
for (const task of inventory.tasks) {
  if (seen.has(task.metadata.repositoryId)) continue;
  seen.add(task.metadata.repositoryId);
  canaryTasks.push(task);
}
const specifications = [
  {
    name: "final-canary",
    value: manifest(
      "onboarding-optimization-final-canary-3x4x3-v1",
      "Validate Sol, Claude, and Luna contracts for every final registry on one task per repository.",
      canaryTasks
    )
  },
  {
    name: "final",
    value: manifest(
      "onboarding-optimization-final-84x4x3-v1",
      "Evaluate human, previous unconstrained, validation-selected, and repaired registries on an untouched chronological final test with an independent judge.",
      inventory.tasks,
      1.45
    )
  }
];

await mkdir(outputDirectory, { recursive: true });
const generated = [];
for (const specification of specifications) {
  const plan = freezeExperimentPlan(specification.value, "2026-08-19T00:00:00.000Z");
  const file = path.join(outputDirectory, `${specification.name}.yaml`);
  await writeFile(file, stringify(specification.value, { lineWidth: 0 }));
  generated.push({
    file,
    experimentId: specification.value.experimentId,
    jobs: plan.jobs.length,
    providerBudgetUsd: specification.value.budget.providerMaximumUsd
  });
}
console.log(JSON.stringify({ ok: true, generated }, null, 2));
