import { serializeRepositoryProfile } from "./serialization.js";
const clipHeadTail = (value, maximumCharacters) => {
    const normalized = value.trim();
    if (normalized.length <= maximumCharacters)
        return normalized;
    const marker = "\n…[middle omitted for runtime classification]…\n";
    if (maximumCharacters <= marker.length + 2) {
        return normalized.slice(0, maximumCharacters);
    }
    const available = maximumCharacters - marker.length;
    const head = Math.ceil(available * 0.65);
    const tail = available - head;
    return `${normalized.slice(0, head)}${marker}${normalized.slice(-tail)}`;
};
const section = (name, value) => value?.trim() ? `[${name}]\n${value.trim()}` : "";
const boundedProfile = (profile, mode) => {
    const detailed = [
        `Repository: ${profile.name}`,
        `Purpose: ${profile.purpose}`,
        ...(mode !== "compact"
            ? [
                `Languages: ${profile.languages.join(", ")}`,
                `Frameworks: ${profile.frameworks.join(", ")}`,
            ]
            : []),
        "Components:",
        ...profile.components.map((component) => mode !== "compact"
            ? `- ${component.name}: ${component.purpose} (${component.paths.join(", ")})`
            : `- ${component.name}: ${component.paths.join(", ")}`),
    ].join("\n");
    return clipHeadTail(detailed, mode === "full" ? 3_072 : mode === "balanced" ? 1_800 : 1_000);
};
const boundedTaskEnvelope = (episode, profile, mode) => {
    const limits = mode === "full"
        ? {
            body: 16_384,
            taskAnchor: 2_048,
            assistant: 2_048,
            earlierUser: 3_072,
            diagnostic: 4_096,
        }
        : mode === "balanced"
            ? {
                body: 8_192,
                taskAnchor: 768,
                assistant: 768,
                earlierUser: 1_024,
                diagnostic: 1_536,
            }
            : {
                body: 4_096,
                taskAnchor: 384,
                assistant: 384,
                earlierUser: 512,
                diagnostic: 768,
            };
    const optional = [
        section("TASK ANCHOR", episode.taskAnchor
            ? clipHeadTail(episode.taskAnchor, limits.taskAnchor)
            : undefined),
        section("RECENT ASSISTANT CONTEXT", episode.precedingAssistant
            ? clipHeadTail(episode.precedingAssistant, limits.assistant)
            : undefined),
        section("EARLIER USER CONTEXT", episode.earlierUserContext?.length
            ? clipHeadTail(episode.earlierUserContext.join("\n\n"), limits.earlierUser)
            : undefined),
        section("RELEVANT DIAGNOSTIC", episode.relevantDiagnostic
            ? clipHeadTail(episode.relevantDiagnostic, limits.diagnostic)
            : undefined),
    ].filter(Boolean);
    const optionalText = optional.join("\n\n");
    const requestHeading = "[CURRENT REQUEST]\n";
    const separators = optionalText ? 2 : 0;
    const requestBudget = Math.max(512, limits.body -
        requestHeading.length -
        optionalText.length -
        separators);
    const request = section("CURRENT REQUEST", clipHeadTail(episode.currentRequest, requestBudget));
    const body = [request, optionalText].filter(Boolean).join("\n\n");
    return `${body}\n\n${section("REPOSITORY PROFILE", boundedProfile(profile, mode))}`;
};
/**
 * Every supported mode is task-aware. Even the smallest mode retains every
 * available task-context category, subject to deterministic per-section caps,
 * plus repository context. There is intentionally no latest-request-only mode.
 */
export const serializeLunaTaskContext = (episode, profile, mode) => boundedTaskEnvelope(episode, profile, mode);
const renderAreaCard = (card, mode) => {
    const identity = [
        `Area ID: ${card.areaId}`,
        `Name: ${card.name}`,
        `Description: ${card.description}`,
    ];
    if (mode === "identity")
        return identity.join("\n");
    const compact = [
        ...identity,
        `Includes: ${card.inclusions.join("; ")}`,
        `Excludes: ${card.exclusions.join("; ")}`,
        `Paths: ${card.pathAnchors.join(", ")}`,
        `Confusable with: ${card.confusableAreaIds.join(", ") || "none"}`,
    ];
    if (mode === "compact")
        return compact.join("\n");
    const semantic = [
        ...compact,
        `Components: ${card.componentAnchors.join(", ")}`,
        `Symbols: ${card.symbolAnchors.join(", ")}`,
        `Boundary examples: ${card.boundaryExamples.join("; ")}`,
    ];
    if (mode === "semantic")
        return semantic.join("\n");
    return [
        ...semantic,
        `Code summaries: ${card.codeSummaries.join("; ")}`,
        card.codeSnippets.length
            ? `Code excerpts:\n${card.codeSnippets.join("\n---\n")}`
            : "",
    ].filter(Boolean).join("\n");
};
export const renderLunaAreaContext = (cards, mode) => cards.map((card) => renderAreaCard(card, mode)).join("\n\n---\n\n");
export const validateLunaBenchmarkMatrix = (matrix) => {
    if (matrix.schemaVersion !== 1) {
        throw new Error("Unsupported Luna benchmark matrix schema");
    }
    if (!matrix.variants.length) {
        throw new Error("Luna benchmark matrix must contain at least one variant");
    }
    const ids = new Set();
    const safeId = /^[a-z0-9][a-z0-9_-]{0,79}$/u;
    const allowed = (value, values, field, variantId) => {
        if (!values.includes(value)) {
            throw new Error(`Invalid ${field} for Luna variant ${variantId}: ${value}`);
        }
    };
    for (const variant of matrix.variants) {
        if (!safeId.test(variant.id)) {
            throw new Error(`Invalid Luna benchmark variant ID: ${variant.id}`);
        }
        if (ids.has(variant.id)) {
            throw new Error(`Duplicate Luna benchmark variant ID: ${variant.id}`);
        }
        ids.add(variant.id);
        allowed(variant.taskContext, ["full", "balanced", "compact"], "taskContext", variant.id);
        allowed(variant.areaContext, ["identity", "compact", "semantic", "full"], "areaContext", variant.id);
        allowed(variant.promptOrder, ["registry_first", "task_first"], "promptOrder", variant.id);
        allowed(variant.decisionMode, ["direct", "gated", "novelty_strict"], "decisionMode", variant.id);
        allowed(variant.outputMode, ["minimal", "lean", "verbose"], "outputMode", variant.id);
        allowed(variant.reasoningEffort, ["none", "low", "medium", "high"], "reasoningEffort", variant.id);
        if (!Number.isInteger(variant.maxOutputTokens) ||
            variant.maxOutputTokens < 16 ||
            variant.maxOutputTokens > 1_024) {
            throw new Error(`Invalid maxOutputTokens for Luna variant ${variant.id}`);
        }
        const repetitions = variant.repetitions ?? 1;
        if (!Number.isInteger(repetitions) ||
            repetitions < 1 ||
            repetitions > 10) {
            throw new Error(`Invalid repetitions for Luna variant ${variant.id}`);
        }
        if (variant.outputMode === "verbose" && variant.maxOutputTokens < 96) {
            throw new Error(`Verbose Luna variant ${variant.id} needs at least 96 output tokens`);
        }
    }
};
export const lunaVariantSerializationVersion = (variant) => [
    `task-${variant.taskContext}`,
    `areas-${variant.areaContext}`,
    `order-${variant.promptOrder}`,
    `decision-${variant.decisionMode}`,
    `output-${variant.outputMode}`,
    `reasoning-${variant.reasoningEffort}`,
].join(":");
export const fullRepositoryProfileCharacters = (profile) => serializeRepositoryProfile(profile).length;
