#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../../..");
const sourceFile = path.join(
  root,
  ".routekit-experiment-assets/composition-20260818/input-inventory.json"
);
const outputRoot = path.join(
  root,
  ".routekit-experiment-assets/onboarding-followups-20260819/construction"
);
const neutralDatasetId = "onboarding-neutral-responsibilities-100-v1";
const generationDatasetId = "onboarding-registry-generation-3-v1";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const safeId = (value) => value.toLowerCase().replaceAll(/[^a-z0-9._-]+/g, "-");

async function writeJson(file, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, bytes, { mode: 0o600 });
  return { bytes, digest: digest(bytes) };
}

function taskTail(user) {
  const marker = "\n\n[TASK-AWARE CONVERSATION AND REPOSITORY PROFILE]";
  const index = user.indexOf(marker);
  if (index < 0) throw new Error("source prompt has no task-aware context");
  return user
    .slice(index + 2)
    .replace(/^components:.*$/mu, "components: (omitted to avoid taxonomy leakage)");
}

function section(text, name) {
  const marker = `[${name}]`;
  const start = text.indexOf(marker);
  if (start < 0) return "";
  const body = start + marker.length;
  const end = text.indexOf("\n[", body);
  return text.slice(body, end < 0 ? text.length : end).trim();
}

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
  "Create a taxonomy-neutral reference for a coding-task routing experiment.",
  "Identify concrete, independently implementable responsibilities required by the visible task.",
  "Candidate area names are intentionally absent; do not invent an Area Registry.",
  "Dependencies, mentioned files, and incidental API calls are not responsibilities by themselves.",
  "Use materiality from 0.00 through 1.00 and only the supplied task-aware context and evidence.",
  "Return exactly one strict JSON object and no prose."
].join("\n");

async function freezeDataset(datasetId, role, tasks, safeguards) {
  const manifestFile = path.join(outputRoot, datasetId, "dataset-manifest.json");
  const manifestResult = await writeJson(manifestFile, {
    schemaVersion: 1,
    datasetId,
    generatedAt: "2026-08-19T00:00:00.000Z",
    role,
    counts: { tasks: tasks.length },
    safeguards,
    tasks: tasks.map(({ file: _file, ...task }) => task)
  });
  const manifestPathname = `datasets/${datasetId}/sha256/${manifestResult.digest.slice(
    0,
    2
  )}/${manifestResult.digest}.json`;
  const inventory = {
    schemaVersion: 1,
    datasetId,
    datasetHash: manifestResult.digest,
    datasetManifestFile: manifestFile,
    datasetManifestPathname: manifestPathname,
    datasetManifestSize: manifestResult.bytes.length,
    tasks
  };
  const inventoryFile = path.join(outputRoot, datasetId, "input-inventory.json");
  await writeJson(inventoryFile, inventory);
  return { inventoryFile, inventory };
}

const source = JSON.parse(await readFile(sourceFile, "utf8"));
const neutralTasks = [];
const examplesByRepository = new Map();

for (const task of source.tasks) {
  const input = JSON.parse(await readFile(task.file, "utf8"));
  const tail = taskTail(input.requests.sol_reference.messages[1].content);
  const frozen = {
    schemaVersion: 1,
    datasetId: neutralDatasetId,
    taskId: task.id,
    repositoryId: task.metadata.repositoryId,
    repositorySnapshot: input.repositorySnapshot,
    requests: {
      neutral_sol: request(
        neutralSystem,
        tail,
        neutralSchema,
        "routekit_neutral_responsibilities_v2"
      )
    }
  };
  const file = path.join(outputRoot, neutralDatasetId, "inputs", `${safeId(task.id)}.json`);
  const result = await writeJson(file, frozen);
  neutralTasks.push({
    id: task.id,
    file,
    digest: result.digest,
    size: result.bytes.length,
    pathname: `inputs/${neutralDatasetId}/${safeId(task.id)}/sha256/${result.digest.slice(
      0,
      2
    )}/${result.digest}.json`,
    metadata: task.metadata
  });
  if (task.metadata.cohort !== "synthetic_composite") {
    const examples = examplesByRepository.get(task.metadata.repositoryId) ?? [];
    examples.push({
      profile: section(tail, "REPOSITORY PROFILE"),
      request: section(tail, "CURRENT REQUEST")
    });
    examplesByRepository.set(task.metadata.repositoryId, examples);
  }
}

const generationTasks = [];
for (const [repositoryId, examples] of [...examplesByRepository.entries()].sort()) {
  const user = [
    "[TAXONOMY-NEUTRAL REPOSITORY PROFILE]",
    examples[0]?.profile ?? `repository_id: ${repositoryId}`,
    "",
    "[REPRESENTATIVE HISTORICAL CODING TASKS]",
    examples
      .slice(0, 16)
      .map((example, index) => `Task ${index + 1}: ${example.request}`)
      .join("\n\n")
  ].join("\n");
  const common = [
    "Propose exactly eight repository-specific runtime areas for classifying future coding tasks.",
    "Use only the supplied taxonomy-neutral repository profile and historical tasks.",
    "Area IDs must be unique lowercase kebab-case strings.",
    "Do not mention model performance or routing recommendations.",
    "Return exactly one strict JSON object and no prose."
  ];
  const frozen = {
    schemaVersion: 1,
    datasetId: generationDatasetId,
    taskId: `generate-${safeId(repositoryId)}`,
    repositoryId,
    requests: {
      auto_unconstrained_sol: request(
        [...common, "Choose whatever organizing principle you think is best."].join("\n"),
        user,
        registrySchema,
        "routekit_unconstrained_area_registry"
      ),
      auto_rules_sol: request(
        [
          ...common,
          "Use one flat semantic level organized primarily by distinct implementation responsibility.",
          "Allow task co-activation, but avoid semantic aliases, duplicate ownership, and vague catch-all areas.",
          "Do not place a parent and its child at the same runtime level.",
          "Write explicit negative boundaries and confusable-neighbor rules.",
          "Use representative paths, components, symbols, and short code summaries as evidence anchors."
        ].join("\n"),
        user,
        registrySchema,
        "routekit_rules_area_registry"
      )
    }
  };
  const file = path.join(outputRoot, generationDatasetId, "inputs", `${safeId(repositoryId)}.json`);
  const result = await writeJson(file, frozen);
  generationTasks.push({
    id: frozen.taskId,
    file,
    digest: result.digest,
    size: result.bytes.length,
    pathname: `inputs/${generationDatasetId}/${safeId(frozen.taskId)}/sha256/${result.digest.slice(
      0,
      2
    )}/${result.digest}.json`,
    metadata: { repositoryId, historicalTasks: examples.length }
  });
}

const neutral = await freezeDataset(neutralDatasetId, "construction", neutralTasks, {
  taskAwareContextOnly: true,
  candidateAreaNamesExcluded: true,
  lockedTestIncluded: false,
  inferenceExecutedDuringPreparation: false
});
const generation = await freezeDataset(generationDatasetId, "construction", generationTasks, {
  humanRegistryExcluded: true,
  taxonomyNeutralProfile: true,
  historicalTasksOnly: true,
  lockedTestIncluded: false,
  inferenceExecutedDuringPreparation: false
});

console.log(
  JSON.stringify(
    {
      ok: true,
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
