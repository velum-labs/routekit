#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { freezeExperimentPlan } from "@velum-labs/routekit-eval-core/experiment";
import { stringify } from "yaml";

const argv = process.argv.slice(2);
const root = path.resolve(import.meta.dirname, "../../..");
const evaluationRoot = path.join(
  root,
  ".routekit-experiment-assets/onboarding-followups-20260819/evaluations"
);
const outputDirectory = path.join(root, "apps/experiment-platform/examples/onboarding-followups");

function argument(name) {
  const index = argv.indexOf(name);
  const value = index < 0 ? undefined : argv[index + 1];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
const image = argument("--image");
const sourceCommit = argument("--source-commit");

const specifications = [
  {
    name: "common-reference",
    datasetId: "onboarding-common-reference-backstage-60-v1",
    experimentId: "onboarding-common-reference-backstage-60-v1",
    objective:
      "Compare shortlisted Backstage taxonomies against one frozen taxonomy-neutral responsibility reference per task."
  },
  {
    name: "unknown-benchmark",
    datasetId: "onboarding-unknown-benchmark-60-v1",
    experimentId: "onboarding-unknown-benchmark-60-v1",
    objective:
      "Measure separate unknown probability against a vague other area and a positively defined shared area on covered, partly unknown, entirely unknown, and real tasks."
  },
  {
    name: "structure-matrix",
    datasetId: "onboarding-structure-matrix-100-v1",
    experimentId: "onboarding-structure-matrix-100-v1",
    objective:
      "Compare controlled area counts, disjoint versus bounded overlap, leaf-only cuts, and parent-child mixtures across 100 development tasks."
  },
  {
    name: "area-card-ablation",
    datasetId: "onboarding-area-card-ablation-100-v1",
    experimentId: "onboarding-area-card-ablation-100-v1",
    objective:
      "Determine the minimum useful Area Card by isolating summaries, real code snippets, anchor counts, positive examples, and negative boundaries."
  },
  {
    name: "generation-comparison",
    datasetId: "onboarding-generation-comparison-real-58-v1",
    experimentId: "onboarding-generation-comparison-real-58-v1",
    objective:
      "Compare unconstrained Sol generation, rule-guided Sol generation, and the existing human-reviewed registry on real tasks."
  }
];

await mkdir(outputDirectory, { recursive: true });
const generated = [];
for (const specification of specifications) {
  const inventory = JSON.parse(
    await readFile(
      path.join(evaluationRoot, specification.datasetId, "input-inventory.json"),
      "utf8"
    )
  );
  const treatments = inventory.treatmentDefinitions.map((definition) => {
    const reference =
      definition.evaluationRole === "composition_reference" ||
      definition.evaluationRole === "neutral_reference";
    return {
      id: definition.id,
      executor: "hosted-model",
      configuration: {
        model: definition.model,
        evaluationRole: definition.evaluationRole,
        ...(definition.comparisonGroup ? { comparisonGroup: definition.comparisonGroup } : {}),
        timeoutSeconds: 240
      },
      estimatedProviderCostUsd: reference ? 0.05 : 0.005,
      estimatedInfrastructureCostUsd: 0
    };
  });
  const expected =
    inventory.tasks.length *
    treatments.reduce((sum, treatment) => sum + treatment.estimatedProviderCostUsd, 0);
  const manifest = {
    schemaVersion: 1,
    experimentId: specification.experimentId,
    objective: specification.objective,
    code: { image, sourceCommit },
    dataset: { id: inventory.datasetId, hash: inventory.datasetHash, role: "development" },
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
      primaryMetric: "composition_mean_active_area_absolute_error",
      secondaryMetrics: [
        "composition_active_area_recall",
        "composition_false_positive_mass",
        "composition_unknown_absolute_error",
        "composition_contract_validity"
      ],
      maximumPromotedTreatments: 4
    },
    budget: {
      providerMaximumUsd: Number((expected * 1.05).toFixed(2)),
      vercelMaximumUsd: 0.5
    },
    dataAccess: { lockedTest: false }
  };
  const plan = freezeExperimentPlan(manifest, "2026-08-19T00:00:00.000Z");
  const file = path.join(outputDirectory, `${specification.name}.yaml`);
  await writeFile(file, stringify(manifest, { lineWidth: 0 }));
  generated.push({
    name: specification.name,
    file,
    experimentId: manifest.experimentId,
    tasks: inventory.tasks.length,
    treatments: treatments.length,
    jobs: plan.jobs.length,
    providerBudgetUsd: manifest.budget.providerMaximumUsd
  });
}

console.log(
  JSON.stringify(
    {
      ok: true,
      generated,
      totalJobs: generated.reduce((sum, item) => sum + item.jobs, 0),
      totalProviderBudgetUsd: generated.reduce((sum, item) => sum + item.providerBudgetUsd, 0)
    },
    null,
    2
  )
);
