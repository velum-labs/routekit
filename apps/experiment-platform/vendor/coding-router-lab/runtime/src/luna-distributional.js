import { renderLunaAccuracyAreaRegistry, renderLunaAccuracyProcedure, serializeLunaAccuracyTaskContext, } from "./luna-accuracy-context.js";
export const LUNA_DISTRIBUTIONAL_SCHEMA_VERSION = 1;
export const LUNA_DISTRIBUTIONAL_PROMPT_VERSION = "luna-distributional-task-aware-v1";
export const LUNA_SCOPE_IDS = [
    "known_repository_work",
    "new_repository_area",
    "outside_scope",
    "insufficient_information",
];
const lexicalCompare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const assertProbability = (value, field) => {
    if (typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < 0 ||
        value > 1) {
        throw new Error(`${field} must be a finite probability in [0, 1]`);
    }
};
const exactKeys = (value, expected, field) => {
    const expectedSet = new Set(expected);
    for (const key of Object.keys(value)) {
        if (!expectedSet.has(key)) {
            throw new Error(`Unexpected ${field} field: ${key}`);
        }
    }
    for (const key of expected) {
        if (!(key in value))
            throw new Error(`Missing ${field} field: ${key}`);
    }
};
export const buildLunaDistributionalResponseSchema = (allowedAreaIds) => {
    if (allowedAreaIds.length < 2 ||
        new Set(allowedAreaIds).size !== allowedAreaIds.length) {
        throw new Error("Distributional schema requires unique area IDs");
    }
    return {
        type: "object",
        additionalProperties: false,
        required: [
            "scope_probabilities",
            "area_probabilities_given_known",
            "evidence",
        ],
        properties: {
            scope_probabilities: {
                type: "object",
                additionalProperties: false,
                required: [...LUNA_SCOPE_IDS],
                properties: Object.fromEntries(LUNA_SCOPE_IDS.map((scopeId) => [
                    scopeId,
                    { type: "number", minimum: 0, maximum: 1 },
                ])),
            },
            area_probabilities_given_known: {
                type: "array",
                minItems: allowedAreaIds.length,
                maxItems: allowedAreaIds.length,
                items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["area_id", "probability_required"],
                    properties: {
                        area_id: {
                            type: "string",
                            enum: [...allowedAreaIds],
                        },
                        probability_required: {
                            type: "number",
                            minimum: 0,
                            maximum: 1,
                        },
                    },
                },
            },
            evidence: {
                type: "array",
                maxItems: Math.min(3, allowedAreaIds.length),
                items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["area_id", "fact"],
                    properties: {
                        area_id: {
                            type: "string",
                            enum: [...allowedAreaIds],
                        },
                        fact: {
                            type: "string",
                            minLength: 1,
                            maxLength: 300,
                        },
                    },
                },
            },
        },
    };
};
export const parseLunaDistributionalDecision = (content, allowedAreaIds) => {
    let raw;
    try {
        raw = JSON.parse(content);
    }
    catch {
        throw new Error("Luna returned invalid distributional JSON");
    }
    if (!isRecord(raw)) {
        throw new Error("Luna returned a non-object distributional decision");
    }
    exactKeys(raw, [
        "scope_probabilities",
        "area_probabilities_given_known",
        "evidence",
    ], "distributional decision");
    if (!isRecord(raw.scope_probabilities)) {
        throw new Error("Invalid scope_probabilities");
    }
    const scopeRaw = raw.scope_probabilities;
    exactKeys(scopeRaw, LUNA_SCOPE_IDS, "scope_probabilities");
    const scopeProbabilities = Object.fromEntries(LUNA_SCOPE_IDS.map((scopeId) => {
        const probability = scopeRaw[scopeId];
        assertProbability(probability, `scope_probabilities.${scopeId}`);
        return [scopeId, probability];
    }));
    const scopeSum = LUNA_SCOPE_IDS.reduce((sum, scopeId) => sum + scopeProbabilities[scopeId], 0);
    if (Math.abs(scopeSum - 1) > 0.001) {
        throw new Error(`Scope probabilities must sum to 1; received ${scopeSum}`);
    }
    const allowed = new Set(allowedAreaIds);
    if (allowed.size !== allowedAreaIds.length) {
        throw new Error("Allowed area IDs must be unique");
    }
    if (!Array.isArray(raw.area_probabilities_given_known) ||
        raw.area_probabilities_given_known.length !== allowed.size) {
        throw new Error("Luna must return one marginal for every known area");
    }
    const seenAreas = new Set();
    const areaProbabilitiesGivenKnown = raw.area_probabilities_given_known.map((entry, index) => {
        if (!isRecord(entry)) {
            throw new Error(`Invalid area marginal at index ${index}`);
        }
        exactKeys(entry, ["area_id", "probability_required"], `area marginal ${index}`);
        if (typeof entry.area_id !== "string" ||
            !allowed.has(entry.area_id) ||
            seenAreas.has(entry.area_id)) {
            throw new Error(`Invalid or repeated area marginal ID at ${index}`);
        }
        const probability = entry.probability_required;
        assertProbability(probability, `area marginal ${entry.area_id}`);
        seenAreas.add(entry.area_id);
        return {
            areaId: entry.area_id,
            probabilityRequiredGivenKnown: probability,
        };
    }).sort((left, right) => right.probabilityRequiredGivenKnown -
        left.probabilityRequiredGivenKnown ||
        lexicalCompare(left.areaId, right.areaId));
    for (const areaId of allowed) {
        if (!seenAreas.has(areaId)) {
            throw new Error(`Luna omitted area marginal ${areaId}`);
        }
    }
    if (!Array.isArray(raw.evidence) ||
        raw.evidence.length > Math.min(3, allowed.size)) {
        throw new Error("Invalid distributional evidence");
    }
    const evidence = raw.evidence.map((entry, index) => {
        if (!isRecord(entry)) {
            throw new Error(`Invalid evidence at index ${index}`);
        }
        exactKeys(entry, ["area_id", "fact"], `evidence ${index}`);
        if (typeof entry.area_id !== "string" ||
            !allowed.has(entry.area_id)) {
            throw new Error(`Invalid evidence area at ${index}`);
        }
        if (typeof entry.fact !== "string" ||
            entry.fact.length < 1 ||
            entry.fact.length > 300) {
            throw new Error(`Invalid evidence fact at index ${index}`);
        }
        return {
            areaId: entry.area_id,
            fact: entry.fact,
        };
    });
    return {
        scopeProbabilities,
        areaProbabilitiesGivenKnown,
        evidence,
    };
};
export const buildLunaDistributionalPrompt = (input) => {
    const taskContext = serializeLunaAccuracyTaskContext(input.episode, input.profile, "labeled_sections", "6k", "components");
    const registry = renderLunaAccuracyAreaRegistry(input.cards, "full", "compact_json", "canonical", input.seed);
    return {
        system: [
            "You are a runtime classifier for coding tasks.",
            "Use the complete task-aware context and frozen Area Registry. Never infer an area from isolated wording when the supplied context contradicts it.",
            renderLunaAccuracyProcedure("decomposed"),
            "",
            "Return one JSON object and no prose outside it.",
            "Return a genuine probability distribution over the four mutually exclusive scope outcomes. Those four probabilities must sum to exactly 1.",
            "Then return the probability that every registered area is materially required, conditional on this being known repository work.",
            "Area probabilities are independent marginals: multiple areas can simultaneously have high probability, and they must not be normalized to sum to 1.",
            "Include every registered area exactly once, ordered by probability_required from highest to lowest.",
            "Do not threshold the marginals and do not emit a single chosen label.",
            "Use evidence only from the supplied task-aware context, registry, and repository evidence. Provide at most three short observable evidence facts; do not expose hidden reasoning.",
        ].join("\n"),
        user: [
            "[FROZEN AREA REGISTRY]",
            registry,
            "",
            "[TASK-AWARE CONTEXT]",
            taskContext,
        ].join("\n"),
        seed: input.seed,
        serializationVersion: LUNA_DISTRIBUTIONAL_PROMPT_VERSION,
    };
};
export const scopeTargetForLabel = (label) => {
    if (label.known)
        return "known_repository_work";
    if (label.unknownType === "new_repository_area" ||
        label.unknownType === "outside_scope" ||
        label.unknownType === "insufficient_information") {
        return label.unknownType;
    }
    throw new Error(`Label ${label.taskEpisodeId} lacks an unknown subtype`);
};
const safeLog = (probability) => Math.log(Math.min(1 - 1e-12, Math.max(1e-12, probability)));
const ratio = (numerator, denominator) => denominator === 0 ? 0 : numerator / denominator;
const sameSet = (left, right) => left.length === right.length &&
    [...left].sort(lexicalCompare).every((value, index) => value === [...right].sort(lexicalCompare)[index]);
export const evaluateLunaDistributionalPredictions = (input) => {
    const labels = new Map(input.labels.map((label) => [label.taskEpisodeId, label]));
    const predictions = new Map(input.predictions.map((prediction) => [
        prediction.taskEpisodeId,
        prediction,
    ]));
    if (labels.size !== input.labels.length ||
        predictions.size !== input.predictions.length ||
        labels.size !== predictions.size) {
        throw new Error("Labels and predictions must be unique and one-to-one");
    }
    let scopeCorrect = 0;
    let scopeBrier = 0;
    let scopeLogLoss = 0;
    let knownCases = 0;
    let hit1 = 0;
    let hit2 = 0;
    let hit3 = 0;
    let all1 = 0;
    let all2 = 0;
    let all3 = 0;
    let recall1 = 0;
    let recall2 = 0;
    let recall3 = 0;
    let reciprocalRank = 0;
    let areaBrier = 0;
    let areaLogLoss = 0;
    let areaObservations = 0;
    let goldProbability = 0;
    let goldProbabilityCount = 0;
    let nonGoldProbability = 0;
    let nonGoldProbabilityCount = 0;
    let thresholdExact = 0;
    let truePositive = 0;
    let falsePositive = 0;
    let falseNegative = 0;
    const calibration = Array.from({ length: 10 }, () => ({ count: 0, probability: 0, target: 0 }));
    for (const label of input.labels) {
        const prediction = predictions.get(label.taskEpisodeId);
        if (!prediction) {
            throw new Error(`Missing prediction for ${label.taskEpisodeId}`);
        }
        const scopeTarget = scopeTargetForLabel(label);
        const predictedScope = [...LUNA_SCOPE_IDS].sort((left, right) => prediction.scopeProbabilities[right] -
            prediction.scopeProbabilities[left] ||
            lexicalCompare(left, right))[0];
        if (predictedScope === scopeTarget)
            scopeCorrect += 1;
        for (const scopeId of LUNA_SCOPE_IDS) {
            const target = scopeId === scopeTarget ? 1 : 0;
            const probability = prediction.scopeProbabilities[scopeId];
            scopeBrier += (probability - target) ** 2;
        }
        scopeLogLoss -= safeLog(prediction.scopeProbabilities[scopeTarget]);
        if (!label.known)
            continue;
        knownCases += 1;
        const gold = new Set(label.selectedAreaIds);
        const ranked = prediction.areaProbabilitiesGivenKnown.map((entry) => entry.areaId);
        const at = (k) => ranked.slice(0, k);
        const countGold = (values) => values.filter((areaId) => gold.has(areaId)).length;
        const goldAt1 = countGold(at(1));
        const goldAt2 = countGold(at(2));
        const goldAt3 = countGold(at(3));
        if (goldAt1 > 0)
            hit1 += 1;
        if (goldAt2 > 0)
            hit2 += 1;
        if (goldAt3 > 0)
            hit3 += 1;
        if (goldAt1 === gold.size)
            all1 += 1;
        if (goldAt2 === gold.size)
            all2 += 1;
        if (goldAt3 === gold.size)
            all3 += 1;
        recall1 += ratio(goldAt1, gold.size);
        recall2 += ratio(goldAt2, gold.size);
        recall3 += ratio(goldAt3, gold.size);
        const firstGoldRank = ranked.findIndex((areaId) => gold.has(areaId));
        if (firstGoldRank >= 0)
            reciprocalRank += 1 / (firstGoldRank + 1);
        const predictedAtThreshold = prediction.areaProbabilitiesGivenKnown
            .filter((entry) => entry.probabilityRequiredGivenKnown >= 0.5)
            .map((entry) => entry.areaId);
        if (sameSet(label.selectedAreaIds, predictedAtThreshold)) {
            thresholdExact += 1;
        }
        for (const areaId of input.areaIds) {
            const entry = prediction.areaProbabilitiesGivenKnown.find((candidate) => candidate.areaId === areaId);
            if (!entry) {
                throw new Error(`Prediction ${label.taskEpisodeId} omitted ${areaId}`);
            }
            const target = gold.has(areaId) ? 1 : 0;
            const probability = entry.probabilityRequiredGivenKnown;
            areaBrier += (probability - target) ** 2;
            areaLogLoss -=
                target === 1 ? safeLog(probability) : safeLog(1 - probability);
            areaObservations += 1;
            const bin = calibration[Math.min(9, Math.floor(probability * 10))];
            bin.count += 1;
            bin.probability += probability;
            bin.target += target;
            if (target === 1) {
                goldProbability += probability;
                goldProbabilityCount += 1;
            }
            else {
                nonGoldProbability += probability;
                nonGoldProbabilityCount += 1;
            }
            const selected = probability >= 0.5;
            if (selected && target === 1)
                truePositive += 1;
            else if (selected)
                falsePositive += 1;
            else if (target === 1)
                falseNegative += 1;
        }
    }
    for (const id of predictions.keys()) {
        if (!labels.has(id))
            throw new Error(`Unexpected prediction ${id}`);
    }
    const microPrecision = ratio(truePositive, truePositive + falsePositive);
    const microRecall = ratio(truePositive, truePositive + falseNegative);
    const calibrationError = calibration.reduce((sum, bin) => {
        if (bin.count === 0)
            return sum;
        return (sum +
            (bin.count / Math.max(1, areaObservations)) *
                Math.abs(bin.probability / bin.count - bin.target / bin.count));
    }, 0);
    const totalDuration = input.predictions.reduce((sum, prediction) => sum + prediction.durationMs, 0);
    const usage = input.predictions.reduce((sum, prediction) => ({
        providerCalls: sum.providerCalls + prediction.providerCalls,
        inputTokens: sum.inputTokens + prediction.inputTokens,
        cachedInputTokens: sum.cachedInputTokens + prediction.cachedInputTokens,
        outputTokens: sum.outputTokens + prediction.outputTokens,
        reasoningOutputTokens: sum.reasoningOutputTokens + prediction.reasoningOutputTokens,
        costUsd: sum.costUsd + prediction.costUsd,
    }), {
        providerCalls: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        costUsd: 0,
    });
    return {
        schemaVersion: 1,
        cases: input.labels.length,
        knownCases,
        unknownCases: input.labels.length - knownCases,
        scope: {
            hitAt1: ratio(scopeCorrect, input.labels.length),
            brier: ratio(scopeBrier, input.labels.length),
            logLoss: ratio(scopeLogLoss, input.labels.length),
        },
        areaRanking: {
            hitAt1: ratio(hit1, knownCases),
            hitAt2: ratio(hit2, knownCases),
            hitAt3: ratio(hit3, knownCases),
            allGoldAt1: ratio(all1, knownCases),
            allGoldAt2: ratio(all2, knownCases),
            allGoldAt3: ratio(all3, knownCases),
            recallAt1: ratio(recall1, knownCases),
            recallAt2: ratio(recall2, knownCases),
            recallAt3: ratio(recall3, knownCases),
            meanReciprocalRank: ratio(reciprocalRank, knownCases),
        },
        areaProbability: {
            conditionalBrier: ratio(areaBrier, areaObservations),
            conditionalLogLoss: ratio(areaLogLoss, areaObservations),
            calibrationError10Bins: calibrationError,
            meanGoldProbability: ratio(goldProbability, goldProbabilityCount),
            meanNonGoldProbability: ratio(nonGoldProbability, nonGoldProbabilityCount),
        },
        thresholdPointFive: {
            exactSetAccuracy: ratio(thresholdExact, knownCases),
            microPrecision,
            microRecall,
            microF1: microPrecision + microRecall === 0
                ? 0
                : (2 * microPrecision * microRecall) /
                    (microPrecision + microRecall),
        },
        usage: {
            ...usage,
            meanCostUsd: ratio(usage.costUsd, input.predictions.length),
            meanDurationMs: ratio(totalDuration, input.predictions.length),
        },
    };
};
