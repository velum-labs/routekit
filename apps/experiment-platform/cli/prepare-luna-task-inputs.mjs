#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  buildEnrichedAreaCards,
  buildLunaPerformancePrompt,
  renderLunaPerformanceEvidence
} from "../vendor/coding-router-lab/dist/src/luna-performance-experiment.js";
import {
  buildLunaDistributionalResponseSchema,
  scopeTargetForLabel
} from "../vendor/coding-router-lab/dist/src/luna-distributional.js";

const argv = process.argv.slice(2);
const repositoryRoot = path.resolve(import.meta.dirname, "../../..");

function argument(name, fallback) {
  const index = argv.indexOf(name);
  return index === -1 ? fallback : argv[index + 1];
}

const assetRoot = path.resolve(
  argument(
    "--asset-root",
    path.join(repositoryRoot, ".routekit-experiment-assets/coding-router-20260817")
  )
);
const outputRoot = path.resolve(
  argument(
    "--output-root",
    path.join(repositoryRoot, ".routekit-experiment-assets/coding-router-20260817/inputs")
  )
);
const datasetIds = [
  "natural-hard-v2-development-24",
  "natural-hard-v2-confirmation-24"
];
const strategies = ["direct", "evidence_first", "independent_per_area"];

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

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

function safeId(value) {
  return value.toLowerCase().replaceAll(/[^a-z0-9._-]+/g, "-");
}

function evidenceAssessmentSchema(areaIds) {
  const direct = buildLunaDistributionalResponseSchema(areaIds);
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "evidence_assessment",
      "scope_probabilities",
      "area_probabilities_given_known",
      "evidence"
    ],
    properties: {
      evidence_assessment: {
        type: "array",
        maxItems: 8,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["fact", "supports_area_ids", "contradicts_area_ids"],
          properties: {
            fact: { type: "string", minLength: 1, maxLength: 300 },
            supports_area_ids: {
              type: "array",
              maxItems: 3,
              items: { type: "string", enum: areaIds }
            },
            contradicts_area_ids: {
              type: "array",
              maxItems: 3,
              items: { type: "string", enum: areaIds }
            }
          }
        }
      },
      ...direct.properties
    }
  };
}

function independentAreaSchema(areaIds) {
  const direct = buildLunaDistributionalResponseSchema(areaIds);
  return {
    type: "object",
    additionalProperties: false,
    required: ["scope_probabilities", "area_assessments", "evidence"],
    properties: {
      scope_probabilities: direct.properties.scope_probabilities,
      area_assessments: {
        type: "array",
        minItems: areaIds.length,
        maxItems: areaIds.length,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "area_id",
            "supporting_facts",
            "counterevidence",
            "probability_required"
          ],
          properties: {
            area_id: { type: "string", enum: areaIds },
            supporting_facts: {
              type: "array",
              maxItems: 3,
              items: { type: "string", maxLength: 240 }
            },
            counterevidence: {
              type: "array",
              maxItems: 3,
              items: { type: "string", maxLength: 240 }
            },
            probability_required: { type: "number", minimum: 0, maximum: 1 }
          }
        }
      },
      evidence: direct.properties.evidence
    }
  };
}

function responseSchema(strategy, areaIds) {
  if (strategy === "direct") return buildLunaDistributionalResponseSchema(areaIds);
  if (strategy === "evidence_first") return evidenceAssessmentSchema(areaIds);
  return independentAreaSchema(areaIds);
}

function requestFor({ episode, profile, cards, retrieval, strategy }) {
  const evidence = renderLunaPerformanceEvidence({
    retrieval,
    presentation: "eight_short",
    maximumCharacters: 6_000
  });
  const prompt = buildLunaPerformancePrompt({
    episode,
    profile,
    cards,
    evidence,
    presentation: "eight_short",
    inferenceStrategy: strategy,
    seed: 181081
  });
  const areaIds = cards.map((card) => card.areaId);
  return {
    messages: [
      { role: "system", content: prompt.system },
      { role: "user", content: prompt.user }
    ],
    reasoning_effort: "high",
    max_completion_tokens: 128_000,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: `routekit_${strategy}`,
        strict: true,
        schema: responseSchema(strategy, areaIds)
      }
    }
  };
}

const inventory = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  safeguards: {
    taskAwareContextOnly: true,
    labelsExcludedFromModelInputs: true,
    lockedTestDataIncluded: false,
    retrievalVariant: "hybrid_rerank",
    evidencePresentation: "eight_short",
    areaCardVariant: "enriched",
    reasoningEffort: "high",
    model: "openai/gpt-5.6-luna"
  },
  datasets: []
};

for (const datasetId of datasetIds) {
  const datasetRoot = path.join(assetRoot, "staging", datasetId);
  const manifest = JSON.parse(await readFile(path.join(datasetRoot, "dataset-manifest.json"), "utf8"));
  const episodes = await readJsonl(path.join(datasetRoot, "episodes.jsonl"));
  const labels = await readJsonl(path.join(datasetRoot, "labels.jsonl"));
  const labelsByTask = new Map(labels.map((label) => [label.taskEpisodeId, label]));
  const repositories = new Map();

  for (const repository of manifest.repositories) {
    const profile = JSON.parse(await readFile(path.join(datasetRoot, repository.profile), "utf8"));
    const baselineCards = await readJsonl(path.join(datasetRoot, repository.areas));
    repositories.set(repository.repositoryId, {
      profile,
      cards: buildEnrichedAreaCards({ cards: baselineCards })
    });
  }

  const tasks = [];
  for (const episode of episodes) {
    const repository = repositories.get(episode.repositoryId);
    if (!repository) throw new Error(`Missing repository metadata for ${episode.repositoryId}`);
    const retrieval = JSON.parse(
      await readFile(
        path.join(datasetRoot, "retrieval", "hybrid_rerank", `${episode.id}.json`),
        "utf8"
      )
    );
    const requests = Object.fromEntries(
      strategies.map((strategy) => [
        strategy,
        requestFor({
          episode,
          profile: repository.profile,
          cards: repository.cards,
          retrieval,
          strategy
        })
      ])
    );
    const taskInput = {
      schemaVersion: 1,
      datasetId,
      taskId: episode.id,
      repositoryId: episode.repositoryId,
      repositorySnapshot: episode.repositorySnapshot,
      requests
    };
    const file = path.join(outputRoot, datasetId, `${safeId(episode.id)}.json`);
    const { bytes, digest } = await writeJson(file, taskInput);
    const label = labelsByTask.get(episode.id);
    if (!label) throw new Error(`Missing label for ${episode.id}`);
    tasks.push({
      id: episode.id,
      file,
      digest,
      size: bytes.length,
      pathname: `inputs/${datasetId}/${safeId(episode.id)}/sha256/${digest.slice(0, 2)}/${digest}.json`,
      metadata: {
        expectedScope: scopeTargetForLabel(label),
        expectedAreas: label.known ? label.selectedAreaIds : []
      }
    });
  }
  inventory.datasets.push({
    id: datasetId,
    role: manifest.role,
    tasks
  });
}

const inventoryFile = path.join(outputRoot, "input-inventory.json");
await writeJson(inventoryFile, inventory);
console.log(
  JSON.stringify(
    {
      ok: true,
      inventoryFile,
      datasets: inventory.datasets.map((dataset) => ({
        id: dataset.id,
        role: dataset.role,
        tasks: dataset.tasks.length
      })),
      safeguards: inventory.safeguards
    },
    null,
    2
  )
);
