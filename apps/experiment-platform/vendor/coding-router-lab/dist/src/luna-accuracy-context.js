/**
 * These budgets use a deliberately simple, tokenizer-independent conversion.
 * The cap applies to the complete serialized task context, including labels,
 * JSON syntax, and the repository profile.
 */
export const LUNA_ACCURACY_CHARACTERS_PER_TOKEN_EQUIVALENT = 4;
export const LUNA_ACCURACY_TASK_BUDGET_CHARACTER_CAPS = {
    "2k": 2_048 * LUNA_ACCURACY_CHARACTERS_PER_TOKEN_EQUIVALENT,
    "6k": 6_144 * LUNA_ACCURACY_CHARACTERS_PER_TOKEN_EQUIVALENT,
    "16k": 16_384 * LUNA_ACCURACY_CHARACTERS_PER_TOKEN_EQUIVALENT,
    "32k": 32_768 * LUNA_ACCURACY_CHARACTERS_PER_TOKEN_EQUIVALENT,
};
export const DEFAULT_LUNA_ACCURACY_FIXED_SEED_LIST = Object.freeze([
    104_729,
    130_363,
    155_921,
    181_081,
    206_369,
]);
const TASK_FORMATS = [
    "labeled_sections",
    "chronological",
    "compact_json",
];
const TASK_BUDGETS = ["2k", "6k", "16k", "32k"];
const PROFILE_DETAILS = ["identity", "components", "full"];
const AREA_FIELD_BUNDLES = [
    "identity",
    "contrastive",
    "anchors",
    "prototypes",
    "full",
];
const REGISTRY_FORMATS = ["prose", "compact_json"];
const CARD_ORDERINGS = ["canonical", "reverse", "shuffle"];
const REASONING_EFFORTS = ["none", "low", "medium", "high"];
const PROMPT_PROCEDURES = [
    "gated",
    "decomposed",
    "contrastive",
];
const OUTPUT_SCHEMAS = ["minimal", "evidence", "ranked"];
const TASK_FIELD_ORDER = [
    "repositoryProfile",
    "taskAnchor",
    "earlierUserContext",
    "precedingAssistant",
    "relevantDiagnostic",
    "currentRequest",
];
const TASK_FIELD_WEIGHTS = {
    repositoryProfile: 0.14,
    taskAnchor: 0.1,
    earlierUserContext: 0.1,
    precedingAssistant: 0.06,
    relevantDiagnostic: 0.25,
    currentRequest: 0.35,
};
const compactWhitespace = (value) => value.replaceAll(/\s+/gu, " ").trim();
const clipHeadTail = (value, maximumCharacters) => {
    const normalized = value.trim();
    if (normalized.length <= maximumCharacters)
        return normalized;
    if (maximumCharacters <= 0)
        return "";
    const marker = "\n…[omitted]…\n";
    if (maximumCharacters <= marker.length + 2) {
        return normalized.slice(0, maximumCharacters);
    }
    const available = maximumCharacters - marker.length;
    const head = Math.ceil(available * 0.65);
    return `${normalized.slice(0, head)}${marker}${normalized.slice(-(available - head))}`;
};
const lexicalCompare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
/**
 * Projects the repository profile without ever reading arbitrary episode
 * fields. In particular, `actualChangedPaths` has no path into this module's
 * task serialization.
 */
export const projectLunaAccuracyRepositoryProfile = (profile, detail) => {
    const identity = {
        repository_id: profile.repositoryId,
        name: profile.name,
        purpose: profile.purpose,
    };
    if (detail === "identity")
        return identity;
    const components = profile.components.map((component) => ({
        name: component.name,
        purpose: component.purpose,
    }));
    if (detail === "components") {
        return {
            ...identity,
            languages: [...profile.languages],
            frameworks: [...profile.frameworks],
            components,
        };
    }
    return {
        ...identity,
        languages: [...profile.languages],
        frameworks: [...profile.frameworks],
        components: profile.components.map((component) => ({
            name: component.name,
            purpose: component.purpose,
            paths: [...component.paths],
        })),
    };
};
const proseValue = (value) => {
    if (Array.isArray(value)) {
        if (!value.length)
            return "none";
        if (value.every((item) => typeof item === "string")) {
            return value.join("; ");
        }
        return value.map((item) => JSON.stringify(item)).join("; ");
    }
    return String(value);
};
export const serializeLunaAccuracyRepositoryProfile = (profile, detail) => Object.entries(projectLunaAccuracyRepositoryProfile(profile, detail))
    .map(([key, value]) => `${key}: ${proseValue(value)}`)
    .join("\n");
const taskFields = (episode, profile, profileDetail) => ({
    repositoryProfile: serializeLunaAccuracyRepositoryProfile(profile, profileDetail),
    taskAnchor: episode.taskAnchor?.trim() || "(not available)",
    earlierUserContext: episode.earlierUserContext?.length
        ? episode.earlierUserContext
            .map((turn, index) => `User context ${index + 1}: ${turn.trim()}`)
            .join("\n")
        : "(not available)",
    precedingAssistant: episode.precedingAssistant?.trim() || "(not available)",
    relevantDiagnostic: episode.relevantDiagnostic?.trim() || "(not available)",
    currentRequest: episode.currentRequest.trim(),
});
const allocatePayload = (fields, payloadBudget) => {
    const allocation = Object.fromEntries(TASK_FIELD_ORDER.map((field) => [field, 0]));
    let remaining = payloadBudget;
    let active = TASK_FIELD_ORDER.filter((field) => fields[field].length > 0);
    while (remaining > 0 && active.length > 0) {
        const totalWeight = active.reduce((sum, field) => sum + TASK_FIELD_WEIGHTS[field], 0);
        let saturated = false;
        for (const field of active) {
            const need = fields[field].length - allocation[field];
            const fairShare = Math.max(1, Math.floor((remaining * TASK_FIELD_WEIGHTS[field]) / totalWeight));
            if (need <= fairShare) {
                allocation[field] += need;
                remaining -= need;
                active = active.filter((candidate) => candidate !== field);
                saturated = true;
                break;
            }
        }
        if (saturated)
            continue;
        for (let index = 0; index < active.length && remaining > 0; index += 1) {
            const field = active[index];
            const slotsAfter = active.length - index - 1;
            const share = index === active.length - 1
                ? remaining
                : Math.max(0, Math.floor(((remaining - slotsAfter) * TASK_FIELD_WEIGHTS[field]) /
                    active
                        .slice(index)
                        .reduce((sum, candidate) => sum + TASK_FIELD_WEIGHTS[candidate], 0)));
            const added = Math.min(fields[field].length - allocation[field], share);
            allocation[field] += added;
            remaining -= added;
        }
        break;
    }
    return allocation;
};
const boundedFields = (fields, payloadBudget) => {
    const allocations = allocatePayload(fields, payloadBudget);
    return Object.fromEntries(TASK_FIELD_ORDER.map((field) => [
        field,
        clipHeadTail(fields[field], allocations[field]),
    ]));
};
const renderLabeledSections = (fields) => [
    ["REPOSITORY PROFILE", fields.repositoryProfile],
    ["TASK ANCHOR", fields.taskAnchor],
    ["EARLIER USER CONTEXT", fields.earlierUserContext],
    ["RECENT ASSISTANT CONTEXT", fields.precedingAssistant],
    ["RELEVANT DIAGNOSTIC", fields.relevantDiagnostic],
    ["CURRENT REQUEST", fields.currentRequest],
]
    .map(([label, value]) => `[${label}]\n${value}`)
    .join("\n\n");
const renderChronological = (fields) => [
    "[REPOSITORY PROFILE — available before the conversation]",
    fields.repositoryProfile,
    "",
    "[TASK ANCHOR — governing objective]",
    fields.taskAnchor,
    "",
    "[CONVERSATION — oldest to newest]",
    `EARLIER USER:\n${fields.earlierUserContext}`,
    `PRECEDING ASSISTANT:\n${fields.precedingAssistant}`,
    `RELEVANT DIAGNOSTIC:\n${fields.relevantDiagnostic}`,
    `CURRENT USER REQUEST:\n${fields.currentRequest}`,
].join("\n");
const renderCompactJson = (fields) => JSON.stringify({
    repository_profile: fields.repositoryProfile,
    task_context: {
        task_anchor: fields.taskAnchor,
        earlier_user_context: fields.earlierUserContext,
        preceding_assistant: fields.precedingAssistant,
        relevant_diagnostic: fields.relevantDiagnostic,
        current_request: fields.currentRequest,
    },
});
const renderTaskFields = (fields, format) => {
    if (format === "labeled_sections")
        return renderLabeledSections(fields);
    if (format === "chronological")
        return renderChronological(fields);
    return renderCompactJson(fields);
};
/**
 * Serializes task-aware context under a hard whole-envelope character cap.
 *
 * There is intentionally no latest-request-only mode. Every format names and
 * retains all available task-context categories plus repository context.
 */
export const serializeLunaAccuracyTaskContext = (episode, profile, format, budget, profileDetail) => {
    const characterCap = LUNA_ACCURACY_TASK_BUDGET_CHARACTER_CAPS[budget];
    const rawFields = taskFields(episode, profile, profileDetail);
    let payloadBudget = characterCap;
    let rendered = renderTaskFields(boundedFields(rawFields, payloadBudget), format);
    // JSON escaping can make output larger than the sum of its source strings.
    // Reduce the payload deterministically until the complete envelope fits.
    while (rendered.length > characterCap && payloadBudget > 0) {
        const nextBudget = Math.max(0, Math.min(payloadBudget - 1, Math.floor(payloadBudget * (characterCap / rendered.length) * 0.98)));
        payloadBudget = nextBudget;
        rendered = renderTaskFields(boundedFields(rawFields, payloadBudget), format);
    }
    if (rendered.length > characterCap) {
        throw new Error(`Luna task context envelope exceeds the ${budget} character cap`);
    }
    return rendered;
};
export const projectLunaAccuracyAreaCard = (card, bundle) => {
    const identity = {
        area_id: card.areaId,
        name: card.name,
        description: card.description,
    };
    if (bundle === "identity")
        return identity;
    if (bundle === "contrastive") {
        return {
            ...identity,
            inclusions: [...card.inclusions],
            exclusions: [...card.exclusions],
            confusable_area_ids: [...card.confusableAreaIds],
            boundary_examples: [...card.boundaryExamples],
        };
    }
    if (bundle === "anchors") {
        return {
            ...identity,
            path_anchors: [...card.pathAnchors],
            component_anchors: [...card.componentAnchors],
            symbol_anchors: [...card.symbolAnchors],
        };
    }
    if (bundle === "prototypes") {
        return {
            ...identity,
            code_summaries: [...card.codeSummaries],
            code_snippets: [...card.codeSnippets],
        };
    }
    return {
        ...identity,
        inclusions: [...card.inclusions],
        exclusions: [...card.exclusions],
        confusable_area_ids: [...card.confusableAreaIds],
        path_anchors: [...card.pathAnchors],
        component_anchors: [...card.componentAnchors],
        symbol_anchors: [...card.symbolAnchors],
        code_summaries: [...card.codeSummaries],
        code_snippets: [...card.codeSnippets],
        boundary_examples: [...card.boundaryExamples],
    };
};
const canonicalCardCompare = (left, right) => lexicalCompare(left.areaId, right.areaId) ||
    lexicalCompare(left.name, right.name) ||
    lexicalCompare(JSON.stringify(projectLunaAccuracyAreaCard(left, "full")), JSON.stringify(projectLunaAccuracyAreaCard(right, "full")));
const seededRandom = (seed) => {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
    };
};
export const orderLunaAccuracyAreaCards = (cards, ordering, seed) => {
    const ordered = [...cards].sort(canonicalCardCompare);
    if (ordering === "reverse")
        return ordered.reverse();
    if (ordering === "canonical")
        return ordered;
    const random = seededRandom(seed);
    for (let index = ordered.length - 1; index > 0; index -= 1) {
        const target = Math.floor(random() * (index + 1));
        [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
    }
    return ordered;
};
const proseAreaCard = (card) => Object.entries(card)
    .map(([field, value]) => `${field}: ${proseValue(value)}`)
    .join("\n");
export const renderLunaAccuracyAreaRegistry = (cards, bundle, format, ordering, seed) => {
    const projected = orderLunaAccuracyAreaCards(cards, ordering, seed).map((card) => projectLunaAccuracyAreaCard(card, bundle));
    if (format === "compact_json") {
        return JSON.stringify({ areas: projected });
    }
    return projected.map(proseAreaCard).join("\n\n---\n\n");
};
export const renderLunaAccuracyProcedure = (procedure) => {
    if (procedure === "gated") {
        return [
            "Use this decision procedure:",
            "1. Decide whether the task is actionable from the supplied task-aware context.",
            "2. If it is not actionable, return known=false and insufficient_information.",
            "3. If actionable, decide whether the work is inside this repository's scope.",
            "4. Compare the task with every registered area. Select at most two areas only when their responsibilities are genuinely required.",
            "5. If repository work is real but no registered area fits, return known=false and new_repository_area.",
            "Do not force an area match.",
        ].join("\n");
    }
    if (procedure === "decomposed") {
        return [
            "Use this decision procedure:",
            "1. Identify the concrete coding objective, affected responsibility, constraints, and diagnostic evidence.",
            "2. Resolve referential language using the task anchor and prior context.",
            "3. Independently map each required responsibility to the registry.",
            "4. Test the best mapping against exclusions and neighboring areas.",
            "5. Decide known versus new_repository_area, outside_scope, or insufficient_information.",
            "6. Return at most two areas in descending relevance.",
            "Perform the decomposition internally; emit only the requested JSON.",
        ].join("\n");
    }
    return [
        "Use this decision procedure:",
        "1. Form the strongest plausible area candidates from the task-aware context.",
        "2. For each candidate, compare supporting evidence with its exclusions, anchors, prototypes, boundaries, and confusable areas when supplied.",
        "3. Compare the leading candidates directly rather than accepting the first semantic match.",
        "4. Reject all candidates when the task lacks actionable detail, is outside repository scope, or needs an unregistered repository area.",
        "5. Select at most two areas, ordered by relevance.",
        "Do not force an area match.",
    ].join("\n");
};
export const renderLunaAccuracyOutputContract = (schema) => {
    const common = [
        "Return one JSON object and no prose outside it.",
        "known is true only when at least one registered area is selected.",
        "unknown_type must be null when known=true; otherwise it must be one of new_repository_area, outside_scope, or insufficient_information.",
        "confidence is confidence in the complete semantic decision and is not a substitute for the known/unknown decision.",
        "gate_confidence is confidence in the known/unknown gate and, for an unknown decision, its subtype.",
        "area_confidence is confidence in the complete selected area set when known=true; it must be null when known=false.",
        "All numeric confidences are numbers from 0 through 1.",
    ];
    if (schema === "minimal") {
        return [
            ...common,
            'Schema: {"known":boolean,"selected_area_ids":string[],"unknown_type":string|null,"confidence":number,"gate_confidence":number,"area_confidence":number|null}',
        ].join("\n");
    }
    if (schema === "evidence") {
        return [
            ...common,
            'Schema: {"known":boolean,"selected_area_ids":string[],"unknown_type":string|null,"confidence":number,"gate_confidence":number,"area_confidence":number|null,"evidence":[{"area_id":string,"supporting_facts":string[],"counterevidence":string[]}]}',
            "Ground evidence only in the supplied task context and registry.",
        ].join("\n");
    }
    return [
        ...common,
        'Schema: {"known":boolean,"selected_area_ids":string[],"unknown_type":string|null,"confidence":number,"gate_confidence":number,"area_confidence":number|null,"ranked_candidates":[{"area_id":string,"score":number,"supporting_facts":string[],"counterevidence":string[]}]}',
        "Rank no more than five registered candidates. Scores must be between 0 and 1 in descending order.",
        "Ground evidence only in the supplied task context and registry.",
    ].join("\n");
};
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const assertExactKeys = (value, allowed, label) => {
    const allowedSet = new Set(allowed);
    for (const key of Object.keys(value)) {
        if (!allowedSet.has(key)) {
            throw new Error(`Unsupported ${label} field: ${key}`);
        }
    }
    for (const key of allowed) {
        if (!(key in value)) {
            throw new Error(`Missing ${label} field: ${key}`);
        }
    }
};
const assertEnum = (value, allowed, field) => {
    if (typeof value !== "string" || !allowed.includes(value)) {
        throw new Error(`Invalid Luna accuracy ${field}: ${String(value)}`);
    }
};
const VARIANT_KEYS = [
    "schemaVersion",
    "id",
    "taskFormat",
    "taskBudget",
    "repositoryProfileDetail",
    "areaFieldBundle",
    "registryFormat",
    "cardOrdering",
    "reasoningEffort",
    "promptProcedure",
    "outputSchema",
    "maxOutputTokens",
    "repetitions",
    "fixedSeedList",
];
export function validateLunaAccuracyVariantV2(value) {
    if (!isRecord(value)) {
        throw new Error("Luna accuracy variant must be an object");
    }
    assertExactKeys(value, VARIANT_KEYS, "Luna accuracy variant");
    if (value.schemaVersion !== 2) {
        throw new Error("Unsupported Luna accuracy variant schema");
    }
    if (typeof value.id !== "string" ||
        !/^[a-z0-9][a-z0-9_-]{0,79}$/u.test(value.id)) {
        throw new Error(`Invalid Luna accuracy variant ID: ${String(value.id)}`);
    }
    assertEnum(value.taskFormat, TASK_FORMATS, "taskFormat");
    assertEnum(value.taskBudget, TASK_BUDGETS, "taskBudget");
    assertEnum(value.repositoryProfileDetail, PROFILE_DETAILS, "repositoryProfileDetail");
    assertEnum(value.areaFieldBundle, AREA_FIELD_BUNDLES, "areaFieldBundle");
    assertEnum(value.registryFormat, REGISTRY_FORMATS, "registryFormat");
    assertEnum(value.cardOrdering, CARD_ORDERINGS, "cardOrdering");
    assertEnum(value.reasoningEffort, REASONING_EFFORTS, "reasoningEffort");
    assertEnum(value.promptProcedure, PROMPT_PROCEDURES, "promptProcedure");
    assertEnum(value.outputSchema, OUTPUT_SCHEMAS, "outputSchema");
    if (!Number.isInteger(value.maxOutputTokens) ||
        value.maxOutputTokens < 32 ||
        value.maxOutputTokens > 4_096) {
        throw new Error("Luna accuracy maxOutputTokens must be 32..4096");
    }
    const maxOutputTokens = value.maxOutputTokens;
    if (value.outputSchema === "evidence" && maxOutputTokens < 128) {
        throw new Error("Evidence output needs at least 128 output tokens");
    }
    if (value.outputSchema === "ranked" && maxOutputTokens < 192) {
        throw new Error("Ranked output needs at least 192 output tokens");
    }
    if (!Number.isInteger(value.repetitions) ||
        value.repetitions < 1 ||
        value.repetitions > 20) {
        throw new Error("Luna accuracy repetitions must be 1..20");
    }
    if (!Array.isArray(value.fixedSeedList) ||
        value.fixedSeedList.length < value.repetitions ||
        value.fixedSeedList.length > 64) {
        throw new Error("Luna accuracy fixedSeedList must cover every repetition and contain at most 64 seeds");
    }
    const uniqueSeeds = new Set();
    for (const seed of value.fixedSeedList) {
        if (!Number.isInteger(seed) ||
            seed < 0 ||
            seed > 2_147_483_647) {
            throw new Error("Luna accuracy seeds must be integers from 0 through 2147483647");
        }
        if (uniqueSeeds.has(seed)) {
            throw new Error(`Duplicate Luna accuracy seed: ${seed}`);
        }
        uniqueSeeds.add(seed);
    }
}
export function validateLunaAccuracyMatrixV2(value) {
    if (!isRecord(value)) {
        throw new Error("Luna accuracy matrix must be an object");
    }
    const matrixKeys = value.description === undefined
        ? ["schemaVersion", "variants"]
        : ["schemaVersion", "description", "variants"];
    assertExactKeys(value, matrixKeys, "Luna accuracy matrix");
    if (value.schemaVersion !== 2) {
        throw new Error("Unsupported Luna accuracy matrix schema");
    }
    if (value.description !== undefined &&
        (typeof value.description !== "string" ||
            value.description.length > 2_000)) {
        throw new Error("Invalid Luna accuracy matrix description");
    }
    if (!Array.isArray(value.variants) ||
        value.variants.length < 1 ||
        value.variants.length > 1_000) {
        throw new Error("Luna accuracy matrix must contain 1..1000 variants");
    }
    const ids = new Set();
    for (const variant of value.variants) {
        validateLunaAccuracyVariantV2(variant);
        if (ids.has(variant.id)) {
            throw new Error(`Duplicate Luna accuracy variant ID: ${variant.id}`);
        }
        ids.add(variant.id);
    }
}
export const getLunaAccuracyRepetitionSeed = (variant, repetitionIndex) => {
    validateLunaAccuracyVariantV2(variant);
    if (!Number.isInteger(repetitionIndex) ||
        repetitionIndex < 0 ||
        repetitionIndex >= variant.repetitions) {
        throw new Error(`Invalid Luna accuracy repetition index: ${repetitionIndex}`);
    }
    return variant.fixedSeedList[repetitionIndex];
};
export const lunaAccuracyVariantSerializationVersion = (variant) => {
    validateLunaAccuracyVariantV2(variant);
    return [
        "luna-accuracy-v2",
        `task-${variant.taskFormat}`,
        `budget-${variant.taskBudget}`,
        `profile-${variant.repositoryProfileDetail}`,
        `areas-${variant.areaFieldBundle}`,
        `registry-${variant.registryFormat}`,
        `order-${variant.cardOrdering}`,
        `reasoning-${variant.reasoningEffort}`,
        `procedure-${variant.promptProcedure}`,
        `output-${variant.outputSchema}`,
        `max-${variant.maxOutputTokens}`,
        `repetitions-${variant.repetitions}`,
        `seeds-${variant.fixedSeedList.join(".")}`,
    ].join("/");
};
export const buildLunaAccuracyPrompt = ({ episode, profile, cards, variant, repetitionIndex, }) => {
    validateLunaAccuracyVariantV2(variant);
    const seed = getLunaAccuracyRepetitionSeed(variant, repetitionIndex);
    const taskContext = serializeLunaAccuracyTaskContext(episode, profile, variant.taskFormat, variant.taskBudget, variant.repositoryProfileDetail);
    const registry = renderLunaAccuracyAreaRegistry(cards, variant.areaFieldBundle, variant.registryFormat, variant.cardOrdering, seed);
    const system = [
        "You are a runtime classifier for coding tasks.",
        "Classify from the complete task-aware context and the frozen Area Registry. Never infer an area from wording alone when the supplied context contradicts it.",
        renderLunaAccuracyProcedure(variant.promptProcedure),
        "",
        renderLunaAccuracyOutputContract(variant.outputSchema),
    ].join("\n");
    const user = [
        "[FROZEN AREA REGISTRY]",
        registry,
        "",
        "[TASK-AWARE CONTEXT]",
        taskContext,
    ].join("\n");
    return {
        system,
        user,
        seed,
        serializationVersion: lunaAccuracyVariantSerializationVersion(variant),
    };
};
/**
 * Useful when experiment IDs need a concise deterministic context signature.
 */
export const compactLunaAccuracyText = compactWhitespace;
