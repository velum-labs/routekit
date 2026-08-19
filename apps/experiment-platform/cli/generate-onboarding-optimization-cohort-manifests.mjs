#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { freezeExperimentPlan } from "@velum-labs/routekit-eval-core/experiment";
import { stringify } from "yaml";

import { assetRoot, image, root, seed } from "./onboarding-optimization-common.mjs";

const sourceCommit = process.argv[2];
if (!sourceCommit) throw new Error("source commit is required");
const outputDirectory = path.join(
  root,
  "apps/experiment-platform/examples/onboarding-optimization"
);

async function inventory(datasetId) {
  return JSON.parse(
    await readFile(path.join(assetRoot, "cohorts", datasetId, "input-inventory.json"), "utf8")
  );
}

function manifest({ experimentId, objective, source, tasks, budgetMultiplier = 1.15 }) {
  const selectedTasks = tasks ?? source.tasks;
  const treatments = source.metadata.treatmentDefinitions.map((definition) => {
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
    selectedTasks.length *
    treatments.reduce((sum, treatment) => sum + treatment.estimatedProviderCostUsd, 0);
  return {
    schemaVersion: 1,
    experimentId,
    objective,
    code: { image, sourceCommit },
    dataset: { id: source.datasetId, hash: source.datasetHash, role: "development" },
    matrix: { treatments, seeds: [seed] },
    tasks: selectedTasks.map((task) => ({
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
      maximumPromotedTreatments: source.metadata.comparisonGroups.length
    },
    budget: {
      providerMaximumUsd: Number((expected * budgetMultiplier).toFixed(2)),
      vercelMaximumUsd: 0.5
    },
    dataAccess: { lockedTest: false }
  };
}

const [natural, real, assistance] = await Promise.all([
  inventory("onboarding-optimization-natural-hard-48x3-v1"),
  inventory("onboarding-optimization-real-auto-45-v1"),
  inventory("onboarding-optimization-routekit-assistance-validation-3x2-v1")
]);
const naturalCanary = [];
const naturalSeen = new Set();
for (const task of natural.tasks) {
  if (naturalSeen.has(task.metadata.repositoryId)) continue;
  naturalSeen.add(task.metadata.repositoryId);
  naturalCanary.push(task);
}
const realCanary = [];
const realSeen = new Set();
for (const task of real.tasks) {
  if (realSeen.has(task.metadata.repositoryId)) continue;
  realSeen.add(task.metadata.repositoryId);
  realCanary.push(task);
}
const specifications = [
  {
    name: "natural-hard-canary",
    value: manifest({
      experimentId: "onboarding-optimization-natural-hard-canary-2x3-v1",
      objective: "Validate all natural-hard registry contracts on one task per repository.",
      source: natural,
      tasks: naturalCanary
    })
  },
  {
    name: "natural-hard",
    value: manifest({
      experimentId: "onboarding-optimization-natural-hard-48x3-v1",
      objective:
        "Measure selected and repaired registries on a frozen natural hard-case benchmark relative to human registries.",
      source: natural
    })
  },
  {
    name: "real-auto-canary",
    value: manifest({
      experimentId: "onboarding-optimization-real-auto-canary-4-v1",
      objective:
        "Validate Sol, Claude, and Luna contracts on one real conversational task per private repository.",
      source: real,
      tasks: realCanary
    })
  },
  {
    name: "real-auto",
    value: manifest({
      experimentId: "onboarding-optimization-real-auto-45-v1",
      objective:
        "Evaluate automatically generated registries on frozen real conversational coding prompts.",
      source: real,
      budgetMultiplier: 1.45
    })
  },
  {
    name: "routekit-assistance-validation",
    value: manifest({
      experimentId: "onboarding-optimization-routekit-assistance-validation-3x2-v1",
      objective:
        "Compare human and automatic RouteKit registries on three real conversational validation tasks before repair.",
      source: assistance
    })
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
