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
  safeId,
  taskAwareTail,
  writeJson
} from "./onboarding-optimization-common.mjs";

const datasetId = "onboarding-optimization-routekit-assistance-final-5x3-v1";
const outputDirectory = path.join(assetRoot, "routekit-assistance");
const auditFile = path.join(assetRoot, "cohorts/cohort-registry-audit.json");
const constructionAuditFile = path.join(assetRoot, "construction/construction-audit.json");
const realCohortFile =
  "/home/benjamin/repos/ori-runtime-lab/experiments/coding-router-lab/data/private/real-conversational-coding-v1/episodes.jsonl";
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
  if (
    snapshot.experiment?.status !== "completed" ||
    snapshot.jobs.some((record) => record.status !== "succeeded")
  ) {
    throw new Error(`${experimentId} is not successfully completed`);
  }
  return snapshot;
}

const [
  auditBytes,
  constructionAuditBytes,
  realCohort,
  repairSnapshot,
  neutralSnapshot,
  neutralRetrySnapshot,
  neutralInsufficientRetrySnapshot
] = await Promise.all([
  readFile(auditFile),
  readFile(constructionAuditFile),
  readJsonl(realCohortFile),
  completedExperiment("onboarding-optimization-routekit-assistance-repair-1-v1"),
  completedExperiment("onboarding-optimization-neutral-93-v1"),
  completedExperiment("onboarding-optimization-neutral-retry-2-v1"),
  completedExperiment("onboarding-optimization-neutral-insufficient-retry-1-v1")
]);
const audit = JSON.parse(auditBytes);
const constructionAudit = JSON.parse(constructionAuditBytes);
const store = new VercelBlobArtifactStore();
const repairRecord = repairSnapshot.jobs[0];
const repair = responseObject(await readJsonArtifact(store, repairRecord.outputArtifact));
const neutralEntries = (
  await Promise.all(
    neutralSnapshot.jobs.map(async (record) => {
      try {
        return [
          `${record.job.taskId}:${record.job.treatmentId}`,
          responseObject(await readJsonArtifact(store, record.outputArtifact))
        ];
      } catch {
        return undefined;
      }
    })
  )
).filter(Boolean);
const neutralOutputs = new Map(neutralEntries);
for (const snapshot of [neutralRetrySnapshot, neutralInsufficientRetrySnapshot]) {
  const metadataByTask = new Map(
    snapshot.experiment.manifest.tasks.map((task) => [task.id, task.metadata])
  );
  for (const record of snapshot.jobs) {
    let output;
    try {
      output = responseObject(await readJsonArtifact(store, record.outputArtifact));
    } catch {
      continue;
    }
    const metadata = metadataByTask.get(record.job.taskId);
    if (!metadata?.originalTaskId || !metadata.originalTreatmentId) {
      throw new Error(`invalid neutral retry metadata for ${record.job.id}`);
    }
    neutralOutputs.set(`${metadata.originalTaskId}:${metadata.originalTreatmentId}`, output);
  }
}
const structure = constructionAudit.private.find(
  (entry) => entry.repositoryId === "velum-labs/routekit"
)?.structure;
if (!structure) throw new Error("missing RouteKit structure profile");
const profile = {
  repositoryId: "velum-labs/routekit",
  purpose: structure.readmeExcerpt?.slice(0, 1500) ?? null,
  topDirectories: structure.topDirectories,
  topExtensions: structure.topExtensions,
  manifestPaths: structure.manifestPaths.slice(0, 40)
};
const registries = {
  human: normalizeCards(audit.assistanceRegistries.human),
  auto: normalizeCards(audit.assistanceRegistries.auto),
  repaired: normalizeCards(repair.areas)
};
const comparisonGroups = ["human", "auto", "repaired"];
const treatmentDefinitions = comparisonGroups.flatMap((comparisonGroup) => [
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
const testEpisodes = realCohort.filter(
  (episode) => episode.repositoryId === "velum-labs/routekit" && episode.split === "test"
);
if (testEpisodes.length !== 5) throw new Error(`expected five RouteKit test episodes`);
const tasks = [];
for (const episode of testEpisodes) {
  const tail = taskAwareTail(profile, episode);
  const neutral = neutralOutputs.get(`real-conversation-${safeId(episode.id)}:neutral_sol`);
  if (!neutral) throw new Error(`missing neutral output for ${episode.id}`);
  const requests = {};
  for (const comparisonGroup of comparisonGroups) {
    const cards = registries[comparisonGroup];
    requests[`${comparisonGroup}__sol`] = compositionRequest({
      cards,
      tail,
      neutral,
      name: `${comparisonGroup}_routekit_final_reference`
    });
    requests[`${comparisonGroup}__luna`] = compositionRequest({
      cards,
      tail,
      name: `${comparisonGroup}_routekit_final_candidate`,
      direct: true
    });
  }
  const taskId = `routekit-assistance-final-${safeId(episode.id)}`;
  const input = {
    schemaVersion: 1,
    datasetId,
    taskId,
    sourceEpisodeId: episode.id,
    repositoryId: episode.repositoryId,
    requests
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
      sourceEpisodeId: episode.id,
      repositoryId: episode.repositoryId,
      split: "test",
      repairFrozenBeforeTestTaskExposure: true
    }
  });
}
const auditResult = await writeJson(
  path.join(outputDirectory, "routekit-assistance-final-audit.json"),
  { schemaVersion: 1, comparisonGroups, treatmentDefinitions, registries }
);
const { inventoryFile } = await freezeDataset({
  directory: outputDirectory,
  datasetId,
  role: "development",
  tasks,
  sourceHash: digest(Buffer.concat([auditBytes, constructionAuditBytes, auditResult.bytes])),
  safeguards: {
    lockedTestIncluded: false,
    repairFrozenBeforeTestTaskExposure: true,
    changedFilesExcludedFromModelPrompts: true,
    neutralDecompositionFrozenBeforeRegistryMapping: true
  },
  metadata: { comparisonGroups, treatmentDefinitions }
});
console.log(JSON.stringify({ ok: true, inventoryFile, tasks: tasks.length }, null, 2));
