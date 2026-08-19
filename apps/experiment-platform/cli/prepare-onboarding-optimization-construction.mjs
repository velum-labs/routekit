#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  assetRoot,
  digest,
  freezeDataset,
  readJson,
  registrySchema,
  repositoryStructure,
  request,
  root,
  safeId,
  writeJson
} from "./onboarding-optimization-common.mjs";

const previousSourceFile = path.join(
  root,
  ".routekit-experiment-assets/onboarding-generalization-20260819/source/source-inventory.json"
);
const realCohortFile =
  "/home/benjamin/repos/ori-runtime-lab/experiments/coding-router-lab/data/private/real-conversational-coding-v1/episodes.jsonl";
const publicDatasetId = "onboarding-optimization-public-registries-3x13-v1";
const privateDatasetId = "onboarding-optimization-private-registries-4-v1";
const outputDirectory = path.join(assetRoot, "construction");

const publicRepositories = {
  "backstage/backstage": "/home/benjamin/repos/backstage-public-benchmark",
  "grafana/grafana": "/home/benjamin/repos/grafana-public-benchmark",
  "kubernetes/kubernetes": "/home/benjamin/repos/kubernetes-public-benchmark"
};
const privateRepositories = {
  "velum-labs/routekit": {
    path: "/home/benjamin/repos/routekit",
    source:
      "/home/benjamin/repos/ori-runtime-lab/experiments/coding-router-lab/data/private/team-transfers-20260815/imported/benjamzc-velum-labs-routekit-20260815/benjamzc-velum-labs-routekit-20260815-aws-recurated-final-episodes.jsonl"
  },
  "velum-labs/factory": {
    path: "/home/benjamin/repos/factory",
    source:
      "/home/benjamin/repos/ori-runtime-lab/experiments/coding-router-lab/data/private/team-transfers-20260815/imported/000alen-velum-labs-factory-20260815-2/000alen-velum-labs-factory-20260815-2-aws-qualified-final-episodes.jsonl"
  },
  "velum-labs/ori": {
    path: "/home/benjamin/repos/ori",
    source:
      "/home/benjamin/repos/ori-runtime-lab/experiments/coding-router-lab/data/private/team-transfers-20260815/imported/000alen-velum-labs-ori-20260815/000alen-velum-labs-ori-20260815-aws-recurated-final-episodes.jsonl"
  },
  "velum-labs/velum": {
    path: "/home/benjamin/repos/velum",
    source:
      "/home/benjamin/repos/ori-runtime-lab/experiments/coding-router-lab/data/private/team-transfers-20260815/imported/benjamzc-velum-labs-velum-20260815/benjamzc-velum-labs-velum-20260815-aws-recurated-final-episodes.jsonl"
  }
};

const publicTreatments = [
  {
    id: "tasks_only_40_recent",
    areaCount: 8,
    history: { count: 40, sample: "recent" },
    includeStructure: false,
    includePathStats: false
  },
  {
    id: "structure_only",
    areaCount: 8,
    history: undefined,
    includeStructure: true,
    includePathStats: false
  },
  {
    id: "hybrid_40_recent",
    areaCount: 8,
    history: { count: 40, sample: "recent" },
    includeStructure: true,
    includePathStats: false
  },
  {
    id: "hybrid_paths_40_recent",
    areaCount: 8,
    history: { count: 40, sample: "recent" },
    includeStructure: true,
    includePathStats: true
  },
  {
    id: "hybrid_paths_5_diverse",
    areaCount: 8,
    history: { count: 5, sample: "diverse" },
    includeStructure: true,
    includePathStats: true
  },
  {
    id: "hybrid_paths_10_diverse",
    areaCount: 8,
    history: { count: 10, sample: "diverse" },
    includeStructure: true,
    includePathStats: true
  },
  {
    id: "hybrid_paths_20_diverse",
    areaCount: 8,
    history: { count: 20, sample: "diverse" },
    includeStructure: true,
    includePathStats: true
  },
  {
    id: "hybrid_paths_40_diverse_a",
    areaCount: 8,
    history: { count: 40, sample: "diverse" },
    includeStructure: true,
    includePathStats: true,
    variation: "A"
  },
  {
    id: "hybrid_paths_40_diverse_b",
    areaCount: 8,
    history: { count: 40, sample: "diverse" },
    includeStructure: true,
    includePathStats: true,
    variation: "B"
  },
  {
    id: "hybrid_paths_80_diverse",
    areaCount: 8,
    history: { count: 80, sample: "diverse" },
    includeStructure: true,
    includePathStats: true
  },
  {
    id: "hybrid_paths_40_diverse_6areas",
    areaCount: 6,
    history: { count: 40, sample: "diverse" },
    includeStructure: true,
    includePathStats: true
  },
  {
    id: "hybrid_paths_40_diverse_10areas",
    areaCount: 10,
    history: { count: 40, sample: "diverse" },
    includeStructure: true,
    includePathStats: true
  },
  {
    id: "hybrid_paths_40_diverse_rules",
    areaCount: 8,
    history: { count: 40, sample: "diverse" },
    includeStructure: true,
    includePathStats: true,
    strictRules: true
  }
];

const transientTitle =
  /^(?:(?:chore|build|docs?)(?:\([^)]*\))?:\s*)?(?:bump|update|upgrade|release|docs?|documentation)\b/iu;
const botLogin = /(?:\[bot\]$|dependabot|renovate|github-actions|mergify|backstage-bot)/iu;
const normalizeWhitespace = (value) => value.replaceAll(/\s+/gu, " ").trim();
const normalizedTitle = (value) =>
  normalizeWhitespace(value)
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, " ")
    .trim();

function readJsonl(file) {
  return readFile(file, "utf8").then((contents) =>
    contents
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  );
}

function tokenize(task) {
  return new Set(
    `${task.title ?? ""} ${task.body ?? task.currentRequest ?? ""}`
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .filter((token) => token.length >= 4)
  );
}

function jaccard(left, right) {
  const intersection = [...left].filter((token) => right.has(token)).length;
  const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : intersection / union;
}

function diverseSample(tasks, count) {
  if (count >= tasks.length) return [...tasks];
  const ordered = [...tasks].sort((left, right) =>
    String(right.mergedAt ?? right.timestamp).localeCompare(String(left.mergedAt ?? left.timestamp))
  );
  const tokens = new Map(ordered.map((task) => [task, tokenize(task)]));
  const selected = [ordered[0]];
  const remaining = new Set(ordered.slice(1));
  while (selected.length < count && remaining.size > 0) {
    let winner;
    let winnerScore = -Infinity;
    for (const candidate of remaining) {
      const novelty =
        1 -
        Math.max(
          ...selected.map((existing) => jaccard(tokens.get(candidate), tokens.get(existing)))
        );
      const recency = 1 - ordered.indexOf(candidate) / ordered.length;
      const score = novelty * 0.85 + recency * 0.15;
      if (score > winnerScore) {
        winner = candidate;
        winnerScore = score;
      }
    }
    selected.push(winner);
    remaining.delete(winner);
  }
  return selected;
}

function cleanBody(value) {
  return (value ?? "")
    .replaceAll(/<!--[\s\S]*?-->/gu, "")
    .replaceAll(/\r/gu, "")
    .replaceAll(/\n{3,}/gu, "\n\n")
    .trim()
    .slice(0, 3000);
}

function olderHistoricalTasks(repositoryId, existing) {
  const earliest = existing
    .map((task) => task.mergedAt)
    .filter(Boolean)
    .sort()[0];
  const cutoff = new Date(new Date(earliest).getTime() - 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const payload = JSON.parse(
    execFileSync(
      "gh",
      [
        "pr",
        "list",
        "--repo",
        repositoryId,
        "--state",
        "merged",
        "--limit",
        "500",
        "--search",
        `merged:<${cutoff} sort:updated-desc`,
        "--json",
        "number,title,body,mergedAt,author,labels"
      ],
      { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 }
    )
  );
  const existingNumbers = new Set(existing.map((task) => task.pullRequestNumber));
  const seenTitles = new Set(existing.map((task) => normalizedTitle(task.title)));
  return payload.flatMap((pullRequest) => {
    const body = cleanBody(pullRequest.body);
    const titleKey = normalizedTitle(pullRequest.title);
    if (
      existingNumbers.has(pullRequest.number) ||
      seenTitles.has(titleKey) ||
      body.length < 100 ||
      transientTitle.test(pullRequest.title) ||
      botLogin.test(pullRequest.author?.login ?? "")
    ) {
      return [];
    }
    seenTitles.add(titleKey);
    return [
      {
        taskId: `${repositoryId.replace("/", "-")}-older-pr-${pullRequest.number}`,
        repositoryId,
        pullRequestNumber: pullRequest.number,
        title: pullRequest.title.trim(),
        body,
        mergedAt: pullRequest.mergedAt,
        source: "older-github-pr"
      }
    ];
  });
}

function changedPathStatistics(tasks) {
  const counts = new Map();
  for (const task of tasks) {
    for (const file of task.changedFilesAuditOnly ?? []) {
      const parts = file.path.split("/");
      const prefix =
        parts.length === 1 ? "(root)" : parts.slice(0, Math.min(2, parts.length)).join("/");
      counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 60)
    .map(([pathPrefix, changedTaskCount]) => ({ pathPrefix, changedTaskCount }));
}

function historyText(tasks) {
  return tasks.flatMap((task, index) => [
    `Task ${index + 1}`,
    `Title: ${task.title ?? task.currentRequest}`,
    `Request: ${(task.body ?? task.currentRequest ?? "").slice(0, 1800)}`,
    ""
  ]);
}

function registrySystem(areaCount, strictRules, variation) {
  return [
    `Create exactly ${areaCount} stable repository-specific runtime areas for classifying future coding tasks.`,
    "Prefer durable implementation responsibilities over temporary projects, individual bugs, or recent feature names.",
    "Area IDs must be unique lowercase kebab-case strings.",
    "Every card must define positive ownership, exclusions, confusing neighbors, representative paths or components, and multi-area boundaries.",
    "Do not mention model performance or routing recommendations.",
    "Do not invent held-out work and use only the supplied historical information.",
    ...(strictRules
      ? [
          "Use one flat semantic level with bounded co-activation.",
          "Avoid aliases, catch-alls, duplicate ownership, and parent-child pairs.",
          "Prefer areas that collectively cover the repository while retaining meaningful routing resolution."
        ]
      : [
          "Choose the organizing principle that best balances future coverage and classifiability."
        ]),
    ...(variation ? [`Independent draft variation token: ${variation}.`] : []),
    "Return exactly one strict JSON object and no prose."
  ].join("\n");
}

function publicUser({
  repository,
  structure,
  history,
  pathStatistics,
  includeStructure,
  includePathStats
}) {
  return [
    "[TAXONOMY-NEUTRAL REPOSITORY PROFILE]",
    JSON.stringify(repository.profile),
    ...(includeStructure
      ? ["", "[CONSTRUCTION-ERA REPOSITORY STRUCTURE]", JSON.stringify(structure)]
      : []),
    ...(includePathStats
      ? ["", "[CONSTRUCTION-TASK CHANGED-PATH STATISTICS]", JSON.stringify(pathStatistics)]
      : []),
    ...(history ? ["", "[OLDER HISTORICAL CODING TASKS]", ...historyText(history)] : [])
  ].join("\n");
}

function sourceHash(values) {
  return digest(Buffer.from(values.map((value) => JSON.stringify(value)).join("\n")));
}

const previousSourceBytes = await readFile(previousSourceFile);
const previousSource = JSON.parse(previousSourceBytes);
const publicTasks = [];
const publicAudit = [];

for (const repository of previousSource.repositories) {
  const repositoryPath = publicRepositories[repository.repositoryId];
  if (!repositoryPath) throw new Error(`missing local repository for ${repository.repositoryId}`);
  const extra = olderHistoricalTasks(repository.repositoryId, repository.generation);
  const allHistory = [...repository.generation, ...extra]
    .sort((left, right) => right.mergedAt.localeCompare(left.mergedAt))
    .slice(0, 80);
  if (allHistory.length < 80) {
    throw new Error(`${repository.repositoryId} has only ${allHistory.length} historical tasks`);
  }
  const requestedCommit = repository.generation
    .map((task) => ({ mergedAt: task.mergedAt, baseRefOid: task.baseRefOid }))
    .sort((left, right) => right.mergedAt.localeCompare(left.mergedAt))[0].baseRefOid;
  const structure = repositoryStructure(repositoryPath, requestedCommit);
  const pathStatistics = changedPathStatistics(repository.generation);
  const requests = {};
  const treatmentAudit = [];
  for (const treatment of publicTreatments) {
    const history = treatment.history
      ? treatment.history.sample === "diverse"
        ? diverseSample(allHistory, treatment.history.count)
        : allHistory.slice(0, treatment.history.count)
      : undefined;
    requests[treatment.id] = request(
      registrySystem(treatment.areaCount, treatment.strictRules, treatment.variation),
      publicUser({
        repository,
        structure,
        history,
        pathStatistics,
        includeStructure: treatment.includeStructure,
        includePathStats: treatment.includePathStats
      }),
      registrySchema(treatment.areaCount),
      `routekit_${treatment.id}_registry`
    );
    treatmentAudit.push({
      id: treatment.id,
      areaCount: treatment.areaCount,
      historicalTasks: history?.length ?? 0,
      historyTaskIds: history?.map((task) => task.taskId) ?? [],
      includeStructure: treatment.includeStructure,
      includePathStats: treatment.includePathStats,
      strictRules: treatment.strictRules === true
    });
  }
  const taskId = `generate-${safeId(repository.repositoryId)}`;
  const input = {
    schemaVersion: 1,
    datasetId: publicDatasetId,
    taskId,
    repositoryId: repository.repositoryId,
    requests
  };
  const file = path.join(outputDirectory, publicDatasetId, "inputs", `${taskId}.json`);
  const result = await writeJson(file, input);
  publicTasks.push({
    id: taskId,
    file,
    digest: result.digest,
    size: result.bytes.length,
    pathname: `inputs/${publicDatasetId}/${taskId}/sha256/${result.digest.slice(0, 2)}/${
      result.digest
    }.json`,
    metadata: {
      repositoryId: repository.repositoryId,
      resolvedStructureCommit: structure.resolvedCommit,
      constructionTasksAvailable: allHistory.length,
      evaluationTaskTextExcluded: true
    }
  });
  publicAudit.push({
    repositoryId: repository.repositoryId,
    structure,
    pathStatistics,
    treatments: treatmentAudit
  });
}

const realCohort = await readJsonl(realCohortFile);
const realEvaluationIds = new Set(realCohort.map((episode) => episode.id));
const privateTasks = [];
const privateAudit = [];

for (const [repositoryId, definition] of Object.entries(privateRepositories)) {
  const episodes = (await readJsonl(definition.source))
    .filter(
      (episode) =>
        episode.split === "reference" &&
        !realEvaluationIds.has(episode.id) &&
        normalizeWhitespace(episode.currentRequest).length >= 8
    )
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp));
  const history = diverseSample(episodes, Math.min(40, episodes.length));
  if (history.length < 5) {
    throw new Error(`${repositoryId} has only ${history.length} usable construction episodes`);
  }
  const snapshotCounts = new Map();
  for (const episode of history) {
    snapshotCounts.set(
      episode.repositorySnapshot,
      (snapshotCounts.get(episode.repositorySnapshot) ?? 0) + 1
    );
  }
  const requestedCommit = [...snapshotCounts.entries()].sort(
    (left, right) => right[1] - left[1]
  )[0][0];
  const structure = repositoryStructure(definition.path, requestedCommit);
  const treatmentId = "real_hybrid_registry";
  const user = [
    "[REPOSITORY]",
    repositoryId,
    "",
    "[CONSTRUCTION-ERA REPOSITORY STRUCTURE]",
    JSON.stringify(structure),
    "",
    "[SEPARATE REAL CODING REQUESTS]",
    ...historyText(history)
  ].join("\n");
  const taskId = `generate-${safeId(repositoryId)}`;
  const input = {
    schemaVersion: 1,
    datasetId: privateDatasetId,
    taskId,
    repositoryId,
    requests: {
      [treatmentId]: request(
        registrySystem(8, false),
        user,
        registrySchema(8),
        "routekit_real_conversation_registry"
      )
    }
  };
  const file = path.join(outputDirectory, privateDatasetId, "inputs", `${taskId}.json`);
  const result = await writeJson(file, input);
  privateTasks.push({
    id: taskId,
    file,
    digest: result.digest,
    size: result.bytes.length,
    pathname: `inputs/${privateDatasetId}/${taskId}/sha256/${result.digest.slice(0, 2)}/${
      result.digest
    }.json`,
    metadata: {
      repositoryId,
      resolvedStructureCommit: structure.resolvedCommit,
      constructionEpisodes: history.length,
      evaluationTaskIdsExcluded: realEvaluationIds.size
    }
  });
  privateAudit.push({
    repositoryId,
    structure,
    constructionEpisodeIds: history.map((episode) => episode.id)
  });
}

const safeguards = {
  lockedTestIncluded: false,
  heldoutTaskTextExcludedFromGeneration: true,
  changedFilesFromHeldoutTasksExcluded: true,
  constructionEraRepositoryStructureOnly: true,
  privateEvaluationTaskIdsExcludedFromConstruction: true
};
const [publicInventory, privateInventory] = await Promise.all([
  freezeDataset({
    directory: outputDirectory,
    datasetId: publicDatasetId,
    role: "construction",
    tasks: publicTasks,
    safeguards,
    sourceHash: digest(previousSourceBytes),
    metadata: { treatments: publicTreatments }
  }),
  freezeDataset({
    directory: outputDirectory,
    datasetId: privateDatasetId,
    role: "construction",
    tasks: privateTasks,
    safeguards,
    sourceHash: sourceHash([realCohort, privateAudit]),
    metadata: { treatmentId: "real_hybrid_registry" }
  })
]);

await writeJson(path.join(outputDirectory, "construction-audit.json"), {
  schemaVersion: 1,
  public: publicAudit,
  private: privateAudit,
  safeguards
});

console.log(
  JSON.stringify(
    {
      ok: true,
      publicInventory: publicInventory.inventoryFile,
      privateInventory: privateInventory.inventoryFile,
      publicRepositories: publicTasks.length,
      publicTreatments: publicTreatments.length,
      privateRepositories: privateTasks.length
    },
    null,
    2
  )
);
