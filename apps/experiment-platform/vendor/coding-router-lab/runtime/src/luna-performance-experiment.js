import { buildLunaDistributionalResponseSchema, evaluateLunaDistributionalPredictions, LUNA_SCOPE_IDS, parseLunaDistributionalDecision, scopeTargetForLabel, } from "./luna-distributional.js";
import { renderLunaAccuracyAreaRegistry, renderLunaAccuracyProcedure, serializeLunaAccuracyTaskContext, } from "./luna-accuracy-context.js";
import { callLunaOpenRouter, } from "./luna-bounded-tool-harness.js";
import { LUNA_ACCURACY_MODEL, } from "./luna-accuracy-openrouter.js";
import { contentHash, sha256 } from "./hash.js";
import { lunaPerformancePathMatches, } from "./luna-performance-retrieval.js";
export const LUNA_PERFORMANCE_EXPERIMENT_VERSION = "luna-performance-optimization-v1";
export const LUNA_PERFORMANCE_EVIDENCE_BUDGET = 6_000;
export const LUNA_EVIDENCE_PRESENTATIONS = [
    "raw_excerpts",
    "grouped_by_area",
    "path_symbol_excerpt",
    "with_retrieval_reason",
    "four_long",
    "eight_short",
    "explicit_context_separation",
];
export const LUNA_INFERENCE_STRATEGIES = [
    "direct",
    "evidence_first",
    "independent_per_area",
];
const clip = (value, maximum) => value.length <= maximum
    ? value
    : `${value.slice(0, Math.max(0, maximum - 24)).trimEnd()}\n…[evidence clipped]…`;
const snippetBlock = (snippet, input) => {
    const parts = [];
    if (input.includePath) {
        parts.push(`Path: ${snippet.path}:${snippet.startLine}-${snippet.endLine}`);
    }
    if (input.includeSymbols) {
        parts.push(`Symbol: ${snippet.symbols.length ? snippet.symbols.join(" | ") : "(none detected)"}`);
    }
    parts.push(`Relevant excerpt:\n${clip(snippet.text, input.maximumSnippetCharacters)}`);
    if (input.includeReason) {
        parts.push(`Retrieval reason: ${snippet.retrievalReason}`);
    }
    return parts.join("\n");
};
const boundedBlocks = (prefix, blocks, maximumCharacters) => {
    let output = prefix;
    for (const block of blocks) {
        const candidate = `${output}\n\n${block}`;
        if (candidate.length > maximumCharacters)
            break;
        output = candidate;
    }
    if (output === prefix && blocks[0]) {
        output = clip(`${prefix}\n\n${blocks[0]}`, maximumCharacters);
    }
    return output;
};
export const renderLunaPerformanceEvidence = (input) => {
    const maximumCharacters = input.maximumCharacters ?? LUNA_PERFORMANCE_EVIDENCE_BUDGET;
    const prefix = [
        "[PRE-TASK REPOSITORY EVIDENCE]",
        "Retrieved from the exact pre-task snapshot using task-aware context. These excerpts are search evidence, not labels, known changed files, or completed diffs.",
    ].join("\n");
    if (input.retrieval.candidates.length === 0) {
        return `${prefix}\n\nNo repository excerpt was retrieved.`;
    }
    if (input.presentation === "raw_excerpts") {
        return boundedBlocks(prefix, input.retrieval.candidates
            .slice(0, 4)
            .map((snippet) => clip(snippet.text, 1_350)), maximumCharacters);
    }
    if (input.presentation === "grouped_by_area") {
        const groups = new Map();
        for (const snippet of input.retrieval.candidates.slice(0, 4)) {
            const group = snippet.likelyAreaIds[0] ?? "unmapped";
            groups.set(group, [...(groups.get(group) ?? []), snippet]);
        }
        const blocks = [...groups.entries()].map(([areaId, snippets]) => [
            `Likely area from repository anchors: ${areaId}`,
            ...snippets.map((snippet) => snippetBlock(snippet, {
                includePath: true,
                includeSymbols: true,
                includeReason: false,
                maximumSnippetCharacters: 1_100,
            })),
        ].join("\n\n"));
        return boundedBlocks(prefix, blocks, maximumCharacters);
    }
    if (input.presentation === "path_symbol_excerpt") {
        return boundedBlocks(prefix, input.retrieval.candidates.slice(0, 4).map((snippet) => snippetBlock(snippet, {
            includePath: true,
            includeSymbols: true,
            includeReason: false,
            maximumSnippetCharacters: 1_100,
        })), maximumCharacters);
    }
    if (input.presentation === "eight_short") {
        return boundedBlocks(prefix, input.retrieval.candidates.slice(0, 8).map((snippet) => snippetBlock(snippet, {
            includePath: true,
            includeSymbols: true,
            includeReason: true,
            maximumSnippetCharacters: 430,
        })), maximumCharacters);
    }
    if (input.presentation === "four_long") {
        return boundedBlocks(prefix, input.retrieval.candidates.slice(0, 4).map((snippet) => snippetBlock(snippet, {
            includePath: true,
            includeSymbols: true,
            includeReason: false,
            maximumSnippetCharacters: 1_250,
        })), maximumCharacters);
    }
    return boundedBlocks(prefix, input.retrieval.candidates.slice(0, 4).map((snippet) => snippetBlock(snippet, {
        includePath: true,
        includeSymbols: true,
        includeReason: true,
        maximumSnippetCharacters: 1_050,
    })), maximumCharacters);
};
const cleanTitle = (value) => value.split("\n", 1)[0].trim().slice(0, 220);
export const buildEnrichedAreaCards = (input) => {
    const byId = new Map(input.cards.map((card) => [card.areaId, card]));
    return input.cards.map((card) => {
        const inferredExclusions = card.confusableAreaIds
            .map((areaId) => byId.get(areaId))
            .filter((value) => Boolean(value))
            .map((other) => `Work primarily owned by ${other.name} when the requested responsibility is ${other.description}`);
        const inferredBoundaries = card.confusableAreaIds
            .map((areaId) => byId.get(areaId))
            .filter((value) => Boolean(value))
            .map((other) => `${card.name} owns ${card.inclusions.slice(0, 2).join(" and ")}; ${other.name} owns ${other.inclusions.slice(0, 2).join(" and ")}.`);
        const multiAreaRules = [
            `Multi-area rule: include ${card.name} together with another area only when the requested implementation materially changes responsibilities owned by both areas; a dependency, API call, shared type, or incidental file reference alone is not enough.`,
            `Multi-area rule: include ${card.name} when its owned behavior must change even if the initiating symptom appears in a neighboring area; omit it when its behavior remains unchanged.`,
        ];
        const examples = (input.referenceExamplesByArea?.[card.areaId] ?? [])
            .slice(0, 3)
            .map((example) => `Example task: ${cleanTitle(example)}`);
        const codeSummaries = [
            ...card.codeSummaries,
            `Representative repository locations: ${card.pathAnchors.join(", ") || "not specified"}.`,
            `Representative symbols or components: ${[...card.symbolAnchors, ...card.componentAnchors].join(", ") || "not specified"}.`,
            ...examples,
        ];
        return {
            ...card,
            registryVersion: `${card.registryVersion}-enriched-v1`,
            exclusions: [...new Set([...card.exclusions, ...inferredExclusions])],
            boundaryExamples: [
                ...new Set([
                    ...card.boundaryExamples,
                    ...inferredBoundaries,
                    ...multiAreaRules,
                ]),
            ],
            codeSummaries: [...new Set(codeSummaries)],
            generatorVersion: `${card.generatorVersion}+performance-enrichment-v1`,
            sourceHashes: [
                ...new Set([
                    ...card.sourceHashes,
                    contentHash({
                        areaId: card.areaId,
                        inferredExclusions,
                        inferredBoundaries,
                        multiAreaRules,
                        examples,
                    }),
                ]),
            ],
        };
    });
};
const baseSystem = (strategy) => {
    const common = [
        "You are a runtime classifier for coding tasks.",
        "Use the complete task-aware context, frozen Area Registry, and supplied repository evidence. Never infer an area from isolated wording when the context or repository evidence contradicts it.",
        renderLunaAccuracyProcedure("decomposed"),
        "",
        "Return one strict JSON object and no prose outside it.",
        "Return a genuine probability distribution over the four mutually exclusive scope outcomes; those probabilities must sum to exactly 1.",
        "Return the probability that every registered area is materially required, conditional on this being known repository work.",
        "Area probabilities are independent marginals: multiple areas may simultaneously have high probability and they must not be normalized to sum to 1.",
        "Include every area exactly once, ordered from highest to lowest probability.",
        "Do not threshold probabilities or emit one hard label.",
    ];
    if (strategy === "evidence_first") {
        common.push("Before the probability fields in the same JSON response, record a compact observable evidence assessment. Each fact must identify which registered areas it supports or contradicts. Do not expose hidden chain-of-thought.", "Use that assessment to compute the final probability fields rather than merely repeating task wording.");
    }
    else if (strategy === "independent_per_area") {
        common.push("Assess every registered area independently. For each area, record short observable supporting facts and counterevidence before its probability.", "Apply exclusions and neighboring-area boundaries explicitly. Empty evidence arrays are allowed when no grounded fact exists. Do not expose hidden chain-of-thought.");
    }
    else {
        common.push("Provide at most three short observable evidence facts. Do not expose hidden chain-of-thought.");
    }
    return common.join("\n");
};
const evidenceAssessmentSchema = (areaIds) => {
    const direct = buildLunaDistributionalResponseSchema(areaIds);
    return {
        type: "object",
        additionalProperties: false,
        required: [
            "evidence_assessment",
            "scope_probabilities",
            "area_probabilities_given_known",
            "evidence",
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
                            items: { type: "string", enum: [...areaIds] },
                        },
                        contradicts_area_ids: {
                            type: "array",
                            maxItems: 3,
                            items: { type: "string", enum: [...areaIds] },
                        },
                    },
                },
            },
            ...direct.properties,
        },
    };
};
const independentAreaSchema = (areaIds) => ({
    type: "object",
    additionalProperties: false,
    required: ["scope_probabilities", "area_assessments", "evidence"],
    properties: {
        scope_probabilities: buildLunaDistributionalResponseSchema(areaIds).properties.scope_probabilities,
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
                    "probability_required",
                ],
                properties: {
                    area_id: { type: "string", enum: [...areaIds] },
                    supporting_facts: {
                        type: "array",
                        maxItems: 3,
                        items: { type: "string", maxLength: 240 },
                    },
                    counterevidence: {
                        type: "array",
                        maxItems: 3,
                        items: { type: "string", maxLength: 240 },
                    },
                    probability_required: {
                        type: "number",
                        minimum: 0,
                        maximum: 1,
                    },
                },
            },
        },
        evidence: buildLunaDistributionalResponseSchema(areaIds).properties.evidence,
    },
});
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const parseStrategyDecision = (content, strategy, areaIds) => {
    if (strategy === "direct") {
        return parseLunaDistributionalDecision(content, areaIds);
    }
    const raw = JSON.parse(content);
    if (!isRecord(raw))
        throw new Error("Invalid strategy decision");
    if (strategy === "evidence_first") {
        return parseLunaDistributionalDecision(JSON.stringify({
            scope_probabilities: raw.scope_probabilities,
            area_probabilities_given_known: raw.area_probabilities_given_known,
            evidence: raw.evidence,
        }), areaIds);
    }
    if (!Array.isArray(raw.area_assessments)) {
        throw new Error("Missing independent area assessments");
    }
    return parseLunaDistributionalDecision(JSON.stringify({
        scope_probabilities: raw.scope_probabilities,
        area_probabilities_given_known: raw.area_assessments.map((item) => {
            if (!isRecord(item))
                throw new Error("Invalid area assessment");
            return {
                area_id: item.area_id,
                probability_required: item.probability_required,
            };
        }),
        evidence: raw.evidence,
    }), areaIds);
};
const responseSchema = (strategy, areaIds) => strategy === "direct"
    ? buildLunaDistributionalResponseSchema(areaIds)
    : strategy === "evidence_first"
        ? evidenceAssessmentSchema(areaIds)
        : independentAreaSchema(areaIds);
export const buildLunaPerformancePrompt = (input) => {
    const separate = input.presentation === "explicit_context_separation";
    const taskContext = serializeLunaAccuracyTaskContext(input.episode, input.profile, "labeled_sections", "6k", "components");
    const registry = renderLunaAccuracyAreaRegistry(input.cards, "full", "compact_json", "canonical", input.seed);
    return {
        system: baseSystem(input.inferenceStrategy),
        user: [
            "[FROZEN AREA REGISTRY]",
            registry,
            "",
            "[TASK-AWARE CONVERSATION AND REPOSITORY PROFILE]",
            taskContext,
            "",
            separate
                ? "[TASK-SPECIFIC REPOSITORY EVIDENCE — SEPARATE FROM CONVERSATION]"
                : "[RELEVANT DIAGNOSTIC CONTINUATION — RETRIEVED REPOSITORY EVIDENCE]",
            input.evidence,
        ].join("\n"),
        serializationVersion: [
            LUNA_PERFORMANCE_EXPERIMENT_VERSION,
            input.presentation,
            input.inferenceStrategy,
            input.cards[0]?.registryVersion ?? "registry",
        ].join("/"),
    };
};
const predictionFromCall = (input, call) => ({
    schemaVersion: 1,
    taskEpisodeId: input.episode.id,
    classifier: input.classifier,
    ...input.parsed,
    durationMs: call.durationMs,
    providerCalls: 1,
    inputTokens: call.usage.inputTokens,
    cachedInputTokens: call.usage.cachedInputTokens,
    outputTokens: call.usage.outputTokens,
    reasoningOutputTokens: call.usage.reasoningOutputTokens,
    costUsd: call.usage.costUsd,
});
export const classifyLunaPerformanceCase = async (input) => {
    const evidence = renderLunaPerformanceEvidence({
        retrieval: input.retrieval,
        presentation: input.evidencePresentation,
    });
    const prompt = buildLunaPerformancePrompt({
        episode: input.episode,
        profile: input.profile,
        cards: input.cards,
        evidence,
        presentation: input.evidencePresentation,
        inferenceStrategy: input.inferenceStrategy,
        seed: input.seed,
    });
    const areaIds = input.cards.map((card) => card.areaId);
    const call = await callLunaOpenRouter({
        messages: [
            { role: "system", content: prompt.system },
            { role: "user", content: prompt.user },
        ],
        seed: input.seed,
        // High-reasoning Luna occasionally consumes tens of thousands of hidden
        // reasoning tokens before emitting a small strict JSON object. Use the
        // provider-advertised completion ceiling uniformly across treatments so a
        // rare long trace is not censored or retried under a different treatment.
        // This does not increase billed output when the model finishes normally.
        maxTokens: 128_000,
        price: input.price,
        responseSchema: responseSchema(input.inferenceStrategy, areaIds),
        options: {},
    });
    if (!call.message.content) {
        throw new Error("Luna returned no performance-classification content");
    }
    const parsed = parseStrategyDecision(call.message.content, input.inferenceStrategy, areaIds);
    const prediction = predictionFromCall({
        episode: input.episode,
        classifier: [
            LUNA_ACCURACY_MODEL,
            LUNA_PERFORMANCE_EXPERIMENT_VERSION,
            input.armId,
        ].join(":"),
        parsed,
    }, call);
    return {
        schemaVersion: 1,
        specificationVersion: LUNA_PERFORMANCE_EXPERIMENT_VERSION,
        armId: input.armId,
        taskEpisodeId: input.episode.id,
        repositoryId: input.episode.repositoryId,
        seed: input.seed,
        retrievalVariant: input.retrieval.variant,
        evidencePresentation: input.evidencePresentation,
        areaCardVariant: input.areaCardVariant,
        inferenceStrategy: input.inferenceStrategy,
        prediction,
        prompt: {
            serializationVersion: prompt.serializationVersion,
            systemSha256: sha256(prompt.system),
            userSha256: sha256(prompt.user),
            evidenceSha256: sha256(evidence),
            evidenceCharacters: evidence.length,
        },
    };
};
const average = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
export const ensembleLunaDistributionalPredictions = (input) => {
    if (input.predictions.length < 2) {
        throw new Error("Ensemble requires at least two predictions");
    }
    const episodeId = input.predictions[0].taskEpisodeId;
    if (input.predictions.some((prediction) => prediction.taskEpisodeId !== episodeId)) {
        throw new Error("Cannot ensemble different task episodes");
    }
    const areaIds = input.predictions[0].areaProbabilitiesGivenKnown.map((item) => item.areaId);
    const areaProbabilitiesGivenKnown = areaIds
        .map((areaId) => ({
        areaId,
        probabilityRequiredGivenKnown: average(input.predictions.map((prediction) => prediction.areaProbabilitiesGivenKnown.find((item) => item.areaId === areaId)?.probabilityRequiredGivenKnown ?? 0)),
    }))
        .sort((left, right) => right.probabilityRequiredGivenKnown -
        left.probabilityRequiredGivenKnown ||
        left.areaId.localeCompare(right.areaId));
    const scopeProbabilities = Object.fromEntries(LUNA_SCOPE_IDS.map((scopeId) => [
        scopeId,
        average(input.predictions.map((prediction) => prediction.scopeProbabilities[scopeId])),
    ]));
    return {
        schemaVersion: 1,
        taskEpisodeId: episodeId,
        classifier: input.classifier,
        scopeProbabilities,
        areaProbabilitiesGivenKnown,
        evidence: input.predictions[0].evidence,
        durationMs: input.predictions.reduce((sum, prediction) => sum + prediction.durationMs, 0),
        providerCalls: input.predictions.reduce((sum, prediction) => sum + prediction.providerCalls, 0),
        inputTokens: input.predictions.reduce((sum, prediction) => sum + prediction.inputTokens, 0),
        cachedInputTokens: input.predictions.reduce((sum, prediction) => sum + prediction.cachedInputTokens, 0),
        outputTokens: input.predictions.reduce((sum, prediction) => sum + prediction.outputTokens, 0),
        reasoningOutputTokens: input.predictions.reduce((sum, prediction) => sum + prediction.reasoningOutputTokens, 0),
        costUsd: input.predictions.reduce((sum, prediction) => sum + prediction.costUsd, 0),
    };
};
const safeProbability = (value) => Math.min(1 - 1e-9, Math.max(1e-9, value));
const binaryTemperature = (probability, temperature) => {
    const value = safeProbability(probability);
    const logit = Math.log(value / (1 - value)) / temperature;
    return 1 / (1 + Math.exp(-logit));
};
const scopeTemperature = (values, temperature) => {
    const powered = Object.fromEntries(LUNA_SCOPE_IDS.map((scopeId) => [
        scopeId,
        safeProbability(values[scopeId]) ** (1 / temperature),
    ]));
    const sum = LUNA_SCOPE_IDS.reduce((total, scopeId) => total + powered[scopeId], 0);
    return Object.fromEntries(LUNA_SCOPE_IDS.map((scopeId) => [scopeId, powered[scopeId] / sum]));
};
const scopeNll = (labels, predictions, temperature) => average(labels.map((label) => {
    const prediction = predictions.get(label.taskEpisodeId);
    if (!prediction)
        throw new Error(`Missing calibration prediction`);
    const adjusted = scopeTemperature(prediction.scopeProbabilities, temperature);
    return -Math.log(safeProbability(adjusted[scopeTargetForLabel(label)]));
}));
const areaNll = (labels, predictions, temperature, areaIds) => {
    const losses = [];
    for (const label of labels) {
        if (!label.known)
            continue;
        const prediction = predictions.get(label.taskEpisodeId);
        if (!prediction)
            throw new Error("Missing calibration prediction");
        const gold = new Set(label.selectedAreaIds);
        for (const areaId of areaIds) {
            const raw = prediction.areaProbabilitiesGivenKnown.find((item) => item.areaId === areaId)?.probabilityRequiredGivenKnown ?? 0;
            const probability = safeProbability(binaryTemperature(raw, temperature));
            losses.push(gold.has(areaId)
                ? -Math.log(probability)
                : -Math.log(1 - probability));
        }
    }
    return losses.length ? average(losses) : 0;
};
const temperatureGrid = () => Array.from({ length: 151 }, (_, index) => 0.25 + index * 0.025);
export const fitLunaTemperatureCalibration = (input) => {
    const predictions = new Map(input.predictions.map((prediction) => [
        prediction.taskEpisodeId,
        prediction,
    ]));
    const scope = temperatureGrid()
        .map((temperature) => ({
        temperature,
        loss: scopeNll(input.labels, predictions, temperature),
    }))
        .sort((left, right) => left.loss - right.loss || left.temperature - right.temperature)[0];
    const area = temperatureGrid()
        .map((temperature) => ({
        temperature,
        loss: areaNll(input.labels, predictions, temperature, input.areaIds),
    }))
        .sort((left, right) => left.loss - right.loss || left.temperature - right.temperature)[0];
    return {
        schemaVersion: 1,
        scopeTemperature: scope.temperature,
        areaTemperature: area.temperature,
        developmentCases: input.labels.length,
        objective: {
            scopeLogLoss: scope.loss,
            areaLogLoss: area.loss,
        },
    };
};
export const applyLunaTemperatureCalibration = (input) => ({
    ...input.prediction,
    classifier: `${input.prediction.classifier}:temperature-calibrated`,
    scopeProbabilities: scopeTemperature(input.prediction.scopeProbabilities, input.calibration.scopeTemperature),
    areaProbabilitiesGivenKnown: input.prediction.areaProbabilitiesGivenKnown
        .map((item) => ({
        ...item,
        probabilityRequiredGivenKnown: binaryTemperature(item.probabilityRequiredGivenKnown, input.calibration.areaTemperature),
    }))
        .sort((left, right) => right.probabilityRequiredGivenKnown -
        left.probabilityRequiredGivenKnown ||
        left.areaId.localeCompare(right.areaId)),
});
export const summarizeLunaPerformanceArm = (input) => evaluateLunaDistributionalPredictions(input);
export const analyzeLunaRetrievalClassificationFailures = (input) => {
    const labels = new Map(input.labels.map((label) => [label.taskEpisodeId, label]));
    const predictions = new Map(input.predictions.map((prediction) => [
        prediction.taskEpisodeId,
        prediction,
    ]));
    if (labels.size !== input.labels.length ||
        predictions.size !== input.predictions.length ||
        input.results.length !== labels.size ||
        labels.size !== predictions.size) {
        throw new Error("Retrieval diagnostics require unique one-to-one results, labels, and predictions");
    }
    let scopeCorrect = 0;
    let knownCases = 0;
    let areaHitAt1 = 0;
    let allGoldAt3 = 0;
    let eligiblePathCases = 0;
    let pathHitCases = 0;
    let hitSuccess = 0;
    let hitFailure = 0;
    let missSuccess = 0;
    let missFailure = 0;
    for (const result of input.results) {
        const label = labels.get(result.taskEpisodeId);
        const prediction = predictions.get(result.taskEpisodeId);
        if (!label || !prediction) {
            throw new Error(`Missing retrieval diagnostic input ${result.taskEpisodeId}`);
        }
        const topScope = [...LUNA_SCOPE_IDS].sort((left, right) => prediction.scopeProbabilities[right] -
            prediction.scopeProbabilities[left] ||
            left.localeCompare(right))[0];
        const correctScope = topScope === scopeTargetForLabel(label);
        if (correctScope)
            scopeCorrect += 1;
        let correctKnownAreas = true;
        if (label.known) {
            knownCases += 1;
            const ranking = [...prediction.areaProbabilitiesGivenKnown].sort((left, right) => right.probabilityRequiredGivenKnown -
                left.probabilityRequiredGivenKnown ||
                left.areaId.localeCompare(right.areaId));
            if (label.selectedAreaIds.includes(ranking[0]?.areaId ?? "")) {
                areaHitAt1 += 1;
            }
            const top3 = new Set(ranking.slice(0, 3).map((item) => item.areaId));
            correctKnownAreas = label.selectedAreaIds.every((areaId) => top3.has(areaId));
            if (correctKnownAreas)
                allGoldAt3 += 1;
        }
        if (label.relevantPaths.length === 0)
            continue;
        eligiblePathCases += 1;
        const pathHit = result.candidates.slice(0, 4).some((candidate) => label.relevantPaths.some((relevant) => lunaPerformancePathMatches(candidate.path, relevant)));
        const classificationSuccess = correctScope && correctKnownAreas;
        if (pathHit) {
            pathHitCases += 1;
            if (classificationSuccess)
                hitSuccess += 1;
            else
                hitFailure += 1;
        }
        else if (classificationSuccess) {
            missSuccess += 1;
        }
        else {
            missFailure += 1;
        }
    }
    const ratio = (numerator, denominator) => denominator === 0 ? 0 : numerator / denominator;
    return {
        cases: input.results.length,
        knownCases,
        scopeCorrectRate: ratio(scopeCorrect, input.results.length),
        areaHitAt1: ratio(areaHitAt1, knownCases),
        allGoldAt3: ratio(allGoldAt3, knownCases),
        eligiblePathCases,
        pathHitAt4Rate: ratio(pathHitCases, eligiblePathCases),
        pathHitAndClassificationSuccessCases: hitSuccess,
        pathHitAndClassificationFailureCases: hitFailure,
        pathMissAndClassificationSuccessCases: missSuccess,
        pathMissAndClassificationFailureCases: missFailure,
        classificationSuccessGivenPathHitAt4: ratio(hitSuccess, hitSuccess + hitFailure),
        classificationSuccessGivenPathMissAt4: ratio(missSuccess, missSuccess + missFailure),
    };
};
