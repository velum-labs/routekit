#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const sourceInventoryFile = path.join(
  repositoryRoot,
  ".routekit-experiment-assets/composition-20260818/input-inventory.json"
);
const datasetId = "area-taxonomy-backstage-pilot-24-v1";
const outputRoot = path.join(repositoryRoot, ".routekit-experiment-assets/area-taxonomy-20260818");
const inputRoot = path.join(outputRoot, "inputs", datasetId);
const seed = 181081;

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const safeId = (value) => value.toLowerCase().replaceAll(/[^a-z0-9._-]+/g, "-");
const unique = (values) => [...new Set(values.filter(Boolean))];

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
            { type: "number", minimum: 0, maximum: 1 }
          ])
        )
      },
      unknown_probability: { type: "number", minimum: 0, maximum: 1 }
    }
  };
}

const neutralSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "responsibilities",
    "repository_scope",
    "insufficient_information_probability"
  ],
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
          affected_components: {
            type: "array",
            maxItems: 8,
            items: { type: "string", minLength: 1, maxLength: 200 }
          },
          evidence_refs: {
            type: "array",
            maxItems: 8,
            items: { type: "string", minLength: 1, maxLength: 300 }
          },
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

const neutralSystem = [
  "You are creating a taxonomy-neutral reference for a coding-task routing experiment.",
  "Identify the concrete implementation responsibilities required by the visible task.",
  "Do not invent or infer any repository Area Registry. No candidate area names are supplied.",
  "Each responsibility must be independently implementable and must not join separable work with 'and'.",
  "A dependency, mentioned file, or incidental API call is not itself a responsibility.",
  "Use materiality from 0.00 (incidental) through 1.00 (dominant).",
  "Use only the supplied task-aware context and repository evidence.",
  "Return exactly one strict JSON object and no prose. Do not expose hidden chain-of-thought."
].join("\n");

function requestFor({ modelKind, system, user, areaIds, schemaName }) {
  const schema = areaIds === undefined ? neutralSchema : compositionSchema(areaIds);
  return {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ],
    reasoning_effort: "high",
    max_completion_tokens: modelKind === "neutral" ? 8192 : 8192,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: schemaName,
        strict: true,
        schema
      }
    }
  };
}

function parseFrozenPrompt(user) {
  const prefix = "[FROZEN AREA REGISTRY]\n";
  const separator = "\n\n[TASK-AWARE CONVERSATION AND REPOSITORY PROFILE]";
  if (!user.startsWith(prefix)) throw new Error("source prompt has no frozen registry");
  const end = user.indexOf(separator);
  if (end < 0) throw new Error("source prompt has no task-context separator");
  const registry = JSON.parse(user.slice(prefix.length, end));
  const taskTail = user
    .slice(end + 2)
    .replace(
      /^components:.*$/mu,
      "components: (omitted to avoid candidate-taxonomy leakage)"
    );
  return { cards: registry.areas, taskTail };
}

function renderUser(cards, taskTail) {
  return [
    "[FROZEN AREA REGISTRY]",
    JSON.stringify({ areas: cards }),
    "",
    taskTail
  ].join("\n");
}

function projectCard(card, variant) {
  const identity = { area_id: card.area_id, name: card.name };
  const core = {
    ...identity,
    description: card.description,
    inclusions: card.inclusions ?? []
  };
  if (variant === "name_only") return identity;
  if (variant === "core") return core;
  if (variant === "core_boundaries") {
    return {
      ...core,
      exclusions: card.exclusions ?? [],
      confusable_area_ids: card.confusable_area_ids ?? [],
      boundary_examples: card.boundary_examples ?? []
    };
  }
  if (variant === "core_anchors") {
    return {
      ...core,
      path_anchors: card.path_anchors ?? [],
      component_anchors: card.component_anchors ?? [],
      symbol_anchors: card.symbol_anchors ?? []
    };
  }
  if (variant === "boundaries_anchors") {
    return {
      ...core,
      exclusions: card.exclusions ?? [],
      confusable_area_ids: card.confusable_area_ids ?? [],
      path_anchors: card.path_anchors ?? [],
      component_anchors: card.component_anchors ?? [],
      symbol_anchors: card.symbol_anchors ?? [],
      boundary_examples: card.boundary_examples ?? []
    };
  }
  return card;
}

function mapConfusable(cards, sourceToTarget) {
  return cards.map((card) => ({
    ...card,
    confusable_area_ids: unique(
      (card.confusable_area_ids ?? [])
        .map((id) => sourceToTarget.get(id))
        .filter((id) => id !== undefined && id !== card.area_id)
    )
  }));
}

function mergeCards(sourceCards, definitions) {
  const byId = new Map(sourceCards.map((card) => [card.area_id, card]));
  const sourceToTarget = new Map();
  for (const definition of definitions) {
    for (const sourceId of definition.sourceIds) sourceToTarget.set(sourceId, definition.areaId);
  }
  const merged = definitions.map((definition) => {
    const cards = definition.sourceIds.map((id) => {
      const card = byId.get(id);
      if (!card) throw new Error(`missing source area ${id}`);
      return card;
    });
    return {
      area_id: definition.areaId,
      name: definition.name,
      description: definition.description,
      inclusions: unique(cards.flatMap((card) => card.inclusions ?? [])),
      exclusions: unique(cards.flatMap((card) => card.exclusions ?? [])),
      confusable_area_ids: unique(
        cards.flatMap((card) =>
          (card.confusable_area_ids ?? [])
            .map((id) => sourceToTarget.get(id))
            .filter((id) => id !== undefined && id !== definition.areaId)
        )
      ),
      path_anchors: unique(cards.flatMap((card) => card.path_anchors ?? [])),
      component_anchors: unique(cards.flatMap((card) => card.component_anchors ?? [])),
      symbol_anchors: unique(cards.flatMap((card) => card.symbol_anchors ?? [])),
      code_summaries: unique(cards.flatMap((card) => card.code_summaries ?? [])),
      code_snippets: unique(cards.flatMap((card) => card.code_snippets ?? [])),
      boundary_examples: unique([
        ...cards.flatMap((card) => card.boundary_examples ?? []),
        `Treat ${definition.name} as one coarse routing area even when the task spans more than one of its underlying components.`
      ])
    };
  });
  return mapConfusable(merged, new Map(merged.map((card) => [card.area_id, card.area_id])));
}

function layerCards() {
  return [
    {
      area_id: "layer-frontend",
      name: "Frontend implementation layer",
      description:
        "Browser-facing React components, routes, pages, user interactions, and client-side state required by the task.",
      inclusions: ["React UI", "frontend routes", "browser interactions"],
      exclusions: ["Backend-only services", "documentation-only changes"],
      confusable_area_ids: ["layer-backend", "layer-shared-contracts"],
      path_anchors: ["plugins/*/src", "packages/core-components"],
      component_anchors: ["React", "frontend plugin"],
      symbol_anchors: [],
      code_summaries: [],
      code_snippets: [],
      boundary_examples: [
        "Activate with a domain area when the task materially changes that domain's browser-facing implementation."
      ]
    },
    {
      area_id: "layer-backend",
      name: "Backend implementation layer",
      description:
        "Node.js backend services, routers, processors, persistence, integrations, and server-side plugin behavior required by the task.",
      inclusions: ["backend services", "routers", "processors"],
      exclusions: ["Frontend-only presentation", "documentation-only changes"],
      confusable_area_ids: ["layer-frontend", "layer-shared-contracts"],
      path_anchors: ["plugins/*-backend", "packages/backend-*"],
      component_anchors: ["backend plugin", "service router"],
      symbol_anchors: [],
      code_summaries: [],
      code_snippets: [],
      boundary_examples: [
        "Activate with a domain area when the task materially changes that domain's server-side implementation."
      ]
    },
    {
      area_id: "layer-shared-contracts",
      name: "Shared contracts and platform interfaces",
      description:
        "Types, extension points, APIs, schemas, and shared contracts used across frontend and backend implementations.",
      inclusions: ["shared types", "extension APIs", "schemas"],
      exclusions: ["A shared type merely imported without behavior changes"],
      confusable_area_ids: ["layer-frontend", "layer-backend"],
      path_anchors: ["packages/*-common", "packages/core-plugin-api", "packages/backend-plugin-api"],
      component_anchors: ["shared API", "extension point"],
      symbol_anchors: [],
      code_summaries: [],
      code_snippets: [],
      boundary_examples: [
        "Activate only when the task changes the shared contract itself, not when one implementation merely consumes it."
      ]
    },
    {
      area_id: "layer-documentation",
      name: "Documentation layer",
      description:
        "Repository documentation, examples, migration guidance, and user-facing technical instructions required by the task.",
      inclusions: ["documentation", "examples", "migration guides"],
      exclusions: ["TechDocs product behavior implemented in code"],
      confusable_area_ids: ["layer-operational-tooling"],
      path_anchors: ["docs", "microsite"],
      component_anchors: ["documentation"],
      symbol_anchors: [],
      code_summaries: [],
      code_snippets: [],
      boundary_examples: [
        "Documentation about a feature activates this layer; implementing the TechDocs product activates the TechDocs domain."
      ]
    },
    {
      area_id: "layer-operational-tooling",
      name: "Operational and developer tooling layer",
      description:
        "Build, release, CI, repository tooling, local development, deployment, and operational automation required by the task.",
      inclusions: ["CI", "build tooling", "release automation"],
      exclusions: ["Kubernetes product integration shown to Backstage users"],
      confusable_area_ids: ["layer-documentation"],
      path_anchors: [".github", "packages/cli", "scripts"],
      component_anchors: ["CI", "CLI", "build"],
      symbol_anchors: [],
      code_summaries: [],
      code_snippets: [],
      boundary_examples: [
        "Deploying or building Backstage activates this layer; displaying Kubernetes resources inside Backstage activates the Kubernetes domain."
      ]
    }
  ];
}

function registryVariants(fullCards) {
  const byId = new Map(fullCards.map((card) => [card.area_id, card]));
  const coarse = mergeCards(fullCards, [
    {
      areaId: "metadata-discovery",
      name: "Metadata and discovery",
      description: "Catalog metadata, entity discovery, indexing, search, and result discovery.",
      sourceIds: ["catalog", "search"]
    },
    {
      areaId: "access-control",
      name: "Identity and access control",
      description: "Authentication, identity, permissions, authorization policy, and enforcement.",
      sourceIds: ["auth", "permission"]
    },
    {
      areaId: "creation-documentation-workflows",
      name: "Creation and documentation workflows",
      description: "Software templates, task execution, TechDocs generation, rendering, and publishing.",
      sourceIds: ["scaffolder", "techdocs"]
    },
    {
      areaId: "external-runtime-integrations",
      name: "External runtime integrations",
      description: "Kubernetes integration, cluster access, events, brokers, and external event delivery.",
      sourceIds: ["kubernetes", "events"]
    }
  ]);
  const disjoint = fullCards.map((card) => ({
    ...card,
    description: `${card.description} For this mutually exclusive registry, score this area only when it is the single primary owner of the requested implementation.`,
    exclusions: unique([
      ...(card.exclusions ?? []),
      ...fullCards
        .filter((other) => other.area_id !== card.area_id)
        .map(
          (other) =>
            `Do not co-activate with ${other.name}; choose whichever area owns the largest implementation responsibility.`
        )
    ]),
    boundary_examples: unique([
      ...(card.boundary_examples ?? []),
      "This experimental registry forces one primary area even when supporting work touches neighbors."
    ])
  }));
  const identityAccess = mergeCards(fullCards, [
    {
      areaId: "identity-access",
      name: "Identity and access",
      description:
        "Authentication, identity, permissions, authorization policy, and access enforcement. This intentionally overlaps the auth and permission areas.",
      sourceIds: ["auth", "permission"]
    }
  ])[0];
  const redundant = [...fullCards, identityAccess];
  const catalog = byId.get("catalog");
  if (!catalog) throw new Error("missing catalog card");
  const catalogChild = {
    ...catalog,
    area_id: "catalog-ingestion",
    name: "Catalog ingestion",
    description:
      "Entity ingestion, providers, processors, refresh, and discovery within the broader Software Catalog area.",
    inclusions: ["Entity providers", "Catalog processors", "Refresh and ingestion"],
    exclusions: ["Catalog presentation and generic entity reading"],
    confusable_area_ids: ["catalog"],
    path_anchors: ["plugins/catalog-backend", "packages/catalog-model"],
    component_anchors: ["catalog processor", "entity provider"],
    symbol_anchors: ["CatalogProcessor", "EntityProvider"],
    boundary_examples: [
      "Catalog ingestion is a child of Software Catalog and intentionally overlaps it in this diagnostic registry."
    ]
  };
  const parentChild = [
    ...fullCards.map((card) =>
      card.area_id === "catalog"
        ? {
            ...card,
            confusable_area_ids: unique([...(card.confusable_area_ids ?? []), "catalog-ingestion"])
          }
        : card
    ),
    catalogChild
  ];
  const coverage6 = fullCards.filter(
    (card) => card.area_id !== "kubernetes" && card.area_id !== "events"
  );
  const sharedExternal = mergeCards(fullCards, [
    {
      areaId: "external-integrations",
      name: "External integrations",
      description:
        "Positively defined integrations with Kubernetes clusters and external event systems.",
      sourceIds: ["kubernetes", "events"]
    }
  ])[0];
  const vagueOther = {
    area_id: "other",
    name: "Other repository work",
    description: "Any Backstage repository work not covered by the six named areas.",
    inclusions: ["Anything else"],
    exclusions: [],
    confusable_area_ids: coverage6.map((card) => card.area_id),
    path_anchors: [],
    component_anchors: [],
    symbol_anchors: [],
    code_summaries: [],
    code_snippets: [],
    boundary_examples: ["Use this area whenever no named area seems to fit."]
  };
  return {
    official8: fullCards,
    coarse4: coarse,
    factorized13: [...fullCards, ...layerCards()],
    disjoint8: disjoint,
    redundant9: redundant,
    parent_child9: parentChild,
    coverage6: coverage6,
    coverage7_shared: [...coverage6, sharedExternal],
    coverage7_other: [...coverage6, vagueOther]
  };
}

const sourceInventory = JSON.parse(await readFile(sourceInventoryFile, "utf8"));
const backstage = sourceInventory.tasks.filter(
  (task) => task.metadata.repositoryId === "backstage/backstage"
);
const real = backstage.filter((task) => task.metadata.cohort === "backstage_issue_real");
const syntheticByKind = Object.fromEntries(
  ["known_known", "known_unknown", "unknown_unknown"].map((kind) => [
    kind,
    backstage.filter((task) => task.metadata.syntheticKind === kind)
  ])
);
const screeningTasks = [
  ...real.slice(0, 16),
  ...syntheticByKind.known_known.slice(0, 4),
  ...syntheticByKind.known_unknown.slice(0, 2),
  ...syntheticByKind.unknown_unknown.slice(0, 2)
];
if (screeningTasks.length !== 24 || new Set(screeningTasks.map((task) => task.id)).size !== 24) {
  throw new Error("failed to select 24 unique Backstage screening tasks");
}
const canaryTaskIds = [
  ...real.slice(0, 4),
  ...syntheticByKind.known_known.slice(0, 2),
  ...syntheticByKind.known_unknown.slice(0, 2),
  ...syntheticByKind.unknown_unknown.slice(0, 2)
].map((task) => task.id);
const remainderTaskIds = screeningTasks
  .map((task) => task.id)
  .filter((taskId) => !canaryTaskIds.includes(taskId));

const officialCandidateVariants = [
  ["official8__luna_name_only", "name_only"],
  ["official8__luna_core", "core"],
  ["official8__luna_core_boundaries", "core_boundaries"],
  ["official8__luna_core_anchors", "core_anchors"],
  ["official8__luna_boundaries_anchors", "boundaries_anchors"],
  ["official8__luna_complete", "complete"]
];
const semanticGroups = [
  "coarse4",
  "factorized13",
  "disjoint8",
  "redundant9",
  "parent_child9",
  "coverage6",
  "coverage7_shared",
  "coverage7_other"
];
const treatmentDefinitions = [
  {
    id: "neutral_sol",
    model: "openai/gpt-5.6-sol",
    evaluationRole: "neutral_reference"
  },
  {
    id: "official8__sol",
    model: "openai/gpt-5.6-sol",
    evaluationRole: "composition_reference",
    comparisonGroup: "official8"
  },
  ...officialCandidateVariants.map(([id]) => ({
    id,
    model: "openai/gpt-5.6-luna",
    evaluationRole: "composition_candidate",
    comparisonGroup: "official8"
  })),
  ...semanticGroups.flatMap((comparisonGroup) => [
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
  ])
];

const tasks = [];
let sourceSystem;
for (const sourceTask of screeningTasks) {
  const sourceInput = JSON.parse(await readFile(sourceTask.file, "utf8"));
  const sourceRequest = sourceInput.requests.sol_reference;
  sourceSystem ??= sourceRequest.messages[0].content;
  const { cards: fullCards, taskTail } = parseFrozenPrompt(sourceRequest.messages[1].content);
  const registries = registryVariants(fullCards);
  const requests = {
    neutral_sol: requestFor({
      modelKind: "neutral",
      system: neutralSystem,
      user: taskTail,
      schemaName: "routekit_neutral_responsibilities"
    })
  };
  const officialAreaIds = registries.official8.map((card) => card.area_id);
  requests.official8__sol = requestFor({
    modelKind: "composition",
    system: sourceSystem,
    user: renderUser(registries.official8, taskTail),
    areaIds: officialAreaIds,
    schemaName: "routekit_taxonomy_official8_sol"
  });
  for (const [treatmentId, variant] of officialCandidateVariants) {
    const projected = registries.official8.map((card) => projectCard(card, variant));
    requests[treatmentId] = requestFor({
      modelKind: "composition",
      system: sourceSystem,
      user: renderUser(projected, taskTail),
      areaIds: officialAreaIds,
      schemaName: `routekit_taxonomy_${treatmentId.replaceAll(/[^a-z0-9_]/g, "_")}`
    });
  }
  for (const comparisonGroup of semanticGroups) {
    const cards = registries[comparisonGroup];
    const areaIds = cards.map((card) => card.area_id);
    for (const suffix of ["sol", "luna"]) {
      const treatmentId = `${comparisonGroup}__${suffix}`;
      requests[treatmentId] = requestFor({
        modelKind: "composition",
        system: sourceSystem,
        user: renderUser(cards, taskTail),
        areaIds,
        schemaName: `routekit_taxonomy_${treatmentId}`
      });
    }
  }
  const input = {
    schemaVersion: 1,
    datasetId,
    taskId: sourceTask.id,
    repositoryId: "backstage/backstage",
    repositorySnapshot: sourceInput.repositorySnapshot,
    requests
  };
  const file = path.join(inputRoot, `${safeId(sourceTask.id)}.json`);
  const { bytes, digest } = await writeJson(file, input);
  tasks.push({
    id: sourceTask.id,
    file,
    digest,
    size: bytes.length,
    pathname: `inputs/${datasetId}/${safeId(sourceTask.id)}/sha256/${digest.slice(
      0,
      2
    )}/${digest}.json`,
    metadata: sourceTask.metadata
  });
}

const validationBundleFile = path.join(outputRoot, "validation-bundle.json");
const validationBundle = {
  schemaVersion: 1,
  datasetId,
  tasks: await Promise.all(
    tasks.map(async (task) => ({
      id: task.id,
      digest: task.digest,
      input: JSON.parse(await readFile(task.file, "utf8"))
    }))
  )
};
const { bytes: validationBundleBytes, digest: validationBundleDigest } = await writeJson(
  validationBundleFile,
  validationBundle
);
const validationBundlePathname = `validation/${datasetId}/sha256/${validationBundleDigest.slice(
  0,
  2
)}/${validationBundleDigest}.json`;

const validatorFile = path.join(
  repositoryRoot,
  "apps/experiment-platform/cli/validate-area-taxonomy-bundle.mjs"
);
const validatorBytes = await readFile(validatorFile);
const validatorDigest = sha256(validatorBytes);
const validatorPathname = `validators/area-taxonomy-bundle-v1/sha256/${validatorDigest.slice(
  0,
  2
)}/${validatorDigest}.mjs`;

const datasetManifest = {
  schemaVersion: 1,
  datasetId,
  generatedAt: "2026-08-18T00:00:00.000Z",
  role: "development",
  sourceDatasetId: sourceInventory.datasetId,
  repositoryId: "backstage/backstage",
  counts: {
    total: tasks.length,
    real: tasks.filter((task) => task.metadata.cohort !== "synthetic_composite").length,
    synthetic: tasks.filter((task) => task.metadata.cohort === "synthetic_composite").length
  },
  canaryTaskIds,
  remainderTaskIds,
  treatmentDefinitions,
  safeguards: {
    taskAwareContextOnly: true,
    latestRequestOnlyRepresentationIncluded: false,
    sourceHardLabelsExcludedFromModelInputs: true,
    taxonomySpecificProfileComponentsRemoved: true,
    backstageLockedTestTasksIncluded: false,
    routekitLockedTestDataIncluded: false,
    inferenceExecutedDuringPreparation: false
  },
  validationBundle: {
    digest: validationBundleDigest,
    size: validationBundleBytes.length,
    pathname: validationBundlePathname
  },
  validator: {
    digest: validatorDigest,
    size: validatorBytes.length,
    pathname: validatorPathname
  },
  tasks: tasks.map(({ file: _file, ...task }) => task)
};
const datasetManifestFile = path.join(outputRoot, "dataset-manifest.json");
const { bytes: datasetManifestBytes, digest: datasetHash } = await writeJson(
  datasetManifestFile,
  datasetManifest
);
const datasetManifestPathname = `datasets/${datasetId}/sha256/${datasetHash.slice(
  0,
  2
)}/${datasetHash}.json`;

const inventoryFile = path.join(outputRoot, "input-inventory.json");
await writeJson(inventoryFile, {
  schemaVersion: 1,
  datasetId,
  datasetHash,
  datasetManifestFile,
  datasetManifestSize: datasetManifestBytes.length,
  datasetManifestPathname,
  validationBundleFile,
  validationBundleDigest,
  validationBundleSize: validationBundleBytes.length,
  validationBundlePathname,
  validatorFile,
  validatorDigest,
  validatorSize: validatorBytes.length,
  validatorPathname,
  canaryTaskIds,
  remainderTaskIds,
  treatmentDefinitions,
  tasks
});

console.log(
  JSON.stringify(
    {
      ok: true,
      datasetId,
      datasetHash,
      tasks: tasks.length,
      canaryTasks: canaryTaskIds.length,
      remainderTasks: remainderTaskIds.length,
      treatments: treatmentDefinitions.length,
      requests: tasks.length * treatmentDefinitions.length,
      validationBundleBytes: validationBundleBytes.length,
      safeguards: datasetManifest.safeguards
    },
    null,
    2
  )
);
