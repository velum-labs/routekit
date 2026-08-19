#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";

import { extractCompositionPrediction } from "@velum-labs/routekit-eval-core/experiment";
import {
  readJsonArtifact,
  VercelBlobArtifactStore
} from "@velum-labs/routekit-eval-store/platform";

import {
  assetRoot,
  digest,
  freezeDataset,
  registrySchema,
  request,
  writeJson
} from "./onboarding-optimization-common.mjs";

const experimentId = "onboarding-optimization-routekit-assistance-validation-3x2-v1";
const datasetId = "onboarding-optimization-routekit-assistance-repair-1-v1";
const outputDirectory = path.join(assetRoot, "routekit-assistance");
const auditFile = path.join(assetRoot, "cohorts/cohort-registry-audit.json");
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
const [auditBytes, realCohort] = await Promise.all([
  readFile(auditFile),
  readJsonl(realCohortFile)
]);
const audit = JSON.parse(auditBytes);
const episodeById = new Map(realCohort.map((episode) => [episode.id, episode]));
const metadataByTask = new Map(
  snapshot.experiment.manifest.tasks.map((task) => [task.id, task.metadata])
);
const store = new VercelBlobArtifactStore();
const entries = await Promise.all(
  snapshot.jobs
    .filter((record) => record.job.configuration.comparisonGroup === "auto")
    .map(async (record) => ({
      taskId: record.job.taskId,
      sourceEpisodeId: metadataByTask.get(record.job.taskId)?.sourceEpisodeId,
      role: record.job.configuration.evaluationRole,
      prediction: extractCompositionPrediction(await readJsonArtifact(store, record.outputArtifact))
    }))
);
const references = new Map(
  entries
    .filter((entry) => entry.role === "composition_reference")
    .map((entry) => [entry.taskId, entry])
);
const errorExamples = entries
  .filter((entry) => entry.role === "composition_candidate")
  .map((entry) => {
    const reference = references.get(entry.taskId);
    const episode = episodeById.get(entry.sourceEpisodeId);
    return {
      sourceEpisodeId: entry.sourceEpisodeId,
      taskAwareRequest: {
        taskAnchor: episode?.taskAnchor ?? null,
        earlierUserContext: episode?.earlierUserContext ?? [],
        precedingAssistant: episode?.precedingAssistant ?? null,
        currentRequest: episode?.currentRequest
      },
      solReference: reference?.prediction,
      lunaPrediction: entry.prediction
    };
  });
const cards = audit.assistanceRegistries.auto;
const system = [
  "Repair an eight-area RouteKit registry from three real conversational validation examples.",
  "Preserve stable repository responsibilities and improve future coverage and Luna classifiability.",
  "Do not create areas named after individual validation requests.",
  "Avoid catch-alls, aliases, duplicate ownership, and parent-child pairs at the same level.",
  "Write explicit exclusions and confusing-neighbor rules.",
  "The five later RouteKit test requests are unavailable and must not be guessed.",
  "Return exactly one strict JSON object and no prose."
].join("\n");
const user = [
  "[SELECTED AUTOMATIC REGISTRY]",
  JSON.stringify({ areas: cards }),
  "",
  "[VALIDATION EXAMPLES]",
  JSON.stringify(errorExamples)
].join("\n");
const input = {
  schemaVersion: 1,
  datasetId,
  taskId: "repair-velum-labs-routekit",
  repositoryId: "velum-labs/routekit",
  requests: {
    repair_sol: request(
      system,
      user,
      registrySchema(cards.length),
      "routekit_human_assistance_proxy_repair"
    )
  }
};
const file = path.join(outputDirectory, datasetId, "inputs/repair-velum-labs-routekit.json");
const result = await writeJson(file, input);
const task = {
  id: input.taskId,
  file,
  digest: result.digest,
  size: result.bytes.length,
  pathname: `inputs/${datasetId}/${input.taskId}/sha256/${result.digest.slice(0, 2)}/${
    result.digest
  }.json`,
  metadata: {
    repositoryId: "velum-labs/routekit",
    validationTasks: errorExamples.length,
    testTaskTextExcluded: true
  }
};
const { inventoryFile } = await freezeDataset({
  directory: outputDirectory,
  datasetId,
  role: "construction",
  tasks: [task],
  sourceHash: digest(Buffer.concat([auditBytes, Buffer.from(JSON.stringify(errorExamples))])),
  safeguards: {
    lockedTestIncluded: false,
    routekitTestTaskTextExcludedFromRepair: true,
    changedFilesExcludedFromModelPrompts: true
  }
});
console.log(JSON.stringify({ ok: true, inventoryFile, validationExamples: 3 }, null, 2));
