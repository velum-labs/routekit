import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const root = path.resolve(import.meta.dirname, "../../..");
export const assetRoot = path.join(
  root,
  ".routekit-experiment-assets/onboarding-optimization-20260819"
);
export const image =
  "routekit-experiment-runner@sha256:8fb5a47dbb6308c32742851e0d6aa1d661a78aec250a8521ed7faa4a3c094ac3";
export const seed = 181081;

export const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const safeId = (value) => value.toLowerCase().replaceAll(/[^a-z0-9._-]+/g, "-");
export const unique = (values) => [...new Set((values ?? []).filter(Boolean))];

export const stringArray = (maxItems, maxLength) => ({
  type: "array",
  maxItems,
  items: { type: "string", minLength: 1, maxLength }
});

export function registrySchema(minItems = 8, maxItems = minItems) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["areas"],
    properties: {
      areas: {
        type: "array",
        minItems,
        maxItems,
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
            inclusions: stringArray(10, 320),
            exclusions: stringArray(14, 420),
            confusable_area_ids: stringArray(10, 80),
            path_anchors: stringArray(10, 240),
            component_anchors: stringArray(10, 200),
            symbol_anchors: stringArray(10, 160),
            code_summaries: stringArray(8, 500),
            boundary_examples: stringArray(12, 500)
          }
        }
      }
    }
  };
}

export function neutralSchema() {
  return {
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
}

export function compositionSchema(cards) {
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

export function request(system, user, schema, name, reasoningEffort = "high") {
  return {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ],
    reasoning_effort: reasoningEffort,
    max_completion_tokens: 8192,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: name.replaceAll(/[^a-zA-Z0-9_-]/gu, "_").slice(0, 64),
        strict: true,
        schema
      }
    }
  };
}

export async function writeJson(file, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, bytes, { mode: 0o600 });
  return { bytes, digest: digest(bytes) };
}

export async function freezeDataset({
  directory,
  datasetId,
  role,
  tasks,
  safeguards,
  sourceHash,
  metadata = {}
}) {
  const manifestFile = path.join(directory, datasetId, "dataset-manifest.json");
  const manifestResult = await writeJson(manifestFile, {
    schemaVersion: 1,
    datasetId,
    generatedAt: "2026-08-19T00:00:00.000Z",
    role,
    sourceHash,
    counts: { tasks: tasks.length },
    safeguards,
    metadata,
    tasks: tasks.map(({ file: _file, ...task }) => task)
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
    tasks
  };
  const inventoryFile = path.join(directory, datasetId, "input-inventory.json");
  await writeJson(inventoryFile, inventory);
  return { inventoryFile, inventory };
}

export function normalizeCards(cards) {
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

export function responseObject(payload) {
  const response = payload?.result?.response ?? payload?.response ?? payload;
  const content = response?.choices?.[0]?.message?.content;
  if (typeof content === "string") return JSON.parse(content);
  if (Array.isArray(content)) {
    return JSON.parse(content.map((part) => part?.text ?? "").join(""));
  }
  throw new Error("hosted response has no JSON message content");
}

export const directSystem = [
  "You are a runtime classifier for coding tasks.",
  "Return exactly one strict JSON object and no prose outside it.",
  "Return area_composition_scores with every registered area exactly once, plus unknown_probability.",
  "Known-area scores are independent composition intensities and do not need to sum to one.",
  "unknown_probability separately estimates whether at least one material responsibility is not represented.",
  "Do not reduce known-area scores when unknown_probability is high.",
  "A dependency, mentioned path, shared type, or incidental API call is not by itself a material responsibility.",
  "Use only the supplied task-aware context and Area Registry.",
  "Score every area continuously: 0.00 none, 0.25 minor support, 0.50 substantial secondary, 0.75 major, 1.00 dominant.",
  "Intermediate values are allowed. Do not expose hidden chain-of-thought."
].join("\n");

export const mappingSystem = [
  "Map the frozen taxonomy-neutral responsibility decomposition into the supplied Area Registry.",
  "Do not reinterpret the task to fit the registry and do not discard uncovered work.",
  "Known-area scores independently estimate how materially each area must change.",
  "unknown_probability separately estimates material responsibility not represented by any area.",
  "Known-area scores do not need to sum to one and unknown must not renormalize them.",
  "Return exactly one strict JSON object and no prose."
].join("\n");

export function compositionRequest({ cards, tail, neutral, name, direct = false }) {
  return request(
    direct ? directSystem : mappingSystem,
    [
      "[FROZEN AREA REGISTRY]",
      JSON.stringify({ areas: cards }),
      ...(neutral
        ? ["", "[FROZEN TAXONOMY-NEUTRAL RESPONSIBILITIES]", JSON.stringify(neutral)]
        : []),
      "",
      tail
    ].join("\n"),
    compositionSchema(cards),
    name
  );
}

function git(repositoryPath, args, maxBuffer = 128 * 1024 * 1024) {
  return execFileSync("git", ["-C", repositoryPath, ...args], {
    encoding: "utf8",
    maxBuffer
  });
}

function topCounts(values, limit) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

function readGitFile(repositoryPath, commit, file, limit) {
  try {
    return git(repositoryPath, ["show", `${commit}:${file}`], 16 * 1024 * 1024).slice(0, limit);
  } catch {
    return undefined;
  }
}

export function repositoryStructure(repositoryPath, requestedCommit) {
  let commit = requestedCommit;
  try {
    git(repositoryPath, ["cat-file", "-e", `${commit}^{commit}`]);
  } catch {
    commit = git(repositoryPath, ["rev-parse", "HEAD"]).trim();
  }
  const files = git(repositoryPath, ["ls-tree", "-r", "--name-only", commit])
    .split("\n")
    .filter(Boolean);
  const extension = (file) => {
    const base = path.posix.basename(file);
    const index = base.lastIndexOf(".");
    return index <= 0 ? "(none)" : base.slice(index).toLowerCase();
  };
  const directory = (file) => {
    const parts = file.split("/");
    return parts.length === 1 ? "(root)" : parts.slice(0, Math.min(2, parts.length - 1)).join("/");
  };
  const manifestPattern =
    /(?:^|\/)(?:package\.json|pnpm-workspace\.yaml|go\.mod|Cargo\.toml|pyproject\.toml|requirements[^/]*\.txt|Gemfile|pom\.xml|build\.gradle(?:\.kts)?|BUILD(?:\.bazel)?|WORKSPACE)$/u;
  const manifests = files.filter((file) => manifestPattern.test(file)).slice(0, 120);
  const codeowners = files.find((file) => /(?:^|\/)CODEOWNERS$/u.test(file));
  const readme = files.find((file) => /(?:^|\/)README(?:\.[a-z0-9]+)?$/iu.test(file));
  return {
    requestedCommit,
    resolvedCommit: commit,
    fileCount: files.length,
    topDirectories: topCounts(files.map(directory), 50),
    topExtensions: topCounts(files.map(extension), 30),
    manifestPaths: manifests,
    codeownersPath: codeowners ?? null,
    codeownersExcerpt: codeowners ? readGitFile(repositoryPath, commit, codeowners, 8000) : null,
    readmePath: readme ?? null,
    readmeExcerpt: readme ? readGitFile(repositoryPath, commit, readme, 10_000) : null
  };
}

export function taskAwareTail(profile, task) {
  return [
    "[TASK-AWARE CONVERSATION AND REPOSITORY PROFILE]",
    "[REPOSITORY PROFILE]",
    JSON.stringify(profile),
    "",
    ...(task.taskAnchor ? ["[TASK ANCHOR]", task.taskAnchor, ""] : []),
    ...(task.earlierUserContext?.length
      ? ["[EARLIER USER CONTEXT]", ...task.earlierUserContext, ""]
      : []),
    ...(task.precedingAssistant ? ["[RECENT ASSISTANT CONTEXT]", task.precedingAssistant, ""] : []),
    ...(task.relevantDiagnostic ? ["[RELEVANT DIAGNOSTIC]", task.relevantDiagnostic, ""] : []),
    "[CURRENT REQUEST]",
    task.title ?? task.currentRequest ?? "",
    ...(task.body ? ["", task.body] : [])
  ].join("\n");
}

export async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}
