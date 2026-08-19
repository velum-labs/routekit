#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { freezeExperimentPlan } from "@velum-labs/routekit-eval-core/experiment";
import { stringify } from "yaml";

const argv = process.argv.slice(2);
const root = path.resolve(import.meta.dirname, "../../..");
const evaluationRoot = path.join(
  root,
  ".routekit-experiment-assets/onboarding-generalization-20260819/evaluation"
);
const outputDirectory = path.join(
  root,
  "apps/experiment-platform/examples/onboarding-generalization"
);

function argument(name) {
  const index = argv.indexOf(name);
  const value = index < 0 ? undefined : argv[index + 1];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const image = argument("--image");
const sourceCommit = argument("--source-commit");
const inventory = JSON.parse(
  await readFile(
    path.join(evaluationRoot, "onboarding-generalization-heldout-120-v1/input-inventory.json"),
    "utf8"
  )
);

function buildManifest(experimentId, objective, tasks) {
  const treatments = inventory.treatmentDefinitions.map((definition) => {
    const reference = definition.evaluationRole === "composition_reference";
    return {
      id: definition.id,
      executor: "hosted-model",
      configuration: {
        model: definition.model,
        evaluationRole: definition.evaluationRole,
        comparisonGroup: definition.comparisonGroup,
        timeoutSeconds: 240
      },
      estimatedProviderCostUsd: reference ? 0.05 : 0.005,
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
    matrix: { treatments, seeds: [181081] },
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
      maximumPromotedTreatments: 3
    },
    budget: {
      providerMaximumUsd: Number((expected * 1.15).toFixed(2)),
      vercelMaximumUsd: 0.5
    },
    dataAccess: { lockedTest: false }
  };
}

const canaryTasks = inventory.tasks.filter((task) =>
  [
    "backstage-backstage-heldout-pr-34480",
    "grafana-grafana-heldout-pr-130906",
    "kubernetes-kubernetes-heldout-pr-141440"
  ].includes(task.id)
);
if (canaryTasks.length !== 3) throw new Error("expected one canary task per repository");
const specifications = [
  {
    name: "canary",
    manifest: buildManifest(
      "onboarding-generalization-heldout-canary-3-v1",
      "Validate all three registries, both models, and all repositories on three held-out tasks before the full run.",
      canaryTasks
    )
  },
  {
    name: "evaluation",
    manifest: buildManifest(
      "onboarding-generalization-heldout-120-v1",
      "Measure whether rule-guided and unconstrained Sol-generated eight-area registries generalize to 120 chronologically held-out coding tasks relative to existing human-designed registries.",
      inventory.tasks
    )
  }
];

await mkdir(outputDirectory, { recursive: true });
const generated = [];
for (const specification of specifications) {
  const plan = freezeExperimentPlan(specification.manifest, "2026-08-19T00:00:00.000Z");
  const file = path.join(outputDirectory, `${specification.name}.yaml`);
  await writeFile(file, stringify(specification.manifest, { lineWidth: 0 }));
  generated.push({
    name: specification.name,
    file,
    experimentId: specification.manifest.experimentId,
    tasks: specification.manifest.tasks.length,
    jobs: plan.jobs.length,
    providerBudgetUsd: specification.manifest.budget.providerMaximumUsd
  });
}

console.log(JSON.stringify({ ok: true, generated }, null, 2));
