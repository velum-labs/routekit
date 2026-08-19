#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { freezeExperimentPlan } from "@velum-labs/routekit-eval-core/experiment";
import { stringify } from "yaml";

import { assetRoot, image, root, seed } from "./onboarding-optimization-common.mjs";

const sourceCommit = process.argv[2];
if (!sourceCommit) throw new Error("source commit is required");
const datasetId = "onboarding-optimization-neutral-93-v1";
const inventory = JSON.parse(
  await readFile(path.join(assetRoot, "neutral", datasetId, "input-inventory.json"), "utf8")
);
const outputDirectory = path.join(
  root,
  "apps/experiment-platform/examples/onboarding-optimization"
);

function manifest(experimentId, objective, tasks) {
  const treatments = [
    {
      id: "neutral_sol",
      executor: "hosted-model",
      configuration: {
        model: "openai/gpt-5.6-sol",
        evaluationRole: "neutral_reference",
        timeoutSeconds: 240
      },
      estimatedProviderCostUsd: 0.05,
      estimatedInfrastructureCostUsd: 0
    }
  ];
  return {
    schemaVersion: 1,
    experimentId,
    objective,
    code: { image, sourceCommit },
    dataset: { id: inventory.datasetId, hash: inventory.datasetHash, role: "construction" },
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
      primaryMetric: "construction_contract_validity",
      secondaryMetrics: ["provider_cost_usd"],
      maximumPromotedTreatments: 1
    },
    budget: {
      providerMaximumUsd: Number((tasks.length * 0.05 * 1.15).toFixed(2)),
      vercelMaximumUsd: 0.25
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
    name: "neutral-canary",
    value: manifest(
      "onboarding-optimization-neutral-canary-6-v1",
      "Validate taxonomy-neutral contracts across every repository in the two added cohorts.",
      canaryTasks
    )
  },
  {
    name: "neutral",
    value: manifest(
      "onboarding-optimization-neutral-93-v1",
      "Create frozen taxonomy-neutral responsibility decompositions for natural-hard and real conversational coding tasks.",
      inventory.tasks
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
