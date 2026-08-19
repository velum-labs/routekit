#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { freezeExperimentPlan } from "@velum-labs/routekit-eval-core/experiment";
import { stringify } from "yaml";

const argv = process.argv.slice(2);
const root = path.resolve(import.meta.dirname, "../../..");
const outputDirectory = path.join(
  root,
  "apps/experiment-platform/examples/onboarding-followups"
);
const constructionRoot = path.join(
  root,
  ".routekit-experiment-assets/onboarding-followups-20260819/construction"
);

function argument(name) {
  const index = argv.indexOf(name);
  const value = index < 0 ? undefined : argv[index + 1];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
const image = argument("--image");
const sourceCommit = argument("--source-commit");

async function loadInventory(datasetId) {
  return JSON.parse(
    await readFile(path.join(constructionRoot, datasetId, "input-inventory.json"), "utf8")
  );
}

function buildManifest({ experimentId, objective, inventory, treatmentIds }) {
  const treatments = treatmentIds.map((id) => ({
    id,
    executor: "hosted-model",
    configuration: {
      model: "openai/gpt-5.6-sol",
      evaluationRole: id === "neutral_sol" ? "neutral_reference" : "registry_generation",
      timeoutSeconds: 240
    },
    estimatedProviderCostUsd: 0.05,
    estimatedInfrastructureCostUsd: 0
  }));
  const expected = inventory.tasks.length * treatments.length * 0.05;
  return {
    schemaVersion: 1,
    experimentId,
    objective,
    code: { image, sourceCommit },
    dataset: { id: inventory.datasetId, hash: inventory.datasetHash, role: "construction" },
    matrix: { treatments, seeds: [181081] },
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
      primaryMetric: "construction_contract_validity",
      secondaryMetrics: ["provider_cost_usd"],
      maximumPromotedTreatments: treatments.length
    },
    budget: {
      providerMaximumUsd: Number((expected * 1.05).toFixed(2)),
      vercelMaximumUsd: 0.25
    },
    dataAccess: { lockedTest: false }
  };
}

const neutral = await loadInventory("onboarding-neutral-responsibilities-100-v1");
const generation = await loadInventory("onboarding-registry-generation-3-v1");
const manifests = [
  [
    "construction-neutral",
    buildManifest({
      experimentId: "onboarding-neutral-responsibilities-100-v1",
      objective:
        "Create one taxonomy-neutral Sol responsibility decomposition for every development task before comparing Area Registries.",
      inventory: neutral,
      treatmentIds: ["neutral_sol"]
    })
  ],
  [
    "construction-generation",
    buildManifest({
      experimentId: "onboarding-registry-generation-3-v1",
      objective:
        "Generate unconstrained and rule-guided Sol Area Registries from taxonomy-neutral profiles and historical coding tasks.",
      inventory: generation,
      treatmentIds: ["auto_unconstrained_sol", "auto_rules_sol"]
    })
  ]
];

await mkdir(outputDirectory, { recursive: true });
const generated = [];
for (const [name, manifest] of manifests) {
  const plan = freezeExperimentPlan(manifest, "2026-08-19T00:00:00.000Z");
  const file = path.join(outputDirectory, `${name}.yaml`);
  await writeFile(file, stringify(manifest, { lineWidth: 0 }));
  generated.push({
    name,
    file,
    experimentId: manifest.experimentId,
    jobs: plan.jobs.length,
    providerBudgetUsd: manifest.budget.providerMaximumUsd
  });
}

console.log(JSON.stringify({ ok: true, generated }, null, 2));
