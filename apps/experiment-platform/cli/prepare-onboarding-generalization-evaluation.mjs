#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  readJsonArtifact,
  VercelBlobArtifactStore
} from "@velum-labs/routekit-eval-store/platform";

const root = path.resolve(import.meta.dirname, "../../..");
const sourceFile = path.join(
  root,
  ".routekit-experiment-assets/onboarding-generalization-20260819/source/source-inventory.json"
);
const compositionInventoryFile = path.join(
  root,
  ".routekit-experiment-assets/composition-20260818/input-inventory.json"
);
const outputRoot = path.join(
  root,
  ".routekit-experiment-assets/onboarding-generalization-20260819/evaluation"
);
const datasetId = "onboarding-generalization-heldout-120-v1";
const baseUrl = (
  process.env.EXPERIMENT_PLATFORM_URL ?? "https://routekit-experiments-development.vercel.app"
).replace(/\/$/u, "");
const token = process.env.EXPERIMENT_PLATFORM_API_TOKEN;
if (!token) throw new Error("EXPERIMENT_PLATFORM_API_TOKEN is required");
if (!process.env.BLOB_READ_WRITE_TOKEN && !process.env.VERCEL_OIDC_TOKEN) {
  throw new Error("Vercel Blob credentials are required");
}

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const safeId = (value) => value.toLowerCase().replaceAll(/[^a-z0-9._-]+/g, "-");
const unique = (values) => [...new Set((values ?? []).filter(Boolean))];

async function writeJson(file, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, bytes, { mode: 0o600 });
  return { bytes, digest: digest(bytes) };
}

function responseObject(payload) {
  const response = payload?.result?.response ?? payload?.response ?? payload;
  const content = response?.choices?.[0]?.message?.content;
  if (typeof content === "string") return JSON.parse(content);
  if (Array.isArray(content)) {
    return JSON.parse(content.map((part) => part?.text ?? "").join(""));
  }
  throw new Error("hosted response has no JSON message content");
}

async function completedExperiment(experimentId) {
  const response = await fetch(`${baseUrl}/api/experiments/${experimentId}`, {
    headers: { authorization: `Bearer ${token}` }
  });
  if (!response.ok) throw new Error(`failed to read ${experimentId}: ${response.status}`);
  const snapshot = await response.json();
  const failed = snapshot.jobs.filter((job) => job.status !== "succeeded");
  if (failed.length > 0) throw new Error(`${experimentId} has ${failed.length} unsuccessful jobs`);
  const usableBudgetFailure =
    snapshot.experiment?.status === "failed" &&
    snapshot.experiment?.error === "actual provider cost exceeded its budget";
  if (snapshot.experiment?.status !== "completed" && !usableBudgetFailure) {
    throw new Error(`${experimentId} is ${snapshot.experiment?.status}, not completed`);
  }
  return snapshot;
}

async function outputsByTask(snapshot, ignoreInvalid = false) {
  const store = new VercelBlobArtifactStore();
  const entries = (
    await Promise.all(
      snapshot.jobs.map(async (record) => {
        try {
          return [
            `${record.job.taskId}:${record.job.treatmentId}`,
            responseObject(await readJsonArtifact(store, record.outputArtifact))
          ];
        } catch (error) {
          if (!ignoreInvalid) throw error;
          return undefined;
        }
      })
    )
  ).filter(Boolean);
  return new Map(entries);
}

const [neutralSnapshot, neutralRetrySnapshot, generationSnapshot] = await Promise.all([
  completedExperiment("onboarding-generalization-neutral-120-v1"),
  completedExperiment("onboarding-generalization-neutral-retry-1-v1"),
  completedExperiment("onboarding-generalization-registries-3-v2")
]);
const [neutralOutputs, neutralRetryOutputs, generationOutputs] = await Promise.all([
  outputsByTask(neutralSnapshot, true),
  outputsByTask(neutralRetrySnapshot),
  outputsByTask(generationSnapshot)
]);

function neutralOutput(taskId) {
  return (
    neutralOutputs.get(`${taskId}:neutral_sol`) ??
    neutralRetryOutputs.get(`${taskId}:neutral_sol_retry`)
  );
}

function normalizeCards(cards) {
  const normalized = cards.map((card, index) => ({
    area_id: safeId(card.area_id || card.name || `area-${index + 1}`),
    name: card.name || card.area_id || `Area ${index + 1}`,
    description: card.description || card.activation_rule || "Repository responsibility.",
    inclusions: unique(card.inclusions),
    exclusions: unique(card.exclusions),
    confusable_area_ids: unique(card.confusable_area_ids),
    path_anchors: unique(card.path_anchors),
    component_anchors: unique(card.component_anchors),
    symbol_anchors: unique(card.symbol_anchors),
    code_summaries: unique(card.code_summaries),
    code_snippets: unique(card.code_snippets),
    boundary_examples: unique(card.boundary_examples)
  }));
  const used = new Set();
  for (const card of normalized) {
    let id = card.area_id;
    let suffix = 2;
    while (used.has(id)) id = `${card.area_id}-${suffix++}`;
    card.area_id = id;
    used.add(id);
  }
  for (const card of normalized) {
    card.confusable_area_ids = card.confusable_area_ids.filter(
      (id) => used.has(id) && id !== card.area_id
    );
  }
  return normalized;
}

function parseHumanRegistry(user) {
  const prefix = "[FROZEN AREA REGISTRY]\n";
  const marker = "\n\n[TASK-AWARE CONVERSATION AND REPOSITORY PROFILE]";
  const end = user.indexOf(marker);
  if (!user.startsWith(prefix) || end < 0) throw new Error("invalid composition source prompt");
  return normalizeCards(JSON.parse(user.slice(prefix.length, end)).areas);
}

function compositionSchema(cards) {
  const ids = cards.map((card) => card.area_id);
  return {
    type: "object",
    additionalProperties: false,
    required: ["area_composition_scores", "unknown_probability"],
    properties: {
      area_composition_scores: {
        type: "object",
        additionalProperties: false,
        required: ids,
        properties: Object.fromEntries(
          ids.map((id) => [id, { type: "number", minimum: 0, maximum: 1 }])
        )
      },
      unknown_probability: { type: "number", minimum: 0, maximum: 1 }
    }
  };
}

function request(system, user, cards, name) {
  return {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ],
    reasoning_effort: "high",
    max_completion_tokens: 8192,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: name.replaceAll(/[^a-zA-Z0-9_-]/gu, "_").slice(0, 64),
        strict: true,
        schema: compositionSchema(cards)
      }
    }
  };
}

const directSystem = [
  "You are a runtime classifier for coding tasks.",
  "Your output will be used as an additive task-composition vector by a separate routing policy.",
  "",
  "Return exactly one strict JSON object and no prose outside it.",
  "The object must contain area_composition_scores with every registered area exactly once, plus unknown_probability.",
  "Known-area scores are independent. They do not need to sum to one. Do not normalize or softmax them.",
  "unknown_probability is separate. It is the probability that the registered areas fail to cover at least one material responsibility required by the task.",
  "Do not multiply or otherwise reduce known-area scores when unknown_probability is high.",
  "A dependency, mentioned path, shared type, or incidental API call does not by itself make an area materially responsible.",
  "Use only the supplied task-aware context and Area Registry.",
  "Do not expose hidden chain-of-thought.",
  "",
  "For each registered area, score the continuous strength of implementation responsibility attributable to that area. These are composition intensities, not mutually exclusive class probabilities.",
  "",
  "Use this continuous responsibility rubric for every area:",
  "- 0.00: no material implementation responsibility",
  "- 0.25: minor supporting responsibility",
  "- 0.50: substantial secondary responsibility",
  "- 0.75: major responsibility",
  "- 1.00: dominant or core responsibility",
  "Intermediate values are allowed."
].join("\n");

const mappingSystem = [
  "Map a frozen taxonomy-neutral responsibility decomposition into the supplied Area Registry.",
  "Do not reinterpret the task to fit the registry and do not discard an uncovered responsibility.",
  "Known-area scores independently estimate how materially each area must change.",
  "unknown_probability separately estimates material responsibility not represented by any area.",
  "Known-area scores do not need to sum to one and unknown must not renormalize them.",
  "Return exactly one strict JSON object and no prose."
].join("\n");

function taskTail(profile, task) {
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

function directRequest(tail, cards, treatmentId) {
  return request(
    directSystem,
    ["[FROZEN AREA REGISTRY]", JSON.stringify({ areas: cards }), "", tail].join("\n"),
    cards,
    treatmentId
  );
}

function mappingRequest(tail, cards, neutral, treatmentId) {
  return request(
    mappingSystem,
    [
      "[FROZEN AREA REGISTRY]",
      JSON.stringify({ areas: cards }),
      "",
      "[FROZEN TAXONOMY-NEUTRAL RESPONSIBILITIES]",
      JSON.stringify(neutral),
      "",
      tail
    ].join("\n"),
    cards,
    treatmentId
  );
}

const generatedRegistries = new Map();
for (const task of generationSnapshot.experiment.manifest.tasks) {
  generatedRegistries.set(task.metadata.repositoryId, {
    auto_rules: normalizeCards(generationOutputs.get(`${task.id}:auto_rules_sol`).areas),
    auto_unconstrained: normalizeCards(
      generationOutputs.get(`${task.id}:auto_unconstrained_sol`).areas
    )
  });
}

const compositionInventory = JSON.parse(await readFile(compositionInventoryFile, "utf8"));
const humanRegistries = new Map();
for (const task of compositionInventory.tasks) {
  const repositoryId = task.metadata?.repositoryId;
  if (humanRegistries.has(repositoryId)) continue;
  const input = JSON.parse(await readFile(task.file, "utf8"));
  humanRegistries.set(
    repositoryId,
    parseHumanRegistry(input.requests.sol_reference.messages[1].content)
  );
}

const sourceBytes = await readFile(sourceFile);
const sourceHash = digest(sourceBytes);
const source = JSON.parse(sourceBytes);
const groups = ["human", "auto_rules", "auto_unconstrained"];
const treatmentDefinitions = groups.flatMap((group) => [
  {
    id: `${group}__sol`,
    model: "openai/gpt-5.6-sol",
    evaluationRole: "composition_reference",
    comparisonGroup: group
  },
  {
    id: `${group}__luna`,
    model: "openai/gpt-5.6-luna",
    evaluationRole: "composition_candidate",
    comparisonGroup: group
  }
]);
const frozenTasks = [];
const registryAudit = [];

for (const repository of source.repositories) {
  const generated = generatedRegistries.get(repository.repositoryId);
  const human = humanRegistries.get(repository.repositoryId);
  if (!generated || !human) throw new Error(`missing registry for ${repository.repositoryId}`);
  const registries = { human, ...generated };
  registryAudit.push({
    repositoryId: repository.repositoryId,
    temporalSplit: repository.temporalSplit,
    registries
  });
  for (const task of repository.evaluation) {
    const neutral = neutralOutput(task.taskId);
    if (!neutral) throw new Error(`missing neutral output for ${task.taskId}`);
    const tail = taskTail(repository.profile, task);
    const requests = {};
    for (const group of groups) {
      requests[`${group}__sol`] = mappingRequest(tail, registries[group], neutral, `${group}__sol`);
      requests[`${group}__luna`] = directRequest(tail, registries[group], `${group}__luna`);
    }
    const input = {
      schemaVersion: 1,
      datasetId,
      taskId: task.taskId,
      repositoryId: repository.repositoryId,
      requests
    };
    const file = path.join(outputRoot, datasetId, "inputs", `${safeId(task.taskId)}.json`);
    const result = await writeJson(file, input);
    frozenTasks.push({
      id: task.taskId,
      file,
      digest: result.digest,
      size: result.bytes.length,
      pathname: `inputs/${datasetId}/${safeId(task.taskId)}/sha256/${result.digest.slice(
        0,
        2
      )}/${result.digest}.json`,
      metadata: {
        repositoryId: repository.repositoryId,
        pullRequestNumber: task.pullRequestNumber,
        mergedAt: task.mergedAt,
        baseRefOid: task.baseRefOid,
        taskTextHash: task.taskTextHash,
        split: "heldout-evaluation",
        temporalEmbargoDays: repository.temporalSplit.temporalEmbargoDays,
        latestGenerationMergedAt: repository.temporalSplit.latestGenerationMergedAt
      }
    });
  }
}

const safeguards = {
  strictTemporalSplit: true,
  temporalEmbargoDays: 14,
  generationEvaluationTaskOverlap: 0,
  heldoutTaskTextExcludedFromGeneration: true,
  changedFilesExcludedFromModelPrompts: true,
  neutralDecompositionFrozenBeforeRegistryMapping: true,
  lockedTestIncluded: false
};
const manifestFile = path.join(outputRoot, datasetId, "dataset-manifest.json");
const manifestResult = await writeJson(manifestFile, {
  schemaVersion: 1,
  datasetId,
  generatedAt: "2026-08-19T00:00:00.000Z",
  role: "development",
  sourceHash,
  counts: {
    repositories: source.repositories.length,
    tasks: frozenTasks.length,
    treatments: treatmentDefinitions.length
  },
  treatmentDefinitions,
  safeguards,
  tasks: frozenTasks.map(({ file: _file, ...task }) => task)
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
  treatmentDefinitions,
  tasks: frozenTasks
};
const inventoryFile = path.join(outputRoot, datasetId, "input-inventory.json");
await writeJson(inventoryFile, inventory);
const registryAuditFile = path.join(outputRoot, "registry-audit.json");
await writeJson(registryAuditFile, {
  schemaVersion: 1,
  sourceHash,
  constructionExperiments: [
    neutralSnapshot.experiment.experimentId,
    neutralRetrySnapshot.experiment.experimentId,
    generationSnapshot.experiment.experimentId
  ],
  repositories: registryAudit
});

console.log(
  JSON.stringify(
    {
      ok: true,
      inventoryFile,
      registryAuditFile,
      datasetHash: inventory.datasetHash,
      repositories: source.repositories.length,
      tasks: frozenTasks.length,
      treatments: treatmentDefinitions.length,
      jobs: frozenTasks.length * treatmentDefinitions.length,
      safeguards
    },
    null,
    2
  )
);
