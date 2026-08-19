#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  readJsonArtifact,
  VercelBlobArtifactStore
} from "@velum-labs/routekit-eval-store/platform";

import {
  assetRoot,
  compositionRequest,
  digest,
  freezeDataset,
  normalizeCards,
  responseObject,
  root,
  safeId,
  taskAwareTail,
  writeJson
} from "./onboarding-optimization-common.mjs";

const naturalDatasetId = "onboarding-optimization-natural-hard-48x3-v1";
const realDatasetId = "onboarding-optimization-real-auto-45-v1";
const assistanceDatasetId = "onboarding-optimization-routekit-assistance-validation-3x2-v1";
const outputDirectory = path.join(assetRoot, "cohorts");
const naturalHardFile =
  "/home/benjamin/repos/ori-runtime-lab/experiments/coding-router-lab/data/private/natural-hard-cohort-v2-48/episodes.jsonl";
const realCohortFile =
  "/home/benjamin/repos/ori-runtime-lab/experiments/coding-router-lab/data/private/real-conversational-coding-v1/episodes.jsonl";
const routekitHumanCardsFile =
  "/home/benjamin/repos/ori-runtime-lab/experiments/coding-router-lab/data/private/accuracy-first/benjamin-routekit-v1/area-cards.jsonl";
const validationAuditFile = path.join(assetRoot, "validation/validation-registry-audit.json");
const selectionFile = path.join(assetRoot, "repair/validation-selection.json");
const constructionAuditFile = path.join(assetRoot, "construction/construction-audit.json");
const publicProfiles = {
  "grafana/grafana":
    "/home/benjamin/repos/ori-runtime-lab/experiments/coding-router-lab/data/private/public-issue-diverse-v1/grafana/repository-profile.json",
  "kubernetes/kubernetes":
    "/home/benjamin/repos/ori-runtime-lab/experiments/coding-router-lab/data/private/public-issue-diverse-v1/kubernetes/repository-profile.json"
};
const baseUrl = (
  process.env.EXPERIMENT_PLATFORM_URL ?? "https://routekit-experiments-development.vercel.app"
).replace(/\/$/u, "");
const token = process.env.EXPERIMENT_PLATFORM_API_TOKEN;
if (!token) throw new Error("EXPERIMENT_PLATFORM_API_TOKEN is required");
if (!process.env.BLOB_READ_WRITE_TOKEN && !process.env.VERCEL_OIDC_TOKEN) {
  throw new Error("Vercel Blob credentials are required");
}

function readJsonl(file) {
  return readFile(file, "utf8").then((contents) =>
    contents
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  );
}

async function completedExperiment(experimentId) {
  const response = await fetch(`${baseUrl}/api/experiments/${experimentId}`, {
    headers: { authorization: `Bearer ${token}` }
  });
  if (!response.ok) throw new Error(`failed to read ${experimentId}: ${response.status}`);
  const snapshot = await response.json();
  if (snapshot.experiment?.status !== "completed") {
    throw new Error(`${experimentId} is ${snapshot.experiment?.status}, not completed`);
  }
  if (snapshot.jobs.some((record) => record.status !== "succeeded")) {
    throw new Error(`${experimentId} has unsuccessful jobs`);
  }
  return snapshot;
}

async function outputMap(snapshot) {
  const store = new VercelBlobArtifactStore();
  return new Map(
    await Promise.all(
      snapshot.jobs.map(async (record) => [
        `${record.job.taskId}:${record.job.treatmentId}`,
        responseObject(await readJsonArtifact(store, record.outputArtifact))
      ])
    )
  );
}

function convertHumanCard(card) {
  return {
    area_id: card.areaId,
    name: card.name,
    description: card.description,
    inclusions: card.inclusions ?? [],
    exclusions: card.exclusions ?? [],
    confusable_area_ids: card.confusableAreaIds ?? [],
    path_anchors: card.pathAnchors ?? [],
    component_anchors: card.componentAnchors ?? [],
    symbol_anchors: card.symbolAnchors ?? [],
    code_summaries: card.codeSummaries ?? [],
    code_snippets: card.codeSnippets ?? [],
    boundary_examples: card.boundaryExamples ?? []
  };
}

function privateProfile(repositoryId, audit) {
  const entry = audit.private.find((candidate) => candidate.repositoryId === repositoryId);
  if (!entry) throw new Error(`missing construction audit for ${repositoryId}`);
  return {
    repositoryId,
    purpose: entry.structure.readmeExcerpt?.slice(0, 1500) ?? null,
    topDirectories: entry.structure.topDirectories,
    topExtensions: entry.structure.topExtensions,
    manifestPaths: entry.structure.manifestPaths.slice(0, 40)
  };
}

async function freezeInputs({
  datasetId,
  tasks,
  sourceHash,
  comparisonGroups,
  treatmentDefinitions,
  safeguards
}) {
  return freezeDataset({
    directory: outputDirectory,
    datasetId,
    role: "development",
    tasks,
    sourceHash,
    safeguards,
    metadata: { comparisonGroups, treatmentDefinitions }
  });
}

const [
  naturalHard,
  realCohort,
  routekitHumanCards,
  validationAuditBytes,
  selectionBytes,
  constructionAuditBytes,
  repairSnapshot,
  privateConstructionSnapshot,
  neutralSnapshot
] = await Promise.all([
  readJsonl(naturalHardFile),
  readJsonl(realCohortFile),
  readJsonl(routekitHumanCardsFile),
  readFile(validationAuditFile),
  readFile(selectionFile),
  readFile(constructionAuditFile),
  completedExperiment("onboarding-optimization-repair-3-v1"),
  completedExperiment("onboarding-optimization-private-registries-4-v1"),
  completedExperiment("onboarding-optimization-neutral-93-v1")
]);
const [repairOutputs, privateOutputs, neutralOutputs] = await Promise.all([
  outputMap(repairSnapshot),
  outputMap(privateConstructionSnapshot),
  outputMap(neutralSnapshot)
]);
const validationAudit = JSON.parse(validationAuditBytes);
const selection = JSON.parse(selectionBytes);
const constructionAudit = JSON.parse(constructionAuditBytes);
const profiles = new Map();
for (const [repositoryId, file] of Object.entries(publicProfiles)) {
  profiles.set(repositoryId, JSON.parse(await readFile(file, "utf8")));
}
for (const repositoryId of new Set(realCohort.map((episode) => episode.repositoryId))) {
  profiles.set(repositoryId, privateProfile(repositoryId, constructionAudit));
}

function neutralOutput(cohort, episodeId) {
  const taskId = `${cohort}-${safeId(episodeId)}`;
  const value = neutralOutputs.get(`${taskId}:neutral_sol`);
  if (!value) throw new Error(`missing neutral output for ${taskId}`);
  return value;
}

const naturalGroups = ["human", "selected", "repaired"];
const naturalDefinitions = naturalGroups.flatMap((comparisonGroup) => [
  {
    id: `${comparisonGroup}__sol`,
    model: "openai/gpt-5.6-sol",
    evaluationRole: "composition_reference",
    comparisonGroup
  },
  {
    id: `${comparisonGroup}__luna`,
    model: "openai/gpt-5.6-luna",
    evaluationRole: "composition_candidate",
    comparisonGroup
  }
]);
const naturalTasks = [];
const naturalRegistries = {};
for (const repositoryId of new Set(naturalHard.map((episode) => episode.repositoryId))) {
  const audit = validationAudit.repositories.find((entry) => entry.repositoryId === repositoryId);
  const selected = selection.repositories.find((entry) => entry.repositoryId === repositoryId);
  const repaired = repairOutputs.get(`repair-${repositoryId.replace("/", "-")}:repair_sol`);
  if (!audit || !selected || !repaired?.areas) {
    throw new Error(`missing natural-hard registry inputs for ${repositoryId}`);
  }
  naturalRegistries[repositoryId] = {
    human: normalizeCards(audit.registries.human),
    selected: normalizeCards(selected.selectedRegistry),
    repaired: normalizeCards(repaired.areas)
  };
}
for (const episode of naturalHard) {
  const tail = taskAwareTail(profiles.get(episode.repositoryId), episode);
  const neutral = neutralOutput("natural-hard", episode.id);
  const requests = {};
  for (const comparisonGroup of naturalGroups) {
    const cards = naturalRegistries[episode.repositoryId][comparisonGroup];
    requests[`${comparisonGroup}__sol`] = compositionRequest({
      cards,
      tail,
      neutral,
      name: `${comparisonGroup}_natural_hard_reference`
    });
    requests[`${comparisonGroup}__luna`] = compositionRequest({
      cards,
      tail,
      name: `${comparisonGroup}_natural_hard_candidate`,
      direct: true
    });
  }
  const taskId = `natural-hard-${safeId(episode.id)}`;
  const input = {
    schemaVersion: 1,
    datasetId: naturalDatasetId,
    taskId,
    sourceEpisodeId: episode.id,
    repositoryId: episode.repositoryId,
    requests
  };
  const file = path.join(outputDirectory, naturalDatasetId, "inputs", `${taskId}.json`);
  const result = await writeJson(file, input);
  naturalTasks.push({
    id: taskId,
    file,
    digest: result.digest,
    size: result.bytes.length,
    pathname: `inputs/${naturalDatasetId}/${taskId}/sha256/${result.digest.slice(0, 2)}/${
      result.digest
    }.json`,
    metadata: {
      sourceEpisodeId: episode.id,
      repositoryId: episode.repositoryId,
      cohort: "natural-hard",
      split: episode.split
    }
  });
}

const privateRegistries = new Map();
for (const repositoryId of new Set(realCohort.map((episode) => episode.repositoryId))) {
  const taskId = `generate-${safeId(repositoryId)}`;
  const output = privateOutputs.get(`${taskId}:real_hybrid_registry`);
  if (!output?.areas) throw new Error(`missing private registry for ${repositoryId}`);
  privateRegistries.set(repositoryId, normalizeCards(output.areas));
}
const realGroups = ["auto"];
const realDefinitions = [
  {
    id: "auto__sol",
    model: "openai/gpt-5.6-sol",
    evaluationRole: "composition_reference",
    comparisonGroup: "auto"
  },
  {
    id: "auto__claude",
    model: "anthropic/claude-sonnet-5",
    evaluationRole: "composition_independent_reference",
    comparisonGroup: "auto"
  },
  {
    id: "auto__luna",
    model: "openai/gpt-5.6-luna",
    evaluationRole: "composition_candidate",
    comparisonGroup: "auto"
  }
];
const realTasks = [];
for (const episode of realCohort) {
  const cards = privateRegistries.get(episode.repositoryId);
  const tail = taskAwareTail(profiles.get(episode.repositoryId), episode);
  const neutral = neutralOutput("real-conversation", episode.id);
  const requests = {
    auto__sol: compositionRequest({
      cards,
      tail,
      neutral,
      name: "auto_real_conversation_reference"
    }),
    auto__claude: compositionRequest({
      cards,
      tail,
      neutral,
      name: "auto_real_conversation_independent_reference"
    }),
    auto__luna: compositionRequest({
      cards,
      tail,
      name: "auto_real_conversation_candidate",
      direct: true
    })
  };
  const taskId = `real-conversation-${safeId(episode.id)}`;
  const input = {
    schemaVersion: 1,
    datasetId: realDatasetId,
    taskId,
    sourceEpisodeId: episode.id,
    repositoryId: episode.repositoryId,
    requests
  };
  const file = path.join(outputDirectory, realDatasetId, "inputs", `${taskId}.json`);
  const result = await writeJson(file, input);
  realTasks.push({
    id: taskId,
    file,
    digest: result.digest,
    size: result.bytes.length,
    pathname: `inputs/${realDatasetId}/${taskId}/sha256/${result.digest.slice(0, 2)}/${
      result.digest
    }.json`,
    metadata: {
      sourceEpisodeId: episode.id,
      repositoryId: episode.repositoryId,
      cohort: "real-conversation",
      split: episode.split,
      contextual:
        Boolean(episode.taskAnchor) ||
        Boolean(episode.precedingAssistant) ||
        (episode.earlierUserContext?.length ?? 0) > 0,
      diagnostic: Boolean(episode.relevantDiagnostic)
    }
  });
}

const assistanceGroups = ["human", "auto"];
const assistanceDefinitions = assistanceGroups.flatMap((comparisonGroup) => [
  {
    id: `${comparisonGroup}__sol`,
    model: "openai/gpt-5.6-sol",
    evaluationRole: "composition_reference",
    comparisonGroup
  },
  {
    id: `${comparisonGroup}__luna`,
    model: "openai/gpt-5.6-luna",
    evaluationRole: "composition_candidate",
    comparisonGroup
  }
]);
const assistanceRegistries = {
  human: normalizeCards(routekitHumanCards.map(convertHumanCard)),
  auto: privateRegistries.get("velum-labs/routekit")
};
const assistanceEpisodes = realCohort.filter(
  (episode) => episode.repositoryId === "velum-labs/routekit" && episode.split === "validation"
);
if (assistanceEpisodes.length !== 3) {
  throw new Error(`expected 3 RouteKit assistance validation tasks`);
}
const assistanceTasks = [];
for (const episode of assistanceEpisodes) {
  const tail = taskAwareTail(profiles.get(episode.repositoryId), episode);
  const neutral = neutralOutput("real-conversation", episode.id);
  const requests = {};
  for (const comparisonGroup of assistanceGroups) {
    const cards = assistanceRegistries[comparisonGroup];
    requests[`${comparisonGroup}__sol`] = compositionRequest({
      cards,
      tail,
      neutral,
      name: `${comparisonGroup}_assistance_reference`
    });
    requests[`${comparisonGroup}__luna`] = compositionRequest({
      cards,
      tail,
      name: `${comparisonGroup}_assistance_candidate`,
      direct: true
    });
  }
  const taskId = `routekit-assistance-validation-${safeId(episode.id)}`;
  const input = {
    schemaVersion: 1,
    datasetId: assistanceDatasetId,
    taskId,
    sourceEpisodeId: episode.id,
    repositoryId: episode.repositoryId,
    requests
  };
  const file = path.join(outputDirectory, assistanceDatasetId, "inputs", `${taskId}.json`);
  const result = await writeJson(file, input);
  assistanceTasks.push({
    id: taskId,
    file,
    digest: result.digest,
    size: result.bytes.length,
    pathname: `inputs/${assistanceDatasetId}/${taskId}/sha256/${result.digest.slice(
      0,
      2
    )}/${result.digest}.json`,
    metadata: {
      sourceEpisodeId: episode.id,
      repositoryId: episode.repositoryId,
      cohort: "real-conversation-routekit-assistance",
      split: "validation"
    }
  });
}

const registryAuditResult = await writeJson(
  path.join(outputDirectory, "cohort-registry-audit.json"),
  {
    schemaVersion: 1,
    naturalRegistries,
    privateRegistries: Object.fromEntries(privateRegistries),
    assistanceRegistries
  }
);
const sharedSourceHash = digest(
  Buffer.concat([
    Buffer.from(JSON.stringify(naturalHard)),
    Buffer.from(JSON.stringify(realCohort)),
    validationAuditBytes,
    selectionBytes,
    constructionAuditBytes,
    registryAuditResult.bytes
  ])
);
const safeguards = {
  lockedTestIncluded: false,
  labelsExcludedFromModelPrompts: true,
  changedFilesExcludedFromModelPrompts: true,
  neutralDecompositionFrozenBeforeRegistryMapping: true
};
const [naturalInventory, realInventory, assistanceInventory] = await Promise.all([
  freezeInputs({
    datasetId: naturalDatasetId,
    tasks: naturalTasks,
    sourceHash: sharedSourceHash,
    comparisonGroups: naturalGroups,
    treatmentDefinitions: naturalDefinitions,
    safeguards: { ...safeguards, naturalHardCohortFrozenBeforeCampaign: true }
  }),
  freezeInputs({
    datasetId: realDatasetId,
    tasks: realTasks,
    sourceHash: sharedSourceHash,
    comparisonGroups: realGroups,
    treatmentDefinitions: realDefinitions,
    safeguards: { ...safeguards, realConversationCohortFrozenBeforeCampaign: true }
  }),
  freezeInputs({
    datasetId: assistanceDatasetId,
    tasks: assistanceTasks,
    sourceHash: sharedSourceHash,
    comparisonGroups: assistanceGroups,
    treatmentDefinitions: assistanceDefinitions,
    safeguards: {
      ...safeguards,
      routekitTestTasksExcludedFromValidationAndRepair: true
    }
  })
]);

console.log(
  JSON.stringify(
    {
      ok: true,
      inventories: [
        naturalInventory.inventoryFile,
        realInventory.inventoryFile,
        assistanceInventory.inventoryFile
      ],
      tasks: {
        naturalHard: naturalTasks.length,
        realConversation: realTasks.length,
        routekitAssistanceValidation: assistanceTasks.length
      }
    },
    null,
    2
  )
);
