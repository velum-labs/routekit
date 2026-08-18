#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { freezeExperimentPlan } from "@velum-labs/routekit-eval-core/experiment";
import { stringify } from "yaml";

const argv = process.argv.slice(2);
const repositoryRoot = path.resolve(import.meta.dirname, "../../..");

function requiredArgument(name) {
  const index = argv.indexOf(name);
  const value = index === -1 ? undefined : argv[index + 1];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const image = requiredArgument("--image");
const sourceCommit = requiredArgument("--source-commit");
const inventoryFile = path.join(
  repositoryRoot,
  ".routekit-experiment-assets/composition-20260818/input-inventory.json"
);
const outputDirectory = path.join(repositoryRoot, "apps/experiment-platform/examples/composition");
const inventory = JSON.parse(await readFile(inventoryFile, "utf8"));
const candidateTreatments = [
  "luna_current",
  "luna_continuous",
  "luna_anchored",
  "luna_anchored_decomposition"
];

function treatment(id) {
  const reference = id === "sol_reference";
  return {
    id,
    executor: "hosted-model",
    configuration: {
      model: reference ? "openai/gpt-5.6-sol" : "openai/gpt-5.6-luna",
      evaluationRole: reference ? "composition_reference" : "composition_candidate",
      timeoutSeconds: 240
    },
    estimatedProviderCostUsd: reference ? 0.05 : 0.01,
    estimatedInfrastructureCostUsd: 0
  };
}

function manifestFor({ suffix, taskIds, providerMaximumUsd }) {
  const selected = new Set(taskIds);
  const tasks = inventory.tasks.filter((task) => selected.has(task.id));
  if (tasks.length !== taskIds.length) throw new Error(`Missing tasks for ${suffix}`);
  return {
    schemaVersion: 1,
    experimentId: `luna-composition-${suffix}-v1`,
    objective:
      "Measure how closely Luna direct-classification prompts reproduce GPT-5.6 Sol continuous area-composition vectors and separate unknown probability using task-aware context.",
    code: {
      image,
      sourceCommit
    },
    dataset: {
      id: inventory.datasetId,
      hash: inventory.datasetHash,
      role: "development"
    },
    matrix: {
      treatments: ["sol_reference", ...candidateTreatments].map(treatment),
      seeds: [181081]
    },
    tasks: tasks.map((task) => ({
      id: task.id,
      inputArtifact: task.pathname,
      metadata: task.metadata
    })),
    schedule: {
      type: "paired_interleave",
      maximumHostedCallsInFlight: 2,
      maximumSandboxes: 1
    },
    selection: {
      primaryMetric: "composition_mean_all_area_absolute_error",
      secondaryMetrics: [
        "composition_cosine_similarity",
        "composition_active_area_f1",
        "composition_unknown_absolute_error",
        "composition_contract_validity"
      ],
      maximumPromotedTreatments: 1
    },
    budget: {
      providerMaximumUsd,
      vercelMaximumUsd: suffix === "canary-10" ? 0.25 : 1
    },
    dataAccess: {
      lockedTest: false
    }
  };
}

const manifests = [
  {
    name: "canary",
    manifest: manifestFor({
      suffix: "canary-10",
      taskIds: inventory.canaryTaskIds,
      providerMaximumUsd: 1
    })
  },
  {
    name: "development",
    manifest: manifestFor({
      suffix: "development-100",
      taskIds: inventory.tasks.map((task) => task.id),
      providerMaximumUsd: 10
    })
  }
];

await mkdir(outputDirectory, { recursive: true });
const generated = [];
for (const { name, manifest } of manifests) {
  const plan = freezeExperimentPlan(manifest, "2026-08-18T00:00:00.000Z");
  const file = path.join(outputDirectory, `${name}.yaml`);
  await writeFile(
    file,
    [
      "# Prepared manifest only. Do not submit or approve without explicit user approval.",
      "# Development data only; no locked-test tasks are referenced.",
      stringify(manifest, { lineWidth: 0 })
    ].join("\n")
  );
  generated.push({
    name,
    file,
    tasks: manifest.tasks.length,
    jobs: plan.jobs.length,
    providerBudgetUsd: manifest.budget.providerMaximumUsd,
    vercelBudgetUsd: manifest.budget.vercelMaximumUsd
  });
}

console.log(
  JSON.stringify(
    {
      ok: true,
      image,
      sourceCommit,
      datasetId: inventory.datasetId,
      datasetHash: inventory.datasetHash,
      generated
    },
    null,
    2
  )
);
