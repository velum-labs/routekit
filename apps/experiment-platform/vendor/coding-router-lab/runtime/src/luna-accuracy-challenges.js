import { contentHash } from "./hash.js";
import { DEFAULT_LUNA_ACCURACY_FIXED_SEED_LIST, } from "./luna-accuracy-context.js";
import { validateLunaAccuracyFreezeRecord, } from "./luna-accuracy-design.js";
import { validateAreaCards, validateEpisodes, validateSilverLabels, } from "./validation.js";
export const LUNA_COUNTERFACTUAL_SPECIFICATION_VERSION = "luna-counterfactual-challenges-v1";
const lexicalCompare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const runtimeEpisodeProjection = (source, id, changes) => ({
    schemaVersion: 1,
    id,
    repositoryId: source.repositoryId,
    repositorySnapshot: source.repositorySnapshot,
    sessionHash: source.sessionHash,
    lineageHash: source.lineageHash,
    timestamp: source.timestamp,
    split: source.split,
    currentRequest: changes.currentRequest,
    ...(changes.taskAnchor === undefined
        ? {}
        : { taskAnchor: changes.taskAnchor }),
    ...(changes.precedingAssistant === undefined
        ? {}
        : { precedingAssistant: changes.precedingAssistant }),
    ...(changes.earlierUserContext === undefined
        ? {}
        : { earlierUserContext: [...changes.earlierUserContext] }),
    ...(changes.relevantDiagnostic === undefined
        ? {}
        : { relevantDiagnostic: changes.relevantDiagnostic }),
    source: "derived",
});
const visibleFields = (source) => ({
    currentRequest: source.currentRequest,
    ...(source.taskAnchor === undefined
        ? {}
        : { taskAnchor: source.taskAnchor }),
    ...(source.precedingAssistant === undefined
        ? {}
        : { precedingAssistant: source.precedingAssistant }),
    ...(source.earlierUserContext === undefined
        ? {}
        : { earlierUserContext: [...source.earlierUserContext] }),
    ...(source.relevantDiagnostic === undefined
        ? {}
        : { relevantDiagnostic: source.relevantDiagnostic }),
});
const derivedId = (source, kind) => `cf-${kind.replaceAll("_", "-")}-${contentHash({
    sourceEpisodeId: source.id,
    sourceSessionHash: source.sessionHash,
    sourceLineageHash: source.lineageHash,
    kind,
    specificationVersion: LUNA_COUNTERFACTUAL_SPECIFICATION_VERSION,
}).slice(0, 18)}`;
const inheritedLabel = (source, taskEpisodeId, kind) => ({
    ...source,
    taskEpisodeId,
    selectedAreaIds: [...source.selectedAreaIds],
    reason: `Counterfactual ${kind}: expected decision inherited from the source label by construction; this is not an independent silver label.`,
    relevantPaths: [...source.relevantPaths],
    oracle: {
        model: `counterfactual-inheritance:${source.oracle.model}`,
        reasoningEffort: "none",
        passCount: 0,
        adjudicated: true,
        humanReviewed: false,
    },
});
const insufficientLabel = (taskEpisodeId) => ({
    schemaVersion: 1,
    taskEpisodeId,
    selectedAreaIds: [],
    known: false,
    unknownType: "insufficient_information",
    difficulty: "insufficient_information",
    confidence: "high",
    reason: "Controlled negative: every actionable task fact was replaced with an explicit unavailable-context marker.",
    relevantPaths: [],
    oracle: {
        model: "deterministic-counterfactual-construction",
        reasoningEffort: "none",
        passCount: 0,
        adjudicated: true,
        humanReviewed: false,
    },
});
const clipHeadTail = (text, maximumCharacters) => {
    const value = text.trim();
    if (value.length <= maximumCharacters)
        return value;
    const marker = "\n…[controlled truncation]…\n";
    const available = maximumCharacters - marker.length;
    const head = Math.ceil(available * 0.65);
    return `${value.slice(0, head)}${marker}${value.slice(-(available - head))}`;
};
const truncationFields = (source) => ({
    currentRequest: clipHeadTail(source.currentRequest, 480),
    ...(source.taskAnchor === undefined
        ? {}
        : { taskAnchor: clipHeadTail(source.taskAnchor, 240) }),
    ...(source.precedingAssistant === undefined
        ? {}
        : {
            precedingAssistant: clipHeadTail(source.precedingAssistant, 240),
        }),
    ...(source.earlierUserContext === undefined
        ? {}
        : {
            earlierUserContext: source.earlierUserContext
                .slice(-2)
                .map((text) => clipHeadTail(text, 240)),
        }),
    ...(source.relevantDiagnostic === undefined
        ? {}
        : {
            relevantDiagnostic: clipHeadTail(source.relevantDiagnostic, 480),
        }),
});
const irrelevantContextFields = (source) => {
    const fields = visibleFields(source);
    return {
        ...fields,
        earlierUserContext: [
            ...(fields.earlierUserContext ?? []),
            "[UNRELATED AMBIENT NOTE] The workstation clock display preference changed; this does not alter the repository task.",
        ],
        relevantDiagnostic: [
            fields.relevantDiagnostic,
            "[UNRELATED AMBIENT NOTE] Terminal color rendering changed without affecting commands, files, or program behavior.",
        ].filter((value) => Boolean(value)).join("\n"),
    };
};
const insufficiencyFields = () => ({
    currentRequest: "Please continue with the earlier task.",
    taskAnchor: "The earlier task objective is intentionally unavailable in this controlled context.",
    precedingAssistant: "No actionable repository objective is present in the retained context.",
    earlierUserContext: [
        "An earlier request existed, but its task content is intentionally unavailable.",
    ],
    relevantDiagnostic: "No diagnostic output or affected component information was retained.",
});
const sourceSelection = (episodes, maximum) => {
    const onePerLineage = new Map();
    for (const episode of [...episodes].sort((left, right) => lexicalCompare(left.id, right.id))) {
        if (!onePerLineage.has(episode.lineageHash)) {
            onePerLineage.set(episode.lineageHash, episode);
        }
    }
    return [...onePerLineage.values()]
        .sort((left, right) => lexicalCompare(contentHash({
        seed: 73_939,
        id: left.id,
        lineage: left.lineageHash,
    }), contentHash({
        seed: 73_939,
        id: right.id,
        lineage: right.lineageHash,
    })) || lexicalCompare(left.id, right.id))
        .slice(0, maximum);
};
const challengeRegistryVersion = (cards) => `counterfactual-${contentHash(cards.map((card) => ({
    registryVersion: card.registryVersion,
    areaId: card.areaId,
}))).slice(0, 16)}`;
const buildConfusableDistractorRegistry = (cards) => {
    const registryVersion = challengeRegistryVersion(cards);
    const baseCards = cards.map((card) => ({
        ...card,
        registryVersion,
        inclusions: [...card.inclusions],
        exclusions: [...card.exclusions],
        confusableAreaIds: [...card.confusableAreaIds],
        pathAnchors: [...card.pathAnchors],
        componentAnchors: [...card.componentAnchors],
        symbolAnchors: [...card.symbolAnchors],
        codeSummaries: [...card.codeSummaries],
        codeSnippets: [...card.codeSnippets],
        positiveExampleIds: [...card.positiveExampleIds],
        boundaryExamples: [...card.boundaryExamples],
        sourceHashes: [...card.sourceHashes],
    }));
    const candidates = cards
        .filter((card) => card.exclusions.length > 0 ||
        card.confusableAreaIds.length > 0)
        .sort((left, right) => lexicalCompare(left.areaId, right.areaId))
        .slice(0, 3);
    const syntheticIds = candidates.map((card) => `cf-distractor-${contentHash({
        registryVersion,
        areaId: card.areaId,
    }).slice(0, 12)}`);
    const distractors = candidates.map((card, index) => {
        const syntheticId = syntheticIds[index];
        const boundary = card.exclusions.length
            ? card.exclusions
            : [
                `Work adjacent to ${card.name} that does not require its registered responsibility.`,
            ];
        return {
            schemaVersion: 1,
            registryVersion,
            repositoryId: card.repositoryId,
            areaId: syntheticId,
            name: `${card.name} adjacent boundary`,
            description: `A synthetic negative-control area for adjacent work explicitly outside ${card.name}'s registered responsibility.`,
            inclusions: boundary.slice(0, 4),
            exclusions: card.inclusions.slice(0, 4),
            confusableAreaIds: [card.areaId],
            pathAnchors: [],
            componentAnchors: [],
            symbolAnchors: [],
            codeSummaries: [],
            codeSnippets: [],
            positiveExampleIds: [`${syntheticId}-prototype`],
            boundaryExamples: [
                `Do not select this synthetic distractor merely because a task uses vocabulary shared with ${card.name}.`,
            ],
            sourceHashes: [],
            generatorVersion: LUNA_COUNTERFACTUAL_SPECIFICATION_VERSION,
        };
    });
    const realById = new Map(baseCards.map((card) => [card.areaId, card]));
    for (const [index, candidate] of candidates.entries()) {
        const base = realById.get(candidate.areaId);
        const syntheticId = syntheticIds[index];
        if (!base.confusableAreaIds.includes(syntheticId)) {
            base.confusableAreaIds.push(syntheticId);
        }
    }
    return [...baseCards, ...distractors];
};
const registryScenarios = (cards) => [
    {
        schemaVersion: 1,
        id: "registry-order-canonical",
        kind: "card_order",
        cardOrdering: "canonical",
        seed: DEFAULT_LUNA_ACCURACY_FIXED_SEED_LIST[0],
        expectedProperty: "decision_invariant",
    },
    {
        schemaVersion: 1,
        id: "registry-order-reverse",
        kind: "card_order",
        cardOrdering: "reverse",
        seed: DEFAULT_LUNA_ACCURACY_FIXED_SEED_LIST[0],
        expectedProperty: "decision_invariant",
    },
    ...DEFAULT_LUNA_ACCURACY_FIXED_SEED_LIST.slice(0, 3).map((seed, index) => ({
        schemaVersion: 1,
        id: `registry-order-shuffle-${index + 1}`,
        kind: "card_order",
        cardOrdering: "shuffle",
        seed,
        expectedProperty: "decision_invariant",
    })),
    {
        schemaVersion: 1,
        id: "registry-confusable-distractors",
        kind: "confusable_distractor",
        cardOrdering: "canonical",
        seed: DEFAULT_LUNA_ACCURACY_FIXED_SEED_LIST[0],
        cards: buildConfusableDistractorRegistry(cards),
        expectedProperty: "do_not_select_synthetic_distractors",
    },
];
/**
 * Creates a bounded, deterministic challenge suite from real cases.
 *
 * The suite is always scored separately from real data. Source labels are
 * inherited only for transformations that should preserve semantics; the
 * controlled-insufficiency cases receive deterministic construction labels.
 * `actualChangedPaths`, V2 provenance, and all other post-task fields are
 * excluded by explicit projection.
 */
export const buildLunaCounterfactualChallengeSuite = (input) => {
    const split = input.split ?? "validation";
    const maximum = input.maximumSourceCases ?? 12;
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > 100) {
        throw new Error("maximumSourceCases must be an integer from 1 through 100");
    }
    if (split === "test") {
        if (!input.lockedTestFreeze) {
            throw new Error("Test-derived challenges require a completed locked-test freeze record");
        }
        validateLunaAccuracyFreezeRecord(input.lockedTestFreeze);
    }
    const episodes = input.episodes.filter((episode) => episode.split === split);
    if (episodes.length === 0) {
        throw new Error(`No source episodes in requested ${split} split`);
    }
    if (episodes.length !== input.episodes.length) {
        throw new Error("Counterfactual input must contain only the requested source split");
    }
    const cards = [...input.cards];
    const labels = [...input.labels];
    const profile = {
        schemaVersion: 1,
        repositoryId: cards[0]?.repositoryId ?? "",
        snapshot: episodes[0]?.repositorySnapshot ?? "",
        name: "counterfactual-validation-placeholder",
        purpose: "Validate challenge Area Cards",
        languages: [],
        frameworks: [],
        components: [{ name: "repository", purpose: "placeholder", paths: [] }],
        generatorVersion: LUNA_COUNTERFACTUAL_SPECIFICATION_VERSION,
    };
    validateAreaCards(cards, profile);
    validateEpisodes(episodes, cards);
    validateSilverLabels(labels, cards);
    const episodeIds = new Set(episodes.map((episode) => episode.id));
    const labelById = new Map(labels.map((label) => [label.taskEpisodeId, label]));
    if (labelById.size !== labels.length ||
        labels.some((label) => !episodeIds.has(label.taskEpisodeId)) ||
        episodes.some((episode) => !labelById.has(episode.id))) {
        throw new Error("Counterfactual source episodes and labels require an exact one-to-one join");
    }
    const repositoryIds = new Set(episodes.map((episode) => episode.repositoryId));
    if (repositoryIds.size !== 1 ||
        cards.some((card) => card.repositoryId !== episodes[0].repositoryId)) {
        throw new Error("Counterfactual inputs must belong to one repository");
    }
    const selected = sourceSelection(episodes, maximum);
    const selectedIds = new Set(selected.map((episode) => episode.id));
    const safeTruncationIds = new Set(input.safeTruncationEpisodeIds ?? []);
    for (const id of safeTruncationIds) {
        if (!selectedIds.has(id)) {
            throw new Error(`Safe truncation ID is not a selected source episode: ${id}`);
        }
    }
    const derivedEpisodes = [];
    const derivedLabels = [];
    const provenance = [];
    const add = (source, kind, fields, label, expectedDecision, construction) => {
        const id = derivedId(source, kind);
        derivedEpisodes.push(runtimeEpisodeProjection(source, id, fields));
        derivedLabels.push({ ...label, taskEpisodeId: id });
        provenance.push({
            schemaVersion: 1,
            specificationVersion: LUNA_COUNTERFACTUAL_SPECIFICATION_VERSION,
            derivativeEpisodeId: id,
            sourceEpisodeId: source.id,
            sourceSessionHash: source.sessionHash,
            sourceLineageHash: source.lineageHash,
            split: source.split,
            kind,
            expectedDecision,
            construction,
            sourceActualChangedPathsRead: false,
        });
    };
    for (const source of selected) {
        const sourceLabel = labelById.get(source.id);
        const irrelevantId = derivedId(source, "irrelevant_context");
        add(source, "irrelevant_context", irrelevantContextFields(source), inheritedLabel(sourceLabel, irrelevantId, "irrelevant_context"), "inherited_from_source_label", "Append two fixed, semantically irrelevant ambient notes while preserving every original task-aware field.");
        const insufficientId = derivedId(source, "controlled_insufficiency");
        add(source, "controlled_insufficiency", insufficiencyFields(), insufficientLabel(insufficientId), "insufficient_information", "Replace all actionable task facts with explicit unavailable-context markers while retaining a task-aware envelope.");
        if (safeTruncationIds.has(source.id)) {
            const truncatedId = derivedId(source, "reviewed_truncation");
            add(source, "reviewed_truncation", truncationFields(source), inheritedLabel(sourceLabel, truncatedId, "reviewed_truncation"), "inherited_from_source_label", "Apply deterministic per-field head/tail caps only after the source case was explicitly approved for label-preserving truncation.");
        }
    }
    validateEpisodes(derivedEpisodes);
    validateSilverLabels(derivedLabels, cards);
    for (const episode of derivedEpisodes) {
        if ("actualChangedPaths" in episode ||
            JSON.stringify(episode).includes("actualChangedPaths")) {
            throw new Error("Counterfactual runtime episode leaked changed paths");
        }
    }
    return {
        schemaVersion: 1,
        specificationVersion: LUNA_COUNTERFACTUAL_SPECIFICATION_VERSION,
        split,
        sourceCases: selected.length,
        episodes: derivedEpisodes,
        labels: derivedLabels,
        provenance,
        registryScenarios: registryScenarios(cards),
        reportingPolicy: {
            combineWithRealHeadline: false,
            reportByChallengeKind: true,
            inheritedLabelsAreIndependentSilverLabels: false,
        },
    };
};
