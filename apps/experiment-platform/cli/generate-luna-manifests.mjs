#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { freezeExperimentPlan } from "@velum-labs/routekit-eval-core/experiment";
import { stringify } from "yaml";

const argv = process.argv.slice(2);

function requiredArgument(name) {
  const index = argv.indexOf(name);
  const value = index === -1 ? undefined : argv[index + 1];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const image = requiredArgument("--image");
const sourceCommit = requiredArgument("--source-commit");
const inputInventoryFile = path.resolve(
  repositoryRoot,
  ".routekit-experiment-assets/coding-router-20260817/inputs/input-inventory.json"
);
const artifactInventoryFile = path.resolve(
  repositoryRoot,
  ".routekit-experiment-assets/coding-router-20260817/artifact-inventory.json"
);
const outputDirectory = path.resolve(
  repositoryRoot,
  "apps/experiment-platform/examples/coding-router"
);

const inputInventory = JSON.parse(await readFile(inputInventoryFile, "utf8"));
const artifactInventory = JSON.parse(await readFile(artifactInventoryFile, "utf8"));
const datasetArtifacts = new Map(
  artifactInventory.artifacts
    .filter((artifact) => artifact.kind === "datasets")
    .map((artifact) => [artifact.id, artifact])
);

function manifestFor(dataset) {
  const artifact = datasetArtifacts.get(dataset.id);
  if (!artifact) throw new Error(`Missing frozen dataset artifact for ${dataset.id}`);
  return {
    schemaVersion: 1,
    experimentId: `luna-performance-${dataset.role}-v1`,
    objective:
      "Compare direct, evidence-first, and independent per-area Luna classification using task-aware context, enriched Area Cards, and fixed hybrid-rerank evidence.",
    code: {
      image,
      sourceCommit
    },
    dataset: {
      id: dataset.id,
      hash: artifact.digest,
      role: dataset.role
    },
    matrix: {
      treatments: ["direct", "evidence_first", "independent_per_area"].map((id) => ({
        id,
        executor: "hosted-model",
        configuration: {
          model: "openai/gpt-5.6-luna",
          timeoutSeconds: 240
        },
        estimatedProviderCostUsd: 0.005,
        estimatedInfrastructureCostUsd: 0
      })),
      seeds: [181081]
    },
    tasks: dataset.tasks.map((task) => ({
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
      primaryMetric: "area_brier",
      secondaryMetrics: [
        "all_gold_at_3",
        "exact_set_at_0_5",
        "area_hit_at_1",
        "scope_brier"
      ],
      maximumPromotedTreatments: 1
    },
    budget: {
      providerMaximumUsd: 0.5,
      vercelMaximumUsd: 0.5
    },
    dataAccess: {
      lockedTest: false
    }
  };
}

await mkdir(outputDirectory, { recursive: true });
const generated = [];
for (const dataset of inputInventory.datasets) {
  const manifest = manifestFor(dataset);
  freezeExperimentPlan(manifest, "2026-08-17T00:00:00.000Z");
  const file = path.join(outputDirectory, `${dataset.role}.yaml`);
  await writeFile(
    file,
    [
      "# Prepared manifest only. Do not submit without the required approvals.",
      "# No locked-test data is referenced.",
      stringify(manifest, { lineWidth: 0 })
    ].join("\n")
  );
  generated.push({
    role: dataset.role,
    file,
    tasks: manifest.tasks.length,
    jobs: manifest.tasks.length * manifest.matrix.treatments.length * manifest.matrix.seeds.length
  });
}

console.log(JSON.stringify({ ok: true, image, sourceCommit, generated }, null, 2));
