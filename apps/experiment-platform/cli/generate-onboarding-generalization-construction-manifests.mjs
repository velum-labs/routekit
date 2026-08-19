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
const constructionRoot = path.join(
  root,
  ".routekit-experiment-assets/onboarding-generalization-20260819/construction"
);

function argument(name) {
  const index = argv.indexOf(name);
  const value = index < 0 ? undefined : argv[index + 1];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const image = argument("--image");
const sourceCommit = argument("--source-commit");

async function inventory(datasetId) {
  return JSON.parse(
    await readFile(path.join(constructionRoot, datasetId, "input-inventory.json"), "utf8")
  );
}

function manifest({ experimentId, objective, source, treatments }) {
  const expected = source.tasks.length
    ? source.tasks.length *
      treatments.reduce((sum, treatment) => sum + treatment.estimatedProviderCostUsd, 0)
    : 0;
  return {
    schemaVersion: 1,
    experimentId,
    objective,
    code: { image, sourceCommit },
    dataset: { id: source.datasetId, hash: source.datasetHash, role: "construction" },
    matrix: { treatments, seeds: [181081] },
    tasks: source.tasks.map((task) => ({
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
      providerMaximumUsd: Number((expected * 1.15).toFixed(2)),
      vercelMaximumUsd: 0.25
    },
    dataAccess: { lockedTest: false }
  };
}

const [neutral, generation] = await Promise.all([
  inventory("onboarding-generalization-neutral-120-v1"),
  inventory("onboarding-generalization-registries-3-v1")
]);
const specifications = [
  {
    name: "construction-neutral",
    value: manifest({
      experimentId: "onboarding-generalization-neutral-120-v1",
      objective:
        "Create one frozen taxonomy-neutral Sol responsibility decomposition for every chronologically held-out coding task.",
      source: neutral,
      treatments: [
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
      ]
    })
  },
  {
    name: "construction-registries",
    value: manifest({
      experimentId: "onboarding-generalization-registries-3-v1",
      objective:
        "Generate rule-guided and unconstrained eight-area registries from older coding tasks only, with a fourteen-day embargo before evaluation.",
      source: generation,
      treatments: ["auto_unconstrained_sol", "auto_rules_sol"].map((id) => ({
        id,
        executor: "hosted-model",
        configuration: {
          model: "openai/gpt-5.6-sol",
          evaluationRole: "registry_generation",
          timeoutSeconds: 240
        },
        estimatedProviderCostUsd: 0.15,
        estimatedInfrastructureCostUsd: 0
      }))
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
    name: specification.name,
    file,
    experimentId: specification.value.experimentId,
    jobs: plan.jobs.length,
    providerBudgetUsd: specification.value.budget.providerMaximumUsd
  });
}

console.log(JSON.stringify({ ok: true, generated }, null, 2));
