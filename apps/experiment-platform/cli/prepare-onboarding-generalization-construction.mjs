#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../../..");
const sourceFile = path.join(
  root,
  ".routekit-experiment-assets/onboarding-generalization-20260819/source/source-inventory.json"
);
const outputRoot = path.join(
  root,
  ".routekit-experiment-assets/onboarding-generalization-20260819/construction"
);
const neutralDatasetId = "onboarding-generalization-neutral-120-v1";
const generationDatasetId = "onboarding-generalization-registries-3-v1";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const safeId = (value) => value.toLowerCase().replaceAll(/[^a-z0-9._-]+/g, "-");
const stringArray = (maxItems, maxLength) => ({
  type: "array",
  maxItems,
  items: { type: "string", minLength: 1, maxLength }
});

const neutralSchema = {
  type: "object",
  additionalProperties: false,
  required: ["responsibilities", "repository_scope", "insufficient_information_probability"],
  properties: {
    responsibilities: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "responsibility_id",
          "summary",
          "materiality",
          "affected_components",
          "evidence_refs",
          "confidence"
        ],
        properties: {
          responsibility_id: { type: "string", minLength: 1, maxLength: 32 },
          summary: { type: "string", minLength: 1, maxLength: 500 },
          materiality: { type: "number", minimum: 0, maximum: 1 },
          affected_components: stringArray(8, 200),
          evidence_refs: stringArray(8, 300),
          confidence: { type: "string", enum: ["low", "medium", "high"] }
        }
      }
    },
    repository_scope: {
      type: "string",
      enum: ["coding", "mixed", "non_coding", "insufficient_information"]
    },
    insufficient_information_probability: { type: "number", minimum: 0, maximum: 1 }
  }
};

const registrySchema = {
  type: "object",
  additionalProperties: false,
  required: ["areas"],
  properties: {
    areas: {
      type: "array",
      minItems: 8,
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "area_id",
          "name",
          "description",
          "inclusions",
          "exclusions",
          "confusable_area_ids",
          "path_anchors",
          "component_anchors",
          "symbol_anchors",
          "code_summaries",
          "boundary_examples"
        ],
        properties: {
          area_id: { type: "string", minLength: 1, maxLength: 80 },
          name: { type: "string", minLength: 1, maxLength: 120 },
          description: { type: "string", minLength: 1, maxLength: 700 },
          inclusions: stringArray(8, 300),
          exclusions: stringArray(12, 400),
          confusable_area_ids: stringArray(8, 80),
          path_anchors: stringArray(8, 240),
          component_anchors: stringArray(8, 200),
          symbol_anchors: stringArray(8, 160),
          code_summaries: stringArray(6, 500),
          boundary_examples: stringArray(10, 500)
        }
      }
    }
  }
};

const neutralSystem = [
  "Create a taxonomy-neutral reference for a held-out coding-task routing experiment.",
  "Identify concrete, independently implementable responsibilities required by the visible request.",
  "Candidate area names, changed files, and implementation labels are intentionally absent.",
  "Do not invent an Area Registry and do not use outside knowledge about the completed pull request.",
  "Dependencies, mentioned files, and incidental API calls are not responsibilities by themselves.",
  "Use materiality from 0.00 through 1.00 and only the supplied request and repository profile.",
  "Return exactly one strict JSON object and no prose."
].join("\n");

function request(system, user, schema, name) {
  return {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ],
    reasoning_effort: "high",
    max_completion_tokens: 8192,
    response_format: {
      type: "json_schema",
      json_schema: { name, strict: true, schema }
    }
  };
}

async function writeJson(file, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, bytes, { mode: 0o600 });
  return { bytes, digest: digest(bytes) };
}

async function freezeDataset(datasetId, role, tasks, safeguards, sourceHash) {
  const manifestFile = path.join(outputRoot, datasetId, "dataset-manifest.json");
  const manifestResult = await writeJson(manifestFile, {
    schemaVersion: 1,
    datasetId,
    generatedAt: "2026-08-19T00:00:00.000Z",
    role,
    sourceHash,
    counts: { tasks: tasks.length },
    safeguards,
    tasks: tasks.map(({ file: _file, ...task }) => task)
  });
  const inventory = {
    schemaVersion: 1,
    datasetId,
    datasetHash: manifestResult.digest,
    datasetManifestFile: manifestFile,
    datasetManifestPathname: `datasets/${datasetId}/sha256/${manifestResult.digest.slice(
      0,
      2
    )}/${manifestResult.digest}.json`,
    datasetManifestSize: manifestResult.bytes.length,
    tasks
  };
  const inventoryFile = path.join(outputRoot, datasetId, "input-inventory.json");
  await writeJson(inventoryFile, inventory);
  return { inventoryFile, inventory };
}

function taskAwarePrompt(profile, task) {
  return [
    "[TASK-AWARE CONVERSATION AND REPOSITORY PROFILE]",
    "[REPOSITORY PROFILE]",
    JSON.stringify(profile),
    "",
    "[CURRENT REQUEST]",
    task.title,
    "",
    task.body
  ].join("\n");
}

function historicalPrompt(profile, tasks) {
  return [
    "[TAXONOMY-NEUTRAL REPOSITORY PROFILE]",
    JSON.stringify(profile),
    "",
    "[OLDER HISTORICAL CODING TASKS]",
    ...tasks.flatMap((task, index) => [
      `Task ${index + 1}`,
      `Title: ${task.title}`,
      `Request: ${task.body.slice(0, 1600)}`,
      ""
    ])
  ].join("\n");
}

const sourceBytes = await readFile(sourceFile);
const sourceHash = digest(sourceBytes);
const source = JSON.parse(sourceBytes);
if (
  source.safeguards?.strictTemporalSplit !== true ||
  source.safeguards?.generationEvaluationTaskOverlap !== 0 ||
  source.safeguards?.heldoutTaskTextExcludedFromGeneration !== true
) {
  throw new Error("source inventory does not satisfy leakage safeguards");
}

const neutralTasks = [];
const generationTasks = [];

for (const repository of source.repositories) {
  const generationHashes = new Set(repository.generation.map((task) => task.taskTextHash));
  if (repository.evaluation.some((task) => generationHashes.has(task.taskTextHash))) {
    throw new Error(`${repository.repositoryId} has task text overlap`);
  }
  for (const task of repository.evaluation) {
    const input = {
      schemaVersion: 1,
      datasetId: neutralDatasetId,
      taskId: task.taskId,
      repositoryId: repository.repositoryId,
      requests: {
        neutral_sol: request(
          neutralSystem,
          taskAwarePrompt(repository.profile, task),
          neutralSchema,
          "routekit_heldout_neutral_responsibilities"
        )
      }
    };
    const file = path.join(outputRoot, neutralDatasetId, "inputs", `${safeId(task.taskId)}.json`);
    const result = await writeJson(file, input);
    neutralTasks.push({
      id: task.taskId,
      file,
      digest: result.digest,
      size: result.bytes.length,
      pathname: `inputs/${neutralDatasetId}/${safeId(task.taskId)}/sha256/${result.digest.slice(
        0,
        2
      )}/${result.digest}.json`,
      metadata: {
        repositoryId: repository.repositoryId,
        pullRequestNumber: task.pullRequestNumber,
        mergedAt: task.mergedAt,
        baseRefOid: task.baseRefOid,
        taskTextHash: task.taskTextHash,
        split: "heldout-evaluation"
      }
    });
  }

  const common = [
    "Propose exactly eight repository-specific runtime areas for classifying future coding tasks.",
    "Use only the supplied taxonomy-neutral repository profile and older historical tasks.",
    "The future held-out requests are unavailable and must not be guessed.",
    "Area IDs must be unique lowercase kebab-case strings.",
    "Do not mention model performance or routing recommendations.",
    "Return exactly one strict JSON object and no prose."
  ];
  const user = historicalPrompt(repository.profile, repository.generation);
  const input = {
    schemaVersion: 1,
    datasetId: generationDatasetId,
    taskId: `generate-${safeId(repository.repositoryId)}`,
    repositoryId: repository.repositoryId,
    requests: {
      auto_unconstrained_sol: request(
        [...common, "Choose whatever organizing principle you think is best."].join("\n"),
        user,
        registrySchema,
        "routekit_heldout_unconstrained_area_registry"
      ),
      auto_rules_sol: request(
        [
          ...common,
          "Use one flat semantic level organized primarily by distinct implementation responsibility.",
          "Allow task co-activation, but avoid semantic aliases, duplicate ownership, and vague catch-all areas.",
          "Do not place a parent and its child at the same runtime level.",
          "Write explicit negative boundaries and confusable-neighbor rules.",
          "Use representative paths, components, symbols, and short code summaries only when supported by the older tasks."
        ].join("\n"),
        user,
        registrySchema,
        "routekit_heldout_rules_area_registry"
      )
    }
  };
  const file = path.join(
    outputRoot,
    generationDatasetId,
    "inputs",
    `${safeId(repository.repositoryId)}.json`
  );
  const result = await writeJson(file, input);
  generationTasks.push({
    id: input.taskId,
    file,
    digest: result.digest,
    size: result.bytes.length,
    pathname: `inputs/${generationDatasetId}/${safeId(input.taskId)}/sha256/${result.digest.slice(
      0,
      2
    )}/${result.digest}.json`,
    metadata: {
      repositoryId: repository.repositoryId,
      historicalTasks: repository.generation.length,
      latestGenerationMergedAt: repository.temporalSplit.latestGenerationMergedAt,
      earliestEvaluationMergedAt: repository.temporalSplit.earliestEvaluationMergedAt,
      observedGapDays: repository.temporalSplit.observedGapDays
    }
  });
}

const safeguards = {
  strictTemporalSplit: true,
  generationEvaluationTaskOverlap: 0,
  heldoutTaskTextExcludedFromGeneration: true,
  changedFilesExcludedFromModelPrompts: true,
  priorBenchmarkTasksExcludedFromEvaluation: true,
  lockedTestIncluded: false,
  inferenceExecutedDuringPreparation: false
};
const [neutral, generation] = await Promise.all([
  freezeDataset(neutralDatasetId, "construction", neutralTasks, safeguards, sourceHash),
  freezeDataset(generationDatasetId, "construction", generationTasks, safeguards, sourceHash)
]);

console.log(
  JSON.stringify(
    {
      ok: true,
      sourceHash,
      neutral: {
        inventoryFile: neutral.inventoryFile,
        datasetHash: neutral.inventory.datasetHash,
        tasks: neutralTasks.length
      },
      generation: {
        inventoryFile: generation.inventoryFile,
        datasetHash: generation.inventory.datasetHash,
        tasks: generationTasks.length
      }
    },
    null,
    2
  )
);
