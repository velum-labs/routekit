#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  assetRoot,
  digest,
  freezeDataset,
  neutralSchema,
  readJson,
  request,
  root,
  safeId,
  taskAwareTail,
  writeJson
} from "./onboarding-optimization-common.mjs";

const datasetId = "onboarding-optimization-neutral-93-v1";
const outputDirectory = path.join(assetRoot, "neutral");
const naturalHardFile =
  "/home/benjamin/repos/ori-runtime-lab/experiments/coding-router-lab/data/private/natural-hard-cohort-v2-48/episodes.jsonl";
const realCohortFile =
  "/home/benjamin/repos/ori-runtime-lab/experiments/coding-router-lab/data/private/real-conversational-coding-v1/episodes.jsonl";
const constructionAuditFile = path.join(assetRoot, "construction/construction-audit.json");
const publicProfiles = {
  "grafana/grafana":
    "/home/benjamin/repos/ori-runtime-lab/experiments/coding-router-lab/data/private/public-issue-diverse-v1/grafana/repository-profile.json",
  "kubernetes/kubernetes":
    "/home/benjamin/repos/ori-runtime-lab/experiments/coding-router-lab/data/private/public-issue-diverse-v1/kubernetes/repository-profile.json"
};

const neutralSystem = [
  "Create a taxonomy-neutral reference for a coding-task routing experiment.",
  "Identify concrete, independently implementable responsibilities required by the visible task-aware request.",
  "Candidate area names and completed implementation labels are intentionally absent.",
  "Do not invent an Area Registry and do not use outside knowledge about a completed change.",
  "Dependencies, mentioned files, and incidental API calls are not responsibilities by themselves.",
  "Use materiality from 0.00 through 1.00 and only the supplied request and repository profile.",
  "Return exactly one strict JSON object and no prose."
].join("\n");

function readJsonl(file) {
  return readFile(file, "utf8").then((contents) =>
    contents
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  );
}

function privateProfile(repositoryId, audit) {
  const entry = audit.private.find((candidate) => candidate.repositoryId === repositoryId);
  if (!entry) throw new Error(`missing private construction audit for ${repositoryId}`);
  return {
    repositoryId,
    purpose: entry.structure.readmeExcerpt?.slice(0, 1500) ?? null,
    topDirectories: entry.structure.topDirectories,
    topExtensions: entry.structure.topExtensions,
    manifestPaths: entry.structure.manifestPaths.slice(0, 40)
  };
}

const [naturalHard, realCohort, audit] = await Promise.all([
  readJsonl(naturalHardFile),
  readJsonl(realCohortFile),
  readJson(constructionAuditFile)
]);
const profileCache = new Map();
for (const [repositoryId, file] of Object.entries(publicProfiles)) {
  profileCache.set(repositoryId, await readJson(file));
}
for (const repositoryId of new Set(realCohort.map((episode) => episode.repositoryId))) {
  profileCache.set(repositoryId, privateProfile(repositoryId, audit));
}

const sourceHash = digest(Buffer.from(JSON.stringify({ naturalHard, realCohort, audit })));
const tasks = [];
for (const [cohort, episodes] of [
  ["natural-hard", naturalHard],
  ["real-conversation", realCohort]
]) {
  for (const episode of episodes) {
    const profile = profileCache.get(episode.repositoryId);
    if (!profile) throw new Error(`missing repository profile for ${episode.repositoryId}`);
    const taskId = `${cohort}-${safeId(episode.id)}`;
    const input = {
      schemaVersion: 1,
      datasetId,
      taskId,
      repositoryId: episode.repositoryId,
      sourceEpisodeId: episode.id,
      requests: {
        neutral_sol: request(
          neutralSystem,
          taskAwareTail(profile, episode),
          neutralSchema(),
          "routekit_onboarding_optimization_neutral"
        )
      }
    };
    const file = path.join(outputDirectory, datasetId, "inputs", `${taskId}.json`);
    const result = await writeJson(file, input);
    tasks.push({
      id: taskId,
      file,
      digest: result.digest,
      size: result.bytes.length,
      pathname: `inputs/${datasetId}/${taskId}/sha256/${result.digest.slice(0, 2)}/${
        result.digest
      }.json`,
      metadata: {
        cohort,
        sourceEpisodeId: episode.id,
        repositoryId: episode.repositoryId,
        split: episode.split,
        contextual:
          Boolean(episode.taskAnchor) ||
          Boolean(episode.precedingAssistant) ||
          (episode.earlierUserContext?.length ?? 0) > 0,
        diagnostic: Boolean(episode.relevantDiagnostic)
      }
    });
  }
}
if (tasks.length !== 93) throw new Error(`expected 93 neutral tasks, found ${tasks.length}`);

const { inventoryFile } = await freezeDataset({
  directory: outputDirectory,
  datasetId,
  role: "construction",
  tasks,
  sourceHash,
  safeguards: {
    lockedTestIncluded: false,
    areaRegistryExcluded: true,
    labelsExcluded: true,
    changedFilesExcluded: true,
    taskAwareContextRequired: true
  },
  metadata: {
    cohorts: {
      naturalHard: naturalHard.length,
      realConversation: realCohort.length
    }
  }
});

console.log(JSON.stringify({ ok: true, inventoryFile, tasks: tasks.length }, null, 2));
