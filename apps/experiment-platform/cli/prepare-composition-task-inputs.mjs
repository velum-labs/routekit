#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  buildEnrichedAreaCards,
  buildLunaPerformancePrompt,
  renderLunaPerformanceEvidence
} from "../vendor/coding-router-lab/runtime/src/luna-performance-experiment.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const sourceAssetRoot = path.join(
  repositoryRoot,
  ".routekit-experiment-assets/coding-router-20260817/staging"
);
const backstageRoot =
  "/home/benjamin/repos/ori-runtime-lab/experiments/coding-router-lab/data/private/public-pr-backstage-issue-grounded-v2";
const datasetId = "composition-development-100-v1";
const outputRoot = path.join(repositoryRoot, ".routekit-experiment-assets/composition-20260818");
const inputRoot = path.join(outputRoot, "inputs", datasetId);
const seed = 181081;
const treatmentIds = [
  "sol_reference",
  "luna_current",
  "luna_continuous",
  "luna_anchored",
  "luna_anchored_decomposition"
];

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const safeId = (value) => value.toLowerCase().replaceAll(/[^a-z0-9._-]+/g, "-");
const clip = (value, maximum) =>
  value.length <= maximum ? value : `${value.slice(0, maximum - 24).trimEnd()}\n…[clipped]…`;

async function readJsonl(file) {
  return (await readFile(file, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function writeJson(file, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, bytes, { mode: 0o600 });
  return { bytes, digest: sha256(bytes) };
}

function compositionSchema(areaIds) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["area_composition_scores", "unknown_probability"],
    properties: {
      area_composition_scores: {
        type: "object",
        additionalProperties: false,
        required: areaIds,
        properties: Object.fromEntries(
          areaIds.map((areaId) => [
            areaId,
            {
              type: "number",
              minimum: 0,
              maximum: 1
            }
          ])
        )
      },
      unknown_probability: {
        type: "number",
        minimum: 0,
        maximum: 1
      }
    }
  };
}

const commonContract = [
  "Return exactly one strict JSON object and no prose outside it.",
  "The object must contain area_composition_scores with every registered area exactly once, plus unknown_probability.",
  "Known-area scores are independent. They do not need to sum to one. Do not normalize or softmax them.",
  "unknown_probability is separate. It is the probability that the registered areas fail to cover at least one material responsibility required by the task.",
  "Do not multiply or otherwise reduce known-area scores when unknown_probability is high.",
  "A dependency, mentioned path, shared type, or incidental API call does not by itself make an area materially responsible.",
  "Use only the supplied task-aware context, Area Registry, and repository evidence.",
  "Do not expose hidden chain-of-thought."
].join("\n");

const anchoredRubric = [
  "Use this continuous responsibility rubric for every area:",
  "- 0.00: no material implementation responsibility",
  "- 0.25: minor supporting responsibility",
  "- 0.50: substantial secondary responsibility",
  "- 0.75: major responsibility",
  "- 1.00: dominant or core responsibility",
  "Intermediate values are allowed."
].join("\n");

function systemPrompt(treatmentId) {
  const prefix = [
    "You are a runtime classifier for coding tasks.",
    "Your output will be used as an additive task-composition vector by a separate routing policy."
  ].join("\n");
  if (treatmentId === "luna_current") {
    return [
      prefix,
      commonContract,
      "For each registered area, score the probability that the area is materially required to complete the task. Multiple areas may simultaneously receive high probabilities."
    ].join("\n\n");
  }
  if (treatmentId === "luna_continuous") {
    return [
      prefix,
      commonContract,
      "For each registered area, score the continuous strength of implementation responsibility attributable to that area. These are composition intensities, not mutually exclusive class probabilities and not merely yes/no inclusion probabilities.",
      "Use 0.00 for no material work and 1.00 for dominant responsibility; use the full interval for intermediate responsibility."
    ].join("\n\n");
  }
  const decomposition =
    treatmentId === "sol_reference" || treatmentId === "luna_anchored_decomposition"
      ? "Before choosing scores, internally decompose the request into concrete implementation responsibilities, map each responsibility to the Area Registry, apply exclusions and neighboring-area boundaries, and then score the combined task. Return only the final JSON."
      : "Apply the Area Registry exclusions and neighboring-area boundaries before scoring.";
  return [
    prefix,
    commonContract,
    "For each registered area, score the continuous strength of implementation responsibility attributable to that area. These are composition intensities, not mutually exclusive class probabilities.",
    anchoredRubric,
    decomposition
  ].join("\n\n");
}

function requestFor(treatmentId, user, areaIds) {
  return {
    messages: [
      { role: "system", content: systemPrompt(treatmentId) },
      { role: "user", content: user }
    ],
    reasoning_effort: "high",
    max_completion_tokens: 8192,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: `routekit_composition_${treatmentId}`,
        strict: true,
        schema: compositionSchema(areaIds)
      }
    }
  };
}

function syntheticEpisode(left, right, index) {
  return {
    schemaVersion: 1,
    id: `synthetic-composite-${String(index + 1).padStart(2, "0")}`,
    repositoryId: left.episode.repositoryId,
    repositorySnapshot: "synthetic-composite-no-single-snapshot",
    sessionHash: sha256(`${left.episode.sessionHash}:${right.episode.sessionHash}`),
    lineageHash: sha256(`${left.episode.lineageHash}:${right.episode.lineageHash}`),
    timestamp: "2026-08-18T00:00:00.000Z",
    split: "development",
    currentRequest: [
      "Please handle both of these changes together in one implementation:",
      "",
      "Change 1:",
      clip(left.episode.currentRequest, 3_600),
      "",
      "Change 2:",
      clip(right.episode.currentRequest, 3_600)
    ].join("\n"),
    source: "synthetic_composite"
  };
}

function pairKind(left, right) {
  if (left.known && right.known) return "known_known";
  if (left.known || right.known) return "known_unknown";
  return "unknown_unknown";
}

function candidatePairs(records, kind) {
  const pairs = [];
  for (const [leftIndex, left] of records.entries()) {
    for (const right of records.slice(leftIndex + 1)) {
      if (left.episode.repositoryId !== right.episode.repositoryId) continue;
      if (pairKind(left, right) !== kind) continue;
      if (
        kind === "known_known" &&
        left.designArea !== undefined &&
        right.designArea !== undefined &&
        left.designArea === right.designArea
      ) {
        continue;
      }
      pairs.push([left, right]);
    }
  }
  return pairs.sort(([leftA, rightA], [leftB, rightB]) =>
    `${leftA.episode.repositoryId}:${leftA.episode.id}:${rightA.episode.id}`.localeCompare(
      `${leftB.episode.repositoryId}:${leftB.episode.id}:${rightB.episode.id}`
    )
  );
}

function selectPairs(records) {
  const targets = {
    known_known: 16,
    known_unknown: 14,
    unknown_unknown: 12
  };
  const selected = [];
  const usage = new Map();
  for (const kind of ["known_known", "known_unknown", "unknown_unknown"]) {
    const candidates = candidatePairs(records, kind);
    while (selected.filter((entry) => entry.kind === kind).length < targets[kind]) {
      const remaining = candidates
        .filter(
          ([left, right]) =>
            !selected.some(
              (entry) =>
                entry.left.episode.id === left.episode.id &&
                entry.right.episode.id === right.episode.id
            )
        )
        .sort(([leftA, rightA], [leftB, rightB]) => {
          const usageA = (usage.get(leftA.episode.id) ?? 0) + (usage.get(rightA.episode.id) ?? 0);
          const usageB = (usage.get(leftB.episode.id) ?? 0) + (usage.get(rightB.episode.id) ?? 0);
          return (
            usageA - usageB ||
            `${leftA.episode.id}:${rightA.episode.id}`.localeCompare(
              `${leftB.episode.id}:${rightB.episode.id}`
            )
          );
        });
      const next = remaining[0];
      if (next === undefined) throw new Error(`Not enough ${kind} pairs`);
      const [left, right] = next;
      selected.push({ kind, left, right });
      usage.set(left.episode.id, (usage.get(left.episode.id) ?? 0) + 1);
      usage.set(right.episode.id, (usage.get(right.episode.id) ?? 0) + 1);
    }
  }
  return selected;
}

const repositories = new Map();
const sourceRecords = [];

for (const sourceDatasetId of ["natural-hard-v2-development-24"]) {
  const sourceRoot = path.join(sourceAssetRoot, sourceDatasetId);
  const manifest = JSON.parse(
    await readFile(path.join(sourceRoot, "dataset-manifest.json"), "utf8")
  );
  const episodes = await readJsonl(path.join(sourceRoot, "episodes.jsonl"));
  const labels = await readJsonl(path.join(sourceRoot, "labels.jsonl"));
  const labelsByTask = new Map(labels.map((label) => [label.taskEpisodeId, label]));
  for (const repository of manifest.repositories) {
    const profile = JSON.parse(await readFile(path.join(sourceRoot, repository.profile), "utf8"));
    const cards = buildEnrichedAreaCards({
      cards: await readJsonl(path.join(sourceRoot, repository.areas))
    });
    repositories.set(repository.repositoryId, { profile, cards });
  }
  for (const episode of episodes) {
    const label = labelsByTask.get(episode.id);
    if (label === undefined) throw new Error(`Missing label for ${episode.id}`);
    const retrieval = JSON.parse(
      await readFile(
        path.join(sourceRoot, "retrieval", "hybrid_rerank", `${episode.id}.json`),
        "utf8"
      )
    );
    sourceRecords.push({
      episode,
      retrieval,
      cohort: "natural_hard_real",
      known: label.known,
      designArea: label.selectedAreaIds[0]
    });
  }
}

const backstageProfile = JSON.parse(
  await readFile(path.join(backstageRoot, "repository-profile.json"), "utf8")
);
const backstageCards = buildEnrichedAreaCards({
  cards: await readJsonl(path.join(backstageRoot, "area-cards.jsonl"))
});
repositories.set("backstage/backstage", {
  profile: backstageProfile,
  cards: backstageCards
});
const backstageEvidence = new Map(
  (await readJsonl(path.join(backstageRoot, "offline-evidence.jsonl"))).map((entry) => [
    entry.taskEpisodeId,
    entry
  ])
);
for (const episode of await readJsonl(path.join(backstageRoot, "episodes.jsonl"))) {
  if (episode.split === "test") continue;
  const evidence = backstageEvidence.get(episode.id);
  if (evidence === undefined)
    throw new Error(`Missing Backstage design metadata for ${episode.id}`);
  sourceRecords.push({
    episode,
    retrieval: {
      schemaVersion: 1,
      taskEpisodeId: episode.id,
      repositoryId: episode.repositoryId,
      repositorySnapshot: episode.repositorySnapshot,
      variant: "not_available",
      querySource: "task_aware_context",
      candidates: []
    },
    cohort: "backstage_issue_real",
    known: evidence.samplingKind === "known",
    designArea: evidence.samplingAreaId
  });
}

if (sourceRecords.length !== 58) {
  throw new Error(`Expected 58 non-test real tasks, found ${sourceRecords.length}`);
}

const syntheticRecords = selectPairs(sourceRecords).map((pair, index) => ({
  episode: syntheticEpisode(pair.left, pair.right, index),
  retrieval: {
    schemaVersion: 1,
    taskEpisodeId: `synthetic-composite-${String(index + 1).padStart(2, "0")}`,
    repositoryId: pair.left.episode.repositoryId,
    repositorySnapshot: "synthetic-composite-no-single-snapshot",
    variant: "not_available",
    querySource: "task_aware_context",
    candidates: []
  },
  cohort: "synthetic_composite",
  syntheticKind: pair.kind,
  sourceTaskIds: [pair.left.episode.id, pair.right.episode.id]
}));

const taskRecords = [...sourceRecords, ...syntheticRecords];
if (taskRecords.length !== 100) throw new Error(`Expected 100 tasks, found ${taskRecords.length}`);

const tasks = [];
for (const record of taskRecords) {
  const repository = repositories.get(record.episode.repositoryId);
  if (repository === undefined) {
    throw new Error(`Missing repository context for ${record.episode.repositoryId}`);
  }
  const evidence = renderLunaPerformanceEvidence({
    retrieval: record.retrieval,
    presentation: "eight_short",
    maximumCharacters: 6_000
  });
  const prompt = buildLunaPerformancePrompt({
    episode: record.episode,
    profile: repository.profile,
    cards: repository.cards,
    evidence,
    presentation: "explicit_context_separation",
    inferenceStrategy: "direct",
    seed
  });
  const areaIds = repository.cards.map((card) => card.areaId);
  const input = {
    schemaVersion: 1,
    datasetId,
    taskId: record.episode.id,
    repositoryId: record.episode.repositoryId,
    repositorySnapshot: record.episode.repositorySnapshot,
    requests: Object.fromEntries(
      treatmentIds.map((treatmentId) => [
        treatmentId,
        requestFor(treatmentId, prompt.user, areaIds)
      ])
    )
  };
  const file = path.join(inputRoot, `${safeId(record.episode.id)}.json`);
  const { bytes, digest } = await writeJson(file, input);
  tasks.push({
    id: record.episode.id,
    file,
    digest,
    size: bytes.length,
    pathname: `inputs/${datasetId}/${safeId(record.episode.id)}/sha256/${digest.slice(
      0,
      2
    )}/${digest}.json`,
    metadata: {
      repositoryId: record.episode.repositoryId,
      cohort: record.cohort,
      ...(record.syntheticKind === undefined
        ? {}
        : {
            syntheticKind: record.syntheticKind,
            sourceTaskIds: record.sourceTaskIds
          })
    }
  });
}

const canarySelectors = [
  (task) => task.metadata.cohort === "natural_hard_real",
  (task) => task.metadata.cohort === "backstage_issue_real",
  (task) => task.metadata.syntheticKind === "known_known",
  (task) => task.metadata.syntheticKind === "known_unknown",
  (task) => task.metadata.syntheticKind === "unknown_unknown"
];
const canaryCounts = [2, 3, 2, 2, 1];
const canaryTaskIds = canarySelectors.flatMap((selector, index) =>
  tasks
    .filter(selector)
    .slice(0, canaryCounts[index])
    .map((task) => task.id)
);
if (canaryTaskIds.length !== 10 || new Set(canaryTaskIds).size !== 10) {
  throw new Error("Failed to construct a unique ten-case canary");
}

const datasetManifest = {
  schemaVersion: 1,
  datasetId,
  generatedAt: "2026-08-18T00:00:00.000Z",
  role: "development",
  counts: {
    total: tasks.length,
    real: tasks.filter((task) => task.metadata.cohort !== "synthetic_composite").length,
    synthetic: tasks.filter((task) => task.metadata.cohort === "synthetic_composite").length,
    byRepository: Object.fromEntries(
      [...new Set(tasks.map((task) => task.metadata.repositoryId))]
        .sort()
        .map((repositoryId) => [
          repositoryId,
          tasks.filter((task) => task.metadata.repositoryId === repositoryId).length
        ])
    ),
    byCohort: Object.fromEntries(
      [...new Set(tasks.map((task) => task.metadata.cohort))]
        .sort()
        .map((cohort) => [cohort, tasks.filter((task) => task.metadata.cohort === cohort).length])
    )
  },
  canaryTaskIds,
  safeguards: {
    taskAwareContextOnly: true,
    latestRequestOnlyRepresentationIncluded: false,
    sourceHardLabelsExcludedFromModelInputs: true,
    backstageLockedTestTasksIncluded: false,
    routekitLockedTestDataIncluded: false,
    inferenceExecutedDuringPreparation: false
  },
  treatments: treatmentIds,
  tasks: tasks.map(({ file: _file, ...task }) => task)
};
const datasetManifestFile = path.join(outputRoot, "dataset-manifest.json");
const { digest: datasetHash, bytes: datasetBytes } = await writeJson(
  datasetManifestFile,
  datasetManifest
);
const inventory = {
  schemaVersion: 1,
  datasetId,
  datasetHash,
  datasetManifestFile,
  datasetManifestSize: datasetBytes.length,
  datasetManifestPathname: `datasets/${datasetId}/sha256/${datasetHash.slice(
    0,
    2
  )}/${datasetHash}.json`,
  canaryTaskIds,
  tasks
};
const inventoryFile = path.join(outputRoot, "input-inventory.json");
await writeJson(inventoryFile, inventory);

console.log(
  JSON.stringify(
    {
      ok: true,
      datasetId,
      datasetHash,
      inventoryFile,
      tasks: tasks.length,
      canaryTasks: canaryTaskIds.length,
      counts: datasetManifest.counts,
      safeguards: datasetManifest.safeguards
    },
    null,
    2
  )
);
