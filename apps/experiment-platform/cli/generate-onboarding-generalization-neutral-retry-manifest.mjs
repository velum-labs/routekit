#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { freezeExperimentPlan } from "@velum-labs/routekit-eval-core/experiment";
import { stringify } from "yaml";

const argv = process.argv.slice(2);
const root = path.resolve(import.meta.dirname, "../../..");
const outputDirectory = path.join(
  root,
  "apps/experiment-platform/examples/onboarding-generalization"
);
const inventoryFile = path.join(
  root,
  ".routekit-experiment-assets/onboarding-generalization-20260819/construction/onboarding-generalization-neutral-retry-1-v1/input-inventory.json"
);

function argument(name) {
  const index = argv.indexOf(name);
  const value = index < 0 ? undefined : argv[index + 1];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const image = argument("--image");
const sourceCommit = argument("--source-commit");
const inventory = JSON.parse(await readFile(inventoryFile, "utf8"));
const manifest = {
  schemaVersion: 1,
  experimentId: "onboarding-generalization-neutral-retry-1-v1",
  objective:
    "Retry the one truncated taxonomy-neutral Sol decomposition with a larger completion allowance.",
  code: { image, sourceCommit },
  dataset: { id: inventory.datasetId, hash: inventory.datasetHash, role: "construction" },
  matrix: {
    treatments: [
      {
        id: "neutral_sol_retry",
        executor: "hosted-model",
        configuration: {
          model: "openai/gpt-5.6-sol",
          evaluationRole: "neutral_reference",
          timeoutSeconds: 240
        },
        estimatedProviderCostUsd: 0.6,
        estimatedInfrastructureCostUsd: 0
      }
    ],
    seeds: [181081]
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
    primaryMetric: "construction_contract_validity",
    secondaryMetrics: ["provider_cost_usd"],
    maximumPromotedTreatments: 1
  },
  budget: {
    providerMaximumUsd: 0.8,
    vercelMaximumUsd: 0.05
  },
  dataAccess: { lockedTest: false }
};
const plan = freezeExperimentPlan(manifest, "2026-08-19T00:00:00.000Z");
await mkdir(outputDirectory, { recursive: true });
const file = path.join(outputDirectory, "construction-neutral-retry.yaml");
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
