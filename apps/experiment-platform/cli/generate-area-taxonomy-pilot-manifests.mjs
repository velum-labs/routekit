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
  ".routekit-experiment-assets/area-taxonomy-20260818/input-inventory.json"
);
const outputDirectory = path.join(
  repositoryRoot,
  "apps/experiment-platform/examples/area-taxonomy"
);
const inventory = JSON.parse(await readFile(inventoryFile, "utf8"));

function hostedTreatment(definition) {
  const reference =
    definition.evaluationRole === "composition_reference" ||
    definition.evaluationRole === "neutral_reference";
  return {
    id: definition.id,
    executor: "hosted-model",
    configuration: {
      model: definition.model,
      evaluationRole: definition.evaluationRole,
      ...(definition.comparisonGroup === undefined
        ? {}
        : { comparisonGroup: definition.comparisonGroup }),
      timeoutSeconds: 240
    },
    estimatedProviderCostUsd: reference ? 0.04 : 0.005,
    estimatedInfrastructureCostUsd: 0
  };
}

function hostedManifest({ suffix, taskIds }) {
  const selected = new Set(taskIds);
  const tasks = inventory.tasks.filter((task) => selected.has(task.id));
  if (tasks.length !== taskIds.length) throw new Error(`missing tasks for ${suffix}`);
  const treatments = inventory.treatmentDefinitions.map(hostedTreatment);
  const expectedProviderCostUsd =
    tasks.length *
    treatments.reduce((sum, treatment) => sum + treatment.estimatedProviderCostUsd, 0);
  return {
    schemaVersion: 1,
    experimentId: `area-taxonomy-backstage-${suffix}-v1`,
    objective:
      "Screen Backstage Area Card content, coarse versus official versus factorized taxonomies, overlap controls, and unknown-coverage policies with direct Luna against registry-specific Sol references.",
    code: { image, sourceCommit },
    dataset: {
      id: inventory.datasetId,
      hash: inventory.datasetHash,
      role: "development"
    },
    matrix: {
      treatments,
      seeds: [181081]
    },
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
        "composition_active_area_recall",
        "composition_false_positive_mass",
        "composition_unknown_absolute_error",
        "composition_contract_validity"
      ],
      maximumPromotedTreatments: 3
    },
    budget: {
      providerMaximumUsd: Number((expectedProviderCostUsd * 1.03).toFixed(2)),
      vercelMaximumUsd: 0.5
    },
    dataAccess: {
      lockedTest: false
    }
  };
}

const validationManifest = {
  schemaVersion: 1,
  experimentId: "area-taxonomy-backstage-sandbox-validation-v2",
  objective:
    "Validate all frozen Backstage taxonomy-pilot inputs in one optimized Vercel Sandbox job before any hosted-model call.",
  code: { image, sourceCommit },
  dataset: {
    id: `${inventory.datasetId}-validation`,
    hash: inventory.validationBundleDigest,
    role: "development"
  },
  matrix: {
    treatments: [
      {
        id: "validate_bundle",
        executor: "sandbox",
        configuration: {
          vcpus: 2,
          artifactMounts: [
            {
              artifact: inventory.validatorPathname,
              path: "validate-area-taxonomy-bundle.mjs"
            }
          ]
        },
        image,
        command: {
          executable: "node",
          args: ["/vercel/sandbox/routekit-job/mounts/validate-area-taxonomy-bundle.mjs"],
          timeoutSeconds: 300
        },
        estimatedProviderCostUsd: 0,
        estimatedInfrastructureCostUsd: 0.01
      }
    ],
    seeds: [181081]
  },
  tasks: [
    {
      id: "area-taxonomy-validation-bundle",
      inputArtifact: inventory.validationBundlePathname,
      metadata: {
        repositoryId: "backstage/backstage",
        taskCount: inventory.tasks.length,
        treatmentCount: inventory.treatmentDefinitions.length
      }
    }
  ],
  schedule: {
    type: "exhaustive",
    maximumHostedCallsInFlight: 1,
    maximumSandboxes: 1
  },
  selection: {
    primaryMetric: "sandbox_validation",
    secondaryMetrics: [],
    maximumPromotedTreatments: 1
  },
  budget: {
    providerMaximumUsd: 0,
    vercelMaximumUsd: 0.05
  },
  dataAccess: {
    lockedTest: false
  }
};

const manifests = [
  ["sandbox-validation", validationManifest],
  [
    "canary",
    hostedManifest({
      suffix: "canary-10",
      taskIds: inventory.canaryTaskIds
    })
  ],
  [
    "screening-remainder",
    hostedManifest({
      suffix: "screening-remainder-14",
      taskIds: inventory.remainderTaskIds
    })
  ]
];

await mkdir(outputDirectory, { recursive: true });
const generated = [];
for (const [name, manifest] of manifests) {
  const plan = freezeExperimentPlan(manifest, "2026-08-18T00:00:00.000Z");
  const file = path.join(outputDirectory, `${name}.yaml`);
  await writeFile(
    file,
    [
      "# Prepared manifest. Submission and paid execution require explicit authorization.",
      "# Development data only; no locked-test tasks are referenced.",
      stringify(manifest, { lineWidth: 0 })
    ].join("\n")
  );
  generated.push({
    name,
    file,
    tasks: manifest.tasks.length,
    treatments: manifest.matrix.treatments.length,
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
