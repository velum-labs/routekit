#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { freezeExperimentPlan } from "@velum-labs/routekit-eval-core/experiment";
import { stringify } from "yaml";

import { assetRoot, image, root, seed } from "./onboarding-optimization-common.mjs";

const sourceCommit = process.argv[2];
if (!sourceCommit) throw new Error("source commit is required");

const inputDirectory = path.join(assetRoot, "construction");
const outputDirectory = path.join(
  root,
  "apps/experiment-platform/examples/onboarding-optimization"
);

async function inventory(datasetId) {
  return JSON.parse(
    await readFile(path.join(inputDirectory, datasetId, "input-inventory.json"), "utf8")
  );
}

function treatment(id, estimatedProviderCostUsd = 0.5) {
  return {
    id,
    executor: "hosted-model",
    configuration: {
      model: "openai/gpt-5.6-sol",
      evaluationRole: "registry_generation",
      timeoutSeconds: 240
    },
    estimatedProviderCostUsd,
    estimatedInfrastructureCostUsd: 0
  };
}

function manifest({ experimentId, objective, inventory: source, treatments, tasks }) {
  const selectedTasks = tasks ?? source.tasks;
  const expected =
    selectedTasks.length *
    treatments.reduce((sum, entry) => sum + entry.estimatedProviderCostUsd, 0);
  return {
    schemaVersion: 1,
    experimentId,
    objective,
    code: { image, sourceCommit },
    dataset: { id: source.datasetId, hash: source.datasetHash, role: "construction" },
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

const publicSource = await inventory("onboarding-optimization-public-registries-3x13-v1");
const privateSource = await inventory("onboarding-optimization-private-registries-4-v1");
const publicTreatmentIds = [
  "tasks_only_40_recent",
  "structure_only",
  "hybrid_40_recent",
  "hybrid_paths_40_recent",
  "hybrid_paths_5_diverse",
  "hybrid_paths_10_diverse",
  "hybrid_paths_20_diverse",
  "hybrid_paths_40_diverse_a",
  "hybrid_paths_40_diverse_b",
  "hybrid_paths_80_diverse",
  "hybrid_paths_40_diverse_6areas",
  "hybrid_paths_40_diverse_10areas",
  "hybrid_paths_40_diverse_rules"
];

const specifications = [
  {
    name: "construction-canary",
    value: manifest({
      experimentId: "onboarding-optimization-construction-canary-v1",
      objective: "Validate one registry-generation contract before the optimization campaign.",
      inventory: publicSource,
      treatments: [treatment("hybrid_paths_40_diverse_a")],
      tasks: publicSource.tasks.slice(0, 1)
    })
  },
  {
    name: "construction-public",
    value: manifest({
      experimentId: "onboarding-optimization-public-registries-3x13-v1",
      objective:
        "Generate information, history-size, sampling, variance, area-count, and rule-guided registry candidates using construction-era information only.",
      inventory: publicSource,
      treatments: publicTreatmentIds.map((id) => treatment(id))
    })
  },
  {
    name: "construction-private",
    value: manifest({
      experimentId: "onboarding-optimization-private-registries-4-v1",
      objective:
        "Generate eight-area hybrid registries for the frozen real conversational coding cohort.",
      inventory: privateSource,
      treatments: [treatment("real_hybrid_registry")]
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
