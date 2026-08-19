#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  readJsonArtifact,
  VercelBlobArtifactStore
} from "@velum-labs/routekit-eval-store/platform";

const root = path.resolve(import.meta.dirname, "../../..");
const sourceInventoryFile = path.join(
  root,
  ".routekit-experiment-assets/composition-20260818/input-inventory.json"
);
const outputRoot = path.join(
  root,
  ".routekit-experiment-assets/onboarding-followups-20260819/evaluations"
);
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
const unique = (values) => [...new Set(values.filter(Boolean))];

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
  const status = snapshot.experiment?.status;
  const usableBudgetFailure =
    status === "failed" &&
    snapshot.experiment?.error === "actual provider cost exceeded its budget";
  if (status !== "completed" && !usableBudgetFailure) {
    throw new Error(`${experimentId} is ${status}, not completed`);
  }
  return snapshot;
}

async function outputsByTask(snapshot) {
  const store = new VercelBlobArtifactStore();
  const entries = await Promise.all(
    snapshot.jobs.map(async (record) => [
      `${record.job.taskId}:${record.job.treatmentId}`,
      responseObject(await readJsonArtifact(store, record.outputArtifact))
    ])
  );
  return new Map(entries);
}

function parseSourcePrompt(user) {
  const prefix = "[FROZEN AREA REGISTRY]\n";
  const marker = "\n\n[TASK-AWARE CONVERSATION AND REPOSITORY PROFILE]";
  const end = user.indexOf(marker);
  if (!user.startsWith(prefix) || end < 0) throw new Error("invalid source prompt");
  return {
    cards: JSON.parse(user.slice(prefix.length, end)).areas,
    tail: user
      .slice(end + 2)
      .replace(/^components:.*$/mu, "components: (omitted to avoid taxonomy leakage)")
  };
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

function request(model, system, user, cards, name) {
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

function directRequest(model, system, tail, cards, treatmentId) {
  return request(
    model,
    system,
    ["[FROZEN AREA REGISTRY]", JSON.stringify({ areas: cards }), "", tail].join("\n"),
    cards,
    treatmentId
  );
}

const mappingSystem = [
  "Map a frozen taxonomy-neutral responsibility decomposition into the supplied Area Registry.",
  "Do not reinterpret the task to fit the registry and do not discard an uncovered responsibility.",
  "Known-area scores independently estimate how materially each area must change.",
  "unknown_probability separately estimates material responsibility not represented by any area.",
  "Known-area scores do not need to sum to one and unknown must not renormalize them.",
  "Return exactly one strict JSON object and no prose."
].join("\n");

function mappingRequest(tail, cards, neutral, treatmentId) {
  return request(
    "openai/gpt-5.6-sol",
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

function normalizeCards(cards) {
  const normalized = cards.map((card, index) => ({
    area_id: safeId(card.area_id || card.name || `area-${index + 1}`),
    name: card.name || card.area_id || `Area ${index + 1}`,
    description: card.description || card.activation_rule || "Repository responsibility.",
    inclusions: unique(card.inclusions ?? []),
    exclusions: unique(card.exclusions ?? []),
    confusable_area_ids: unique(card.confusable_area_ids ?? []),
    path_anchors: unique(card.path_anchors ?? []),
    component_anchors: unique(card.component_anchors ?? []),
    symbol_anchors: unique(card.symbol_anchors ?? []),
    code_summaries: unique(card.code_summaries ?? []),
    code_snippets: unique(card.code_snippets ?? []),
    boundary_examples: unique(card.boundary_examples ?? [])
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

function mergeCards(cards, groups) {
  return normalizeCards(
    groups.map(({ id, name, indexes }) => {
      const selected = indexes.map((index) => cards[index]);
      return {
        area_id: id,
        name,
        description: selected.map((card) => card.description).join(" "),
        inclusions: selected.flatMap((card) => card.inclusions),
        exclusions: selected.flatMap((card) => card.exclusions),
        path_anchors: selected.flatMap((card) => card.path_anchors),
        component_anchors: selected.flatMap((card) => card.component_anchors),
        symbol_anchors: selected.flatMap((card) => card.symbol_anchors),
        code_summaries: selected.flatMap((card) => card.code_summaries),
        code_snippets: selected.flatMap((card) => card.code_snippets),
        boundary_examples: selected.flatMap((card) => card.boundary_examples)
      };
    })
  );
}

function coarse4(cards) {
  return mergeCards(
    cards,
    [0, 1, 2, 3].map((index) => ({
      id: `coarse-${index + 1}`,
      name: `${cards[index * 2].name} and ${cards[index * 2 + 1].name}`,
      indexes: [index * 2, index * 2 + 1]
    }))
  );
}

function splitCard(card, mode) {
  const midpoint = Math.max(1, Math.ceil(card.inclusions.length / 2));
  const left = card.inclusions.slice(0, midpoint);
  const right = card.inclusions.slice(midpoint);
  const first = {
    ...card,
    area_id: `${card.area_id}-core`,
    name: `${card.name}: core behavior`,
    description: `Core domain behavior within ${card.name}. ${card.description}`,
    inclusions: left.length > 0 ? left : card.inclusions,
    exclusions: unique([
      ...card.exclusions,
      `Interfaces, integrations, or presentation work in ${card.name} without a core behavior change.`
    ])
  };
  const second = {
    ...card,
    area_id: `${card.area_id}-interfaces`,
    name: `${card.name}: interfaces and integrations`,
    description: `Interfaces, integrations, presentation, and external touchpoints within ${card.name}.`,
    inclusions: right.length > 0 ? right : card.component_anchors,
    exclusions: unique([
      ...card.exclusions,
      `Internal core behavior in ${card.name} without an interface or integration change.`
    ])
  };
  if (mode === "child") {
    return {
      ...second,
      area_id: `${card.area_id}-specialized`,
      name: `${card.name}: specialized subarea`,
      description: `A deliberately explicit child responsibility inside ${card.name}. ${second.description}`
    };
  }
  return [first, second];
}

function leafCut(cards, splitCount) {
  return normalizeCards(
    cards.flatMap((card, index) => (index < splitCount ? splitCard(card, "leaf") : [card]))
  );
}

function parentChild(cards, childCount) {
  return normalizeCards([
    ...cards,
    ...cards.slice(0, childCount).map((card) => splitCard(card, "child"))
  ]);
}

function disjoint(cards) {
  return normalizeCards(
    cards.map((card) => ({
      ...card,
      description: `${card.description} In this control registry, activate only the single primary owner.`,
      exclusions: unique([
        ...card.exclusions,
        "Do not co-activate this area with another area; select only the largest responsibility."
      ])
    }))
  );
}

const layers = [
  ["layer-frontend", "Frontend and user experience"],
  ["layer-backend", "Backend services and runtime behavior"],
  ["layer-contracts", "Shared contracts, APIs, and schemas"],
  ["layer-documentation", "Documentation and examples"],
  ["layer-tooling", "Build, release, operations, and developer tooling"]
].map(([area_id, name]) => ({
  area_id,
  name,
  description: `${name} required by the task, scored independently from product-domain areas.`,
  inclusions: [name],
  exclusions: ["Incidental use of this layer without a material implementation change"],
  confusable_area_ids: [],
  path_anchors: [],
  component_anchors: [],
  symbol_anchors: [],
  code_summaries: [],
  code_snippets: [],
  boundary_examples: [
    "Activate with a domain area only when both responsibilities materially change."
  ]
}));

function commonRegistries(cards) {
  const alias = {
    ...cards[0],
    area_id: `${cards[0].area_id}-alias`,
    name: `${cards[0].name} duplicate`,
    description: `An intentionally redundant alias of ${cards[0].name}. ${cards[0].description}`
  };
  return {
    common_official8: cards,
    common_coarse4: coarse4(cards),
    common_parent_child9: parentChild(cards, 1),
    common_redundant9: normalizeCards([...cards, alias]),
    common_factorized13: normalizeCards([...cards, ...layers])
  };
}

const omittedByRepository = {
  "backstage/backstage": ["events", "kubernetes"],
  "kubernetes/kubernetes": ["scheduling", "storage"],
  "grafana/grafana": ["plugins", "visualization-ui"]
};

function unknownRegistries(repositoryId, cards) {
  const omitted = new Set(omittedByRepository[repositoryId]);
  const covered = cards.filter((card) => !omitted.has(card.area_id));
  const removed = cards.filter((card) => omitted.has(card.area_id));
  const other = {
    area_id: "other",
    name: "Other repository work",
    description: "Any repository work not covered by the named areas.",
    inclusions: ["Anything else"],
    exclusions: [],
    confusable_area_ids: covered.map((card) => card.area_id),
    path_anchors: [],
    component_anchors: [],
    symbol_anchors: [],
    code_summaries: [],
    code_snippets: [],
    boundary_examples: ["Use whenever no named area seems to fit."]
  };
  const shared = mergeCards(removed, [
    {
      id: "shared-specialized-systems",
      name: "Specialized repository systems",
      indexes: removed.map((_, index) => index)
    }
  ])[0];
  return {
    unknown_separate: normalizeCards(covered),
    unknown_other: normalizeCards([...covered, other]),
    unknown_shared: normalizeCards([...covered, shared])
  };
}

function projectCard(card, variant) {
  const core = {
    area_id: card.area_id,
    name: card.name,
    description: card.description,
    inclusions: card.inclusions
  };
  if (variant === "summaries") return { ...core, code_summaries: card.code_summaries };
  if (variant === "snippets") return { ...core, code_snippets: card.code_snippets };
  if (variant === "one_anchor") {
    return {
      ...core,
      path_anchors: card.path_anchors.slice(0, 1),
      symbol_anchors: card.symbol_anchors.slice(0, 1)
    };
  }
  if (variant === "three_anchors") {
    return {
      ...core,
      path_anchors: card.path_anchors.slice(0, 3),
      symbol_anchors: card.symbol_anchors.slice(0, 3)
    };
  }
  if (variant === "positive") {
    return {
      ...core,
      positive_examples: card.inclusions.map((item) => `A task that materially changes ${item}.`)
    };
  }
  if (variant === "positive_negative") {
    return {
      ...core,
      positive_examples: card.inclusions.map((item) => `A task that materially changes ${item}.`),
      exclusions: card.exclusions,
      boundary_examples: card.boundary_examples
    };
  }
  return card;
}

function gitFiles(repositoryId) {
  let args;
  let commit;
  if (repositoryId === "backstage/backstage") {
    const directory = "/tmp/backstage-onboarding.git";
    commit = execFileSync("git", ["-C", directory, "rev-parse", "HEAD"], {
      encoding: "utf8"
    }).trim();
    args = ["-C", directory];
  } else {
    const name = repositoryId.replace("/", "-");
    const directory = path.join(
      root,
      `.routekit-experiment-assets/coding-router-20260817/staging/${name}-snapshots.git`
    );
    const inventory = JSON.parse(
      execFileSync("cat", [path.join(directory, "routekit-snapshots.json")], {
        encoding: "utf8"
      })
    );
    commit = inventory.snapshots[0];
    args = [`--git-dir=${directory}`];
  }
  const files = execFileSync("git", [...args, "ls-tree", "-r", "--name-only", commit], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  })
    .split("\n")
    .filter((file) => /\.(?:go|ts|tsx|js|jsx)$/u.test(file));
  return { args, commit, files };
}

function addSnippets(repositoryId, cards) {
  const repository = gitFiles(repositoryId);
  return cards.map((card) => {
    const prefixes = card.path_anchors.map((anchor) =>
      anchor.replaceAll("*", "").replace(/^\/+/u, "")
    );
    const words = `${card.area_id} ${card.name}`
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .filter((word) => word.length >= 4);
    const file =
      repository.files.find((candidate) =>
        prefixes.some((prefix) => candidate.startsWith(prefix))
      ) ??
      repository.files.find((candidate) =>
        words.some((word) => candidate.toLowerCase().includes(word))
      );
    if (!file) return card;
    let source = "";
    try {
      source = execFileSync("git", [...repository.args, "show", `${repository.commit}:${file}`], {
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        timeout: 30_000
      });
    } catch {}
    const excerpt = source.split("\n").slice(0, 24).join("\n").slice(0, 1800);
    return {
      ...card,
      code_snippets: excerpt.length > 0 ? [`Path: ${file}\n${excerpt}`] : []
    };
  });
}

async function freezeDataset(datasetId, tasks, treatmentDefinitions, safeguards) {
  const frozenTasks = [];
  for (const task of tasks) {
    const file = path.join(outputRoot, datasetId, "inputs", `${safeId(task.id)}.json`);
    const result = await writeJson(file, task.input);
    frozenTasks.push({
      id: task.id,
      file,
      digest: result.digest,
      size: result.bytes.length,
      pathname: `inputs/${datasetId}/${safeId(task.id)}/sha256/${result.digest.slice(
        0,
        2
      )}/${result.digest}.json`,
      metadata: task.metadata
    });
  }
  const manifestFile = path.join(outputRoot, datasetId, "dataset-manifest.json");
  const manifestResult = await writeJson(manifestFile, {
    schemaVersion: 1,
    datasetId,
    generatedAt: "2026-08-19T00:00:00.000Z",
    role: "development",
    counts: { tasks: frozenTasks.length, treatments: treatmentDefinitions.length },
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
  return { inventoryFile, inventory };
}

const [neutralSnapshot, generationSnapshot] = await Promise.all([
  completedExperiment("onboarding-neutral-responsibilities-100-v1"),
  completedExperiment("onboarding-registry-generation-3-v1")
]);
const [neutralOutputs, generationOutputs] = await Promise.all([
  outputsByTask(neutralSnapshot),
  outputsByTask(generationSnapshot)
]);

const generatedRegistries = new Map();
for (const task of generationSnapshot.experiment.manifest.tasks) {
  const repositoryId = task.metadata.repositoryId;
  generatedRegistries.set(repositoryId, {
    auto_unconstrained: normalizeCards(
      generationOutputs.get(`${task.id}:auto_unconstrained_sol`).areas
    ),
    auto_rules: normalizeCards(generationOutputs.get(`${task.id}:auto_rules_sol`).areas)
  });
}

const sourceInventory = JSON.parse(await readFile(sourceInventoryFile, "utf8"));
const sourceTasks = [];
const cardsWithSnippets = new Map();
for (const sourceTask of sourceInventory.tasks) {
  const sourceInput = JSON.parse(await readFile(sourceTask.file, "utf8"));
  const sourceRequest = sourceInput.requests.sol_reference;
  const parsed = parseSourcePrompt(sourceRequest.messages[1].content);
  const cards = normalizeCards(parsed.cards);
  if (!cardsWithSnippets.has(sourceTask.metadata.repositoryId)) {
    cardsWithSnippets.set(
      sourceTask.metadata.repositoryId,
      addSnippets(sourceTask.metadata.repositoryId, cards)
    );
  }
  sourceTasks.push({
    id: sourceTask.id,
    metadata: sourceTask.metadata,
    repositorySnapshot: sourceInput.repositorySnapshot,
    system: sourceRequest.messages[0].content,
    tail: parsed.tail,
    cards,
    neutral: neutralOutputs.get(`${sourceTask.id}:neutral_sol`)
  });
}

const definition = (id, model, role, comparisonGroup) => ({
  id,
  model,
  evaluationRole: role,
  ...(comparisonGroup ? { comparisonGroup } : {})
});
const pairedDefinitions = (groups) =>
  groups.flatMap((group) => [
    definition(`${group}__sol`, "openai/gpt-5.6-sol", "composition_reference", group),
    definition(`${group}__luna`, "openai/gpt-5.6-luna", "composition_candidate", group)
  ]);

const commonGroups = [
  "common_official8",
  "common_coarse4",
  "common_parent_child9",
  "common_redundant9",
  "common_factorized13"
];
const commonDefinitions = pairedDefinitions(commonGroups);
const commonTasks = sourceTasks
  .filter((task) => task.metadata.repositoryId === "backstage/backstage")
  .map((task) => {
    const registries = commonRegistries(task.cards);
    const requests = {};
    for (const group of commonGroups) {
      requests[`${group}__sol`] = mappingRequest(
        task.tail,
        registries[group],
        task.neutral,
        `${group}__sol`
      );
      requests[`${group}__luna`] = directRequest(
        "openai/gpt-5.6-luna",
        task.system,
        task.tail,
        registries[group],
        `${group}__luna`
      );
    }
    return {
      id: task.id,
      metadata: task.metadata,
      input: {
        schemaVersion: 1,
        datasetId: "onboarding-common-reference-backstage-60-v1",
        taskId: task.id,
        repositoryId: task.metadata.repositoryId,
        repositorySnapshot: task.repositorySnapshot,
        requests
      }
    };
  });

const unknownGroups = ["unknown_separate", "unknown_other", "unknown_shared"];
const unknownDefinitions = pairedDefinitions(unknownGroups);
const realByRepository = new Map();
for (const task of sourceTasks.filter((entry) => entry.metadata.cohort !== "synthetic_composite")) {
  const values = realByRepository.get(task.metadata.repositoryId) ?? [];
  values.push(task);
  realByRepository.set(task.metadata.repositoryId, values);
}
const unknownSelected = [
  ...sourceTasks.filter((task) => task.metadata.cohort === "synthetic_composite"),
  ...[...realByRepository.values()].flatMap((tasks) => tasks.slice(0, 6))
];
const unknownTasks = unknownSelected.map((task) => {
  const registries = unknownRegistries(task.metadata.repositoryId, task.cards);
  const requests = {};
  for (const group of unknownGroups) {
    requests[`${group}__sol`] = mappingRequest(
      task.tail,
      registries[group],
      task.neutral,
      `${group}__sol`
    );
    requests[`${group}__luna`] = directRequest(
      "openai/gpt-5.6-luna",
      task.system,
      task.tail,
      registries[group],
      `${group}__luna`
    );
  }
  const target = {
    known_known: 0,
    known_unknown: 0.5,
    unknown_unknown: 1
  }[task.metadata.syntheticKind];
  return {
    id: task.id,
    metadata: { ...task.metadata, expectedUnknownTarget: target ?? null },
    input: {
      schemaVersion: 1,
      datasetId: "onboarding-unknown-benchmark-60-v1",
      taskId: task.id,
      repositoryId: task.metadata.repositoryId,
      repositorySnapshot: task.repositorySnapshot,
      requests
    }
  };
});

const structureGroups = [
  "structure_k4",
  "structure_k8_controlled",
  "structure_k12_leaf",
  "structure_k16_leaf",
  "structure_disjoint8",
  "structure_parent_child12",
  "structure_parent_child16"
];
const structureDefinitions = pairedDefinitions(structureGroups);
const structureTasks = sourceTasks.map((task) => {
  const registries = {
    structure_k4: coarse4(task.cards),
    structure_k8_controlled: task.cards,
    structure_k12_leaf: leafCut(task.cards, 4),
    structure_k16_leaf: leafCut(task.cards, 8),
    structure_disjoint8: disjoint(task.cards),
    structure_parent_child12: parentChild(task.cards, 4),
    structure_parent_child16: parentChild(task.cards, 8)
  };
  const requests = {};
  for (const group of structureGroups) {
    requests[`${group}__sol`] = mappingRequest(
      task.tail,
      registries[group],
      task.neutral,
      `${group}__sol`
    );
    requests[`${group}__luna`] = directRequest(
      "openai/gpt-5.6-luna",
      task.system,
      task.tail,
      registries[group],
      `${group}__luna`
    );
  }
  return {
    id: task.id,
    metadata: task.metadata,
    input: {
      schemaVersion: 1,
      datasetId: "onboarding-structure-matrix-100-v1",
      taskId: task.id,
      repositoryId: task.metadata.repositoryId,
      repositorySnapshot: task.repositorySnapshot,
      requests
    }
  };
});

const cardVariants = [
  "summaries",
  "snippets",
  "one_anchor",
  "three_anchors",
  "positive",
  "positive_negative",
  "complete",
  "complete_snippets"
];
const cardDefinitions = [
  definition("card_reference_sol", "openai/gpt-5.6-sol", "composition_reference", "cards"),
  ...cardVariants.map((variant) =>
    definition(`card_${variant}__luna`, "openai/gpt-5.6-luna", "composition_candidate", "cards")
  )
];
const cardTasks = sourceTasks.map((task) => {
  const snippetCards = cardsWithSnippets.get(task.metadata.repositoryId);
  const requests = {
    card_reference_sol: mappingRequest(task.tail, task.cards, task.neutral, "card_reference_sol")
  };
  for (const variant of cardVariants) {
    let cards;
    if (variant === "complete") cards = task.cards;
    else if (variant === "complete_snippets") cards = snippetCards;
    else {
      const source = variant === "snippets" ? snippetCards : task.cards;
      cards = source.map((card) => projectCard(card, variant));
    }
    requests[`card_${variant}__luna`] = directRequest(
      "openai/gpt-5.6-luna",
      task.system,
      task.tail,
      cards,
      `card_${variant}__luna`
    );
  }
  return {
    id: task.id,
    metadata: {
      ...task.metadata,
      snippetCards: snippetCards.filter((card) => card.code_snippets.length > 0).length
    },
    input: {
      schemaVersion: 1,
      datasetId: "onboarding-area-card-ablation-100-v1",
      taskId: task.id,
      repositoryId: task.metadata.repositoryId,
      repositorySnapshot: task.repositorySnapshot,
      requests
    }
  };
});

const onboardingGroups = ["onboarding_unconstrained", "onboarding_rules", "onboarding_human"];
const onboardingDefinitions = pairedDefinitions(onboardingGroups);
const onboardingTasks = sourceTasks
  .filter((task) => task.metadata.cohort !== "synthetic_composite")
  .map((task) => {
    const generated = generatedRegistries.get(task.metadata.repositoryId);
    const registries = {
      onboarding_unconstrained: generated.auto_unconstrained,
      onboarding_rules: generated.auto_rules,
      onboarding_human: task.cards
    };
    const requests = {};
    for (const group of onboardingGroups) {
      requests[`${group}__sol`] = mappingRequest(
        task.tail,
        registries[group],
        task.neutral,
        `${group}__sol`
      );
      requests[`${group}__luna`] = directRequest(
        "openai/gpt-5.6-luna",
        task.system,
        task.tail,
        registries[group],
        `${group}__luna`
      );
    }
    return {
      id: task.id,
      metadata: task.metadata,
      input: {
        schemaVersion: 1,
        datasetId: "onboarding-generation-comparison-real-58-v1",
        taskId: task.id,
        repositoryId: task.metadata.repositoryId,
        repositorySnapshot: task.repositorySnapshot,
        requests
      }
    };
  });

const datasets = await Promise.all([
  freezeDataset("onboarding-common-reference-backstage-60-v1", commonTasks, commonDefinitions, {
    commonNeutralReferenceFrozen: true,
    taskAwareContextOnly: true,
    lockedTestIncluded: false
  }),
  freezeDataset("onboarding-unknown-benchmark-60-v1", unknownTasks, unknownDefinitions, {
    syntheticStrataTargetsPreserved: true,
    realTasksReportedSeparately: true,
    lockedTestIncluded: false
  }),
  freezeDataset("onboarding-structure-matrix-100-v1", structureTasks, structureDefinitions, {
    fixedCompleteCards: true,
    taskAwareContextOnly: true,
    lockedTestIncluded: false
  }),
  freezeDataset("onboarding-area-card-ablation-100-v1", cardTasks, cardDefinitions, {
    fixedHumanRegistrySemantics: true,
    actualRepositorySnippetsUsed: true,
    lockedTestIncluded: false
  }),
  freezeDataset(
    "onboarding-generation-comparison-real-58-v1",
    onboardingTasks,
    onboardingDefinitions,
    {
      realTasksOnly: true,
      generatedRegistriesFrozenBeforeEvaluation: true,
      lockedTestIncluded: false
    }
  )
]);

console.log(
  JSON.stringify(
    {
      ok: true,
      datasets: datasets.map(({ inventoryFile, inventory }) => ({
        inventoryFile,
        datasetId: inventory.datasetId,
        datasetHash: inventory.datasetHash,
        tasks: inventory.tasks.length,
        treatments: inventory.treatmentDefinitions.length,
        jobs: inventory.tasks.length * inventory.treatmentDefinitions.length
      }))
    },
    null,
    2
  )
);
