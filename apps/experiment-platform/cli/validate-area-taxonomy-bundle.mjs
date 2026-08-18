#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const startedAt = performance.now();
const inputPath = process.env.ROUTEKIT_EXPERIMENT_INPUT ?? process.argv[2];
const outputPath = process.env.ROUTEKIT_EXPERIMENT_OUTPUT ?? process.argv[3];
if (!inputPath) throw new Error("ROUTEKIT_EXPERIMENT_INPUT or an input path is required");

const bundleBytes = await readFile(inputPath);
const bundle = JSON.parse(bundleBytes.toString("utf8"));
if (bundle.schemaVersion !== 1) throw new Error("unsupported taxonomy bundle schema");
if (!Array.isArray(bundle.tasks) || bundle.tasks.length === 0) {
  throw new Error("taxonomy bundle has no tasks");
}

const groupAreas = new Map();
let requestCount = 0;
let compositionRequestCount = 0;
let neutralRequestCount = 0;
const treatmentIds = new Set();

function exactAreaIdsFromSchema(request, treatmentId) {
  const schema = request?.response_format?.json_schema?.schema;
  const scores = schema?.properties?.area_composition_scores;
  if (
    schema?.type !== "object" ||
    !Array.isArray(schema.required) ||
    !schema.required.includes("area_composition_scores") ||
    !schema.required.includes("unknown_probability") ||
    scores?.type !== "object" ||
    !Array.isArray(scores.required)
  ) {
    throw new Error(`${treatmentId} has an invalid composition response schema`);
  }
  return [...scores.required].sort();
}

function registryAreaIds(user, treatmentId) {
  const prefix = "[FROZEN AREA REGISTRY]\n";
  const separator = "\n\n[TASK-AWARE CONVERSATION AND REPOSITORY PROFILE]";
  if (!user.startsWith(prefix)) throw new Error(`${treatmentId} has no registry marker`);
  const end = user.indexOf(separator);
  if (end < 0) throw new Error(`${treatmentId} has no task-context separator`);
  const registry = JSON.parse(user.slice(prefix.length, end));
  if (!Array.isArray(registry.areas) || registry.areas.length === 0) {
    throw new Error(`${treatmentId} has no registry areas`);
  }
  const ids = registry.areas.map((area) => area.area_id);
  if (ids.some((id) => typeof id !== "string" || id.length === 0)) {
    throw new Error(`${treatmentId} has an invalid area ID`);
  }
  if (new Set(ids).size !== ids.length) throw new Error(`${treatmentId} repeats an area ID`);
  return ids.sort();
}

for (const task of bundle.tasks) {
  if (typeof task.id !== "string" || typeof task.digest !== "string") {
    throw new Error("taxonomy bundle contains invalid task metadata");
  }
  const serialized = `${JSON.stringify(task.input, null, 2)}\n`;
  const digest = createHash("sha256").update(serialized).digest("hex");
  if (digest !== task.digest) throw new Error(`task digest mismatch for ${task.id}`);
  const requests = task.input?.requests;
  if (typeof requests !== "object" || requests === null || Array.isArray(requests)) {
    throw new Error(`task ${task.id} has no treatment requests`);
  }
  for (const [treatmentId, request] of Object.entries(requests)) {
    requestCount += 1;
    treatmentIds.add(treatmentId);
    if (!Array.isArray(request?.messages) || request.messages.length !== 2) {
      throw new Error(`${task.id}/${treatmentId} must have one system and one user message`);
    }
    const system = request.messages[0];
    const user = request.messages[1];
    if (system.role !== "system" || user.role !== "user") {
      throw new Error(`${task.id}/${treatmentId} has invalid message roles`);
    }
    if (treatmentId === "neutral_sol") {
      neutralRequestCount += 1;
      if (user.content.includes("[FROZEN AREA REGISTRY]")) {
        throw new Error(`${task.id}/neutral_sol leaked an Area Registry`);
      }
      const schema = request?.response_format?.json_schema?.schema;
      if (!schema?.properties?.responsibilities) {
        throw new Error(`${task.id}/neutral_sol has no responsibility schema`);
      }
      continue;
    }
    compositionRequestCount += 1;
    if (!user.content.includes("components: (omitted to avoid candidate-taxonomy leakage)")) {
      throw new Error(`${task.id}/${treatmentId} retained taxonomy-specific profile components`);
    }
    if (
      user.content.includes("selectedAreaIds") ||
      user.content.includes("samplingAreaId") ||
      user.content.includes("area_composition_scores\":")
    ) {
      throw new Error(`${task.id}/${treatmentId} appears to contain reference-label leakage`);
    }
    const registryIds = registryAreaIds(user.content, treatmentId);
    const schemaIds = exactAreaIdsFromSchema(request, treatmentId);
    if (JSON.stringify(registryIds) !== JSON.stringify(schemaIds)) {
      throw new Error(`${task.id}/${treatmentId} registry/schema area IDs differ`);
    }
    const group = treatmentId.includes("__") ? treatmentId.split("__", 1)[0] : treatmentId;
    const previous = groupAreas.get(group);
    if (previous && JSON.stringify(previous) !== JSON.stringify(registryIds)) {
      throw new Error(`${group} changes area IDs across tasks or treatments`);
    }
    groupAreas.set(group, registryIds);
  }
}

if (neutralRequestCount !== bundle.tasks.length) {
  throw new Error("every task must contain exactly one neutral responsibility request");
}

const output = {
  schemaVersion: 1,
  ok: true,
  datasetId: bundle.datasetId,
  tasks: bundle.tasks.length,
  treatments: treatmentIds.size,
  requests: requestCount,
  neutralRequests: neutralRequestCount,
  compositionRequests: compositionRequestCount,
  groups: Object.fromEntries(
    [...groupAreas.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([group, areaIds]) => [group, { areaCount: areaIds.length, areaIds }])
  ),
  bundleBytes: bundleBytes.byteLength,
  validationMs: Math.round(performance.now() - startedAt)
};

const serializedOutput = `${JSON.stringify(output, null, 2)}\n`;
if (outputPath) await writeFile(outputPath, serializedOutput);
process.stdout.write(serializedOutput);
