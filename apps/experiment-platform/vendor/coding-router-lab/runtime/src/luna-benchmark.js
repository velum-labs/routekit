import { calculateExtendedMetrics } from "./experiment-metrics.js";
const percentile = (values, fraction) => {
    if (!values.length)
        return null;
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.floor((sorted.length - 1) * fraction)] ?? null;
};
const setKey = (values) => [...values].sort().join(",");
export const selectStratifiedLunaCanary = (episodes, labels, maximumCases = 10) => {
    const episodeById = new Map(episodes.map((episode) => [episode.id, episode]));
    const selected = new Set();
    const hasContext = (label) => {
        const episode = episodeById.get(label.taskEpisodeId);
        return Boolean(episode?.taskAnchor ||
            episode?.precedingAssistant ||
            episode?.earlierUserContext?.length ||
            episode?.relevantDiagnostic);
    };
    const inSplit = (label, split) => episodeById.get(label.taskEpisodeId)?.split === split;
    const orderedBuckets = [
        (label) => inSplit(label, "validation") &&
            label.known &&
            label.selectedAreaIds.length === 2 &&
            hasContext(label),
        (label) => inSplit(label, "test") &&
            !label.known &&
            label.unknownType === "new_repository_area" &&
            hasContext(label),
        (label) => inSplit(label, "test") &&
            label.known &&
            label.selectedAreaIds.length === 2,
        (label) => inSplit(label, "test") &&
            label.known &&
            label.selectedAreaIds.length === 1,
        (label) => inSplit(label, "validation") &&
            label.known &&
            label.selectedAreaIds.length === 1,
        (label) => inSplit(label, "test") &&
            !label.known &&
            label.unknownType === "new_repository_area" &&
            !hasContext(label),
        (label) => inSplit(label, "test") &&
            !label.known &&
            label.unknownType === "outside_scope",
        (label) => inSplit(label, "validation") &&
            !label.known &&
            label.unknownType === "outside_scope",
        (label) => inSplit(label, "validation") &&
            !label.known &&
            label.unknownType === "insufficient_information",
        (label) => inSplit(label, "test") &&
            !label.known &&
            label.unknownType === "insufficient_information",
    ];
    for (const bucket of orderedBuckets) {
        const match = labels.find((label) => !selected.has(label.taskEpisodeId) &&
            episodeById.has(label.taskEpisodeId) &&
            bucket(label));
        if (match)
            selected.add(match.taskEpisodeId);
        if (selected.size >= maximumCases)
            break;
    }
    for (const split of ["test", "validation"]) {
        for (const label of labels) {
            if (selected.size >= maximumCases)
                break;
            if (inSplit(label, split) &&
                episodeById.has(label.taskEpisodeId)) {
                selected.add(label.taskEpisodeId);
            }
        }
    }
    return [...selected]
        .map((id) => episodeById.get(id))
        .filter((episode) => Boolean(episode));
};
export const representativeLunaPredictions = (predictions) => {
    const seen = new Set();
    const representative = [];
    for (const prediction of predictions) {
        if (seen.has(prediction.taskEpisodeId))
            continue;
        seen.add(prediction.taskEpisodeId);
        representative.push(prediction);
    }
    return representative;
};
const lunaDecisionKey = (prediction) => JSON.stringify({
    known: prediction.known,
    selectedAreaIds: [...prediction.selectedAreaIds].sort(),
    unknownType: prediction.unknownType ?? null,
});
/**
 * Aggregates repeated Luna calls. Latency assumes the repetitions are issued
 * in parallel, so end-to-end latency is the slowest member of the ensemble.
 * Cost and token usage are summed across all members.
 */
export const aggregateLunaEnsemble = (predictions, mode) => {
    const byCase = new Map();
    for (const prediction of predictions) {
        const values = byCase.get(prediction.taskEpisodeId) ?? [];
        values.push(prediction);
        byCase.set(prediction.taskEpisodeId, values);
    }
    return [...byCase.entries()].map(([taskEpisodeId, values]) => {
        if (values.length < 2) {
            throw new Error(`Luna ensemble requires repeated predictions for ${taskEpisodeId}`);
        }
        const counts = new Map();
        for (const prediction of values) {
            const key = lunaDecisionKey(prediction);
            counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        const [winningKey, winningCount] = [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0];
        const accepted = mode === "unanimity"
            ? winningCount === values.length
            : winningCount > values.length / 2;
        const winner = values.find((prediction) => lunaDecisionKey(prediction) === winningKey);
        const total = (key) => {
            const numbers = values
                .map((prediction) => prediction[key])
                .filter((entry) => typeof entry === "number" && Number.isFinite(entry));
            return numbers.length === values.length
                ? numbers.reduce((sum, entry) => sum + entry, 0)
                : undefined;
        };
        const base = accepted
            ? {
                ...winner,
                classifier: `ensemble:${mode}:${winner.classifier}`,
                confidence: Math.min(...values.map((prediction) => prediction.confidence)),
            }
            : {
                ...winner,
                classifier: `ensemble:${mode}:disagreement`,
                selectedAreaIds: [],
                known: false,
                unknownType: "insufficient_information",
                confidence: 0,
                abstentionReason: "ensemble_disagreement",
            };
        const inputCharacters = total("inputCharacters");
        const inputTokens = total("inputTokens");
        const cachedInputTokens = total("cachedInputTokens");
        const outputTokens = total("outputTokens");
        const reasoningOutputTokens = total("reasoningOutputTokens");
        const costUsd = total("costUsd");
        return {
            ...base,
            taskEpisodeId,
            durationMs: Math.max(...values.map((prediction) => prediction.durationMs)),
            ...(inputCharacters !== undefined
                ? { inputCharacters }
                : {}),
            ...(inputTokens !== undefined
                ? { inputTokens }
                : {}),
            ...(cachedInputTokens !== undefined
                ? { cachedInputTokens }
                : {}),
            ...(outputTokens !== undefined
                ? { outputTokens }
                : {}),
            ...(reasoningOutputTokens !== undefined
                ? { reasoningOutputTokens }
                : {}),
            ...(costUsd !== undefined
                ? { costUsd }
                : {}),
        };
    });
};
const repeatability = (predictions) => {
    const byCase = new Map();
    for (const prediction of predictions) {
        const values = byCase.get(prediction.taskEpisodeId) ?? [];
        values.push(prediction);
        byCase.set(prediction.taskEpisodeId, values);
    }
    let repeatedCases = 0;
    let unanimousDecisions = 0;
    const confidenceRanges = [];
    for (const values of byCase.values()) {
        if (values.length < 2)
            continue;
        repeatedCases += 1;
        const decisions = new Set(values.map((prediction) => [
            prediction.known ? "known" : "unknown",
            prediction.unknownType ?? "",
            setKey(prediction.selectedAreaIds),
        ].join(":")));
        if (decisions.size === 1)
            unanimousDecisions += 1;
        const confidence = values.map((prediction) => prediction.confidence);
        confidenceRanges.push(Math.max(...confidence) - Math.min(...confidence));
    }
    return {
        repeatedCases,
        unanimousDecisions,
        unanimousRate: repeatedCases
            ? unanimousDecisions / repeatedCases
            : null,
        confidenceRange: {
            p50: percentile(confidenceRanges, 0.5),
            p95: percentile(confidenceRanges, 0.95),
            maximum: confidenceRanges.length
                ? Math.max(...confidenceRanges)
                : null,
        },
    };
};
const routingConfidencePolicy = (labels, predictions) => {
    const predictionById = new Map(predictions.map((prediction) => [
        prediction.taskEpisodeId,
        prediction,
    ]));
    return [0, 0.8, 0.9, 0.95, 0.97, 0.99].map((minimumConfidence) => {
        let routedCases = 0;
        let falseKnown = 0;
        let falseUnknown = 0;
        let routedCorrect = 0;
        const unknownCases = labels.filter((label) => !label.known).length;
        const knownCases = labels.filter((label) => label.known).length;
        for (const label of labels) {
            const prediction = predictionById.get(label.taskEpisodeId);
            if (!prediction) {
                throw new Error(`Missing confidence-policy prediction for ${label.taskEpisodeId}`);
            }
            const routed = prediction.known &&
                prediction.confidence >= minimumConfidence;
            if (routed) {
                routedCases += 1;
                if (!label.known) {
                    falseKnown += 1;
                }
                else if (label.selectedAreaIds.every((area) => prediction.selectedAreaIds.includes(area))) {
                    routedCorrect += 1;
                }
            }
            else if (label.known) {
                falseUnknown += 1;
            }
        }
        return {
            minimumConfidence,
            routedCases,
            routingCoverage: routedCases / Math.max(1, labels.length),
            falseKnown,
            unknownCases,
            falseKnownRate: unknownCases
                ? falseKnown / unknownCases
                : null,
            falseUnknown,
            knownCases,
            falseUnknownRate: knownCases
                ? falseUnknown / knownCases
                : null,
            routedCorrect,
            correctnessAmongRouted: routedCases
                ? routedCorrect / routedCases
                : null,
        };
    });
};
const safeScore = (summary) => [
    -Number(summary.metrics.core.falseKnownRate ?? 0),
    Number(summary.metrics.correctnessAmongRouted ?? 0),
    summary.metrics.routingCoverage,
    summary.metrics.core.topTwoRecall,
];
const lexicographicallyGreater = (left, right) => left.some((value, index) => value !== right[index] &&
    value > (right[index] ?? Number.NEGATIVE_INFINITY) &&
    left
        .slice(0, index)
        .every((prior, priorIndex) => prior === right[priorIndex]));
export const buildLunaBenchmarkReport = (model, matrix, labels, predictionsByVariant) => {
    const expectedIds = new Set(labels.map((label) => label.taskEpisodeId));
    if (expectedIds.size !== labels.length) {
        throw new Error("Luna benchmark labels contain duplicate task IDs");
    }
    const summaries = matrix.variants.map((variant) => {
        const predictions = predictionsByVariant[variant.id] ?? [];
        const expectedRepetitions = variant.repetitions ?? 1;
        const predictionCounts = new Map();
        for (const prediction of predictions) {
            if (!expectedIds.has(prediction.taskEpisodeId)) {
                throw new Error(`Luna variant ${variant.id} contains a prediction without a label`);
            }
            predictionCounts.set(prediction.taskEpisodeId, (predictionCounts.get(prediction.taskEpisodeId) ?? 0) + 1);
        }
        for (const id of expectedIds) {
            const count = predictionCounts.get(id) ?? 0;
            if (count !== expectedRepetitions) {
                throw new Error(`Luna variant ${variant.id} has ${count} predictions for ${id}; expected ${expectedRepetitions}`);
            }
        }
        if (predictions.length !== labels.length * expectedRepetitions) {
            throw new Error(`Luna variant ${variant.id} prediction count does not match the complete benchmark`);
        }
        const representative = representativeLunaPredictions(predictions);
        const metrics = calculateExtendedMetrics(labels, representative);
        return {
            variant,
            calls: predictions.length,
            uniqueCases: representative.length,
            metrics,
            repeatability: repeatability(predictions),
            confidencePolicy: routingConfidencePolicy(labels, representative),
            projected: {
                costPer1kTasksUsd: metrics.costUsd.perCase === null
                    ? null
                    : metrics.costUsd.perCase * 1_000,
                serialTasksPerMinute: metrics.latencyMs.mean === null
                    ? null
                    : 60_000 / metrics.latencyMs.mean,
            },
        };
    });
    const lowestCost = summaries
        .filter((summary) => summary.metrics.costUsd.perCase !== null)
        .sort((left, right) => Number(left.metrics.costUsd.perCase) -
        Number(right.metrics.costUsd.perCase))[0];
    const lowestLatency = summaries
        .filter((summary) => summary.metrics.latencyMs.p95 !== null)
        .sort((left, right) => Number(left.metrics.latencyMs.p95) -
        Number(right.metrics.latencyMs.p95))[0];
    let safest;
    for (const summary of summaries) {
        if (!safest ||
            lexicographicallyGreater(safeScore(summary), safeScore(safest))) {
            safest = summary;
        }
    }
    return {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        model,
        cases: Math.max(0, ...summaries.map((summary) => summary.uniqueCases)),
        labels: labels.length,
        variants: summaries,
        recommendations: {
            lowestCostVariant: lowestCost?.variant.id ?? null,
            lowestP95LatencyVariant: lowestLatency?.variant.id ?? null,
            highestSafeScoreVariant: safest?.variant.id ?? null,
        },
        limitations: [
            "The benchmark reuses previously inspected development cases; it selects a product configuration but is not an unbiased production estimate.",
            "Latency is end-to-end from this AWS host through OpenRouter and includes network and provider queueing.",
            "Serial tasks/minute is a simple reciprocal of mean latency, not a concurrent load-test result.",
            "Latest-request-only input is intentionally unsupported; every task mode retains task-aware and repository context.",
        ],
    };
};
export const buildLunaEnsembleReport = (labels, predictionsByVariant) => Object.fromEntries(Object.entries(predictionsByVariant).map(([variant, predictions]) => [
    variant,
    Object.fromEntries(["majority", "unanimity"].map((mode) => {
        const aggregated = aggregateLunaEnsemble(predictions, mode);
        const metrics = calculateExtendedMetrics(labels, aggregated);
        return [
            mode,
            {
                metrics,
                projectedCostPer1kTasksUsd: metrics.costUsd.perCase === null
                    ? null
                    : metrics.costUsd.perCase * 1_000,
            },
        ];
    })),
]));
