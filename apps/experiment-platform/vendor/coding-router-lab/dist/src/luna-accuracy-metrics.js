export const LUNA_ACCURACY_TASK_STRATA = [
    "known_single",
    "known_multi",
    "new_repository_area",
    "insufficient_information",
    "outside_scope",
];
export const LUNA_UNKNOWN_TYPES = [
    "new_repository_area",
    "insufficient_information",
    "outside_scope",
];
const sortedUnique = (values) => [...new Set(values)].sort();
const sameSet = (left, right) => {
    const a = sortedUnique(left);
    const b = sortedUnique(right);
    return a.length === b.length &&
        a.every((value, index) => value === b[index]);
};
const ratio = (numerator, denominator) => denominator > 0 ? numerator / denominator : null;
const mean = (values) => values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
const accuracyCount = (correct, count) => ({
    correct,
    count,
    accuracy: ratio(correct, count),
});
const f1Count = (truePositive, falsePositive, falseNegative) => ({
    truePositive,
    falsePositive,
    falseNegative,
    precision: ratio(truePositive, truePositive + falsePositive),
    recall: ratio(truePositive, truePositive + falseNegative),
    f1: ratio(2 * truePositive, 2 * truePositive + falsePositive + falseNegative),
});
const duplicateIds = (values, idOf) => {
    const seen = new Set();
    const duplicates = new Set();
    for (const value of values) {
        const id = idOf(value);
        if (seen.has(id))
            duplicates.add(id);
        seen.add(id);
    }
    return [...duplicates].sort();
};
const formatIds = (ids) => ids.slice(0, 10).join(", ") +
    (ids.length > 10 ? `, ... (${ids.length} total)` : "");
const assertUniqueIds = (values, idOf, kind) => {
    const duplicates = duplicateIds(values, idOf);
    if (duplicates.length > 0) {
        throw new Error(`Duplicate ${kind} IDs: ${formatIds(duplicates)}`);
    }
};
const assertExactIdJoin = (expected, actual, expectedKind, actualKind) => {
    const missing = [...expected].filter((id) => !actual.has(id)).sort();
    const extra = [...actual].filter((id) => !expected.has(id)).sort();
    if (missing.length > 0 || extra.length > 0) {
        const details = [
            missing.length > 0
                ? `missing ${actualKind} for ${expectedKind}: ${formatIds(missing)}`
                : null,
            extra.length > 0
                ? `extra ${actualKind} without ${expectedKind}: ${formatIds(extra)}`
                : null,
        ].filter((value) => value !== null);
        throw new Error(`Incomplete one-to-one join: ${details.join("; ")}`);
    }
};
const assertValidLabels = (labels) => {
    for (const label of labels) {
        if (label.known) {
            if (label.selectedAreaIds.length === 0) {
                throw new Error(`Known label ${label.taskEpisodeId} has no selected area`);
            }
            if (label.unknownType !== undefined) {
                throw new Error(`Known label ${label.taskEpisodeId} unexpectedly has an unknown subtype`);
            }
        }
        else {
            if (label.selectedAreaIds.length > 0) {
                throw new Error(`Unknown label ${label.taskEpisodeId} has selected areas`);
            }
            if (label.unknownType === undefined ||
                !LUNA_UNKNOWN_TYPES.includes(label.unknownType)) {
                throw new Error(`Unknown label ${label.taskEpisodeId} has no valid unknown subtype`);
            }
        }
    }
};
const assertValidPredictionConfidences = (predictions) => {
    for (const prediction of predictions) {
        if (!Number.isFinite(prediction.confidence) ||
            prediction.confidence < 0 ||
            prediction.confidence > 1) {
            throw new Error(`Prediction ${prediction.taskEpisodeId} has confidence outside [0, 1]`);
        }
    }
};
/**
 * Validates and joins a complete label/prediction pair. In particular, this
 * rejects duplicate IDs, missing predictions, and predictions for unlabeled
 * cases rather than allowing Map's last-write-wins behavior to hide them.
 */
const joinLabelsAndPredictions = (labels, predictions) => {
    if (labels.length === 0) {
        throw new Error("Accuracy evaluation requires at least one label");
    }
    assertUniqueIds(labels, (label) => label.taskEpisodeId, "label");
    assertUniqueIds(predictions, (prediction) => prediction.taskEpisodeId, "prediction");
    assertValidLabels(labels);
    assertValidPredictionConfidences(predictions);
    const labelIds = new Set(labels.map((label) => label.taskEpisodeId));
    const predictionIds = new Set(predictions.map((prediction) => prediction.taskEpisodeId));
    assertExactIdJoin(labelIds, predictionIds, "labels", "predictions");
    const predictionById = new Map(predictions.map((prediction) => [
        prediction.taskEpisodeId,
        prediction,
    ]));
    return labels.map((label) => ({
        label,
        prediction: predictionById.get(label.taskEpisodeId),
    }));
};
export const isExactSemanticDecision = (label, prediction) => {
    const routingDecisionMatches = label.known === prediction.known &&
        sameSet(label.selectedAreaIds, prediction.selectedAreaIds);
    return routingDecisionMatches &&
        (label.known || label.unknownType === prediction.unknownType);
};
export const knownProbabilityFromDecisionConfidence = (prediction) => prediction.known
    ? prediction.confidence
    : 1 - prediction.confidence;
const taskStratum = (label) => {
    if (label.known) {
        return label.selectedAreaIds.length === 1
            ? "known_single"
            : "known_multi";
    }
    return label.unknownType;
};
const calibrationBins = (cases, binCount) => {
    const accumulators = Array.from({ length: binCount }, () => ({ count: 0, probabilitySum: 0, knownSum: 0 }));
    for (const item of cases) {
        const probability = knownProbabilityFromDecisionConfidence(item.prediction);
        const index = Math.min(binCount - 1, Math.floor(probability * binCount));
        const bin = accumulators[index];
        bin.count += 1;
        bin.probabilitySum += probability;
        bin.knownSum += item.label.known ? 1 : 0;
    }
    let expectedCalibrationError = 0;
    const bins = accumulators.map((bin, index) => {
        const meanKnownProbability = ratio(bin.probabilitySum, bin.count);
        const observedKnownRate = ratio(bin.knownSum, bin.count);
        const absoluteCalibrationError = meanKnownProbability === null || observedKnownRate === null
            ? null
            : Math.abs(meanKnownProbability - observedKnownRate);
        const weight = bin.count / cases.length;
        expectedCalibrationError +=
            weight * (absoluteCalibrationError ?? 0);
        return {
            index,
            lowerBound: index / binCount,
            upperBound: (index + 1) / binCount,
            includesUpperBound: index === binCount - 1,
            count: bin.count,
            weight,
            meanKnownProbability,
            observedKnownRate,
            absoluteCalibrationError,
        };
    });
    return { expectedCalibrationError, bins };
};
const normalizedThresholds = (cases, requested) => {
    const thresholds = requested === undefined
        ? cases.map((item) => item.prediction.confidence)
        : [...requested];
    for (const threshold of thresholds) {
        if (!Number.isFinite(threshold) ||
            threshold < 0 ||
            threshold > 1) {
            throw new Error("Risk/coverage thresholds must be within [0, 1]");
        }
    }
    return [...new Set(thresholds)].sort((left, right) => right - left);
};
const calculateFromJoinedCases = (cases, options) => {
    const binCount = options.calibrationBinCount ?? 10;
    if (!Number.isInteger(binCount) || binCount < 1 || binCount > 100) {
        throw new Error("calibrationBinCount must be an integer between 1 and 100");
    }
    let semanticCorrect = 0;
    let knownDecisionCorrect = 0;
    let knownCount = 0;
    let unknownDecisionCorrect = 0;
    let unknownCount = 0;
    let knownCodingSetCorrect = 0;
    let knownCodingCount = 0;
    let brierTotal = 0;
    const codingEpisodeIds = options.codingEpisodeIds;
    if (codingEpisodeIds) {
        const caseIds = new Set(cases.map((item) => item.label.taskEpisodeId));
        const unknownCodingIds = [...codingEpisodeIds].filter((id) => !caseIds.has(id));
        if (unknownCodingIds.length > 0) {
            throw new Error(`Coding annotation contains unknown episode IDs: ${formatIds(unknownCodingIds.sort())}`);
        }
    }
    const strataCounts = Object.fromEntries(LUNA_ACCURACY_TASK_STRATA.map((stratum) => [
        stratum,
        { correct: 0, count: 0 },
    ]));
    for (const item of cases) {
        const exact = isExactSemanticDecision(item.label, item.prediction);
        if (exact)
            semanticCorrect += 1;
        const stratum = taskStratum(item.label);
        strataCounts[stratum].count += 1;
        if (exact)
            strataCounts[stratum].correct += 1;
        if (item.label.known) {
            knownCount += 1;
            if (item.prediction.known)
                knownDecisionCorrect += 1;
            if (codingEpisodeIds?.has(item.label.taskEpisodeId)) {
                knownCodingCount += 1;
                if (item.prediction.known &&
                    sameSet(item.label.selectedAreaIds, item.prediction.selectedAreaIds)) {
                    knownCodingSetCorrect += 1;
                }
            }
        }
        else {
            unknownCount += 1;
            if (!item.prediction.known)
                unknownDecisionCorrect += 1;
        }
        const probability = knownProbabilityFromDecisionConfidence(item.prediction);
        const target = item.label.known ? 1 : 0;
        brierTotal += (probability - target) ** 2;
    }
    const taskStrata = Object.fromEntries(LUNA_ACCURACY_TASK_STRATA.map((stratum) => {
        const value = strataCounts[stratum];
        return [stratum, accuracyCount(value.correct, value.count)];
    }));
    const representedTaskStrata = LUNA_ACCURACY_TASK_STRATA.filter((stratum) => taskStrata[stratum].count > 0);
    const missingTaskStrata = LUNA_ACCURACY_TASK_STRATA.filter((stratum) => taskStrata[stratum].count === 0);
    const areaIds = sortedUnique(cases.flatMap((item) => [
        ...item.label.selectedAreaIds,
        ...item.prediction.selectedAreaIds,
    ]));
    const perArea = {};
    for (const areaId of areaIds) {
        let truePositive = 0;
        let falsePositive = 0;
        let falseNegative = 0;
        for (const item of cases) {
            const actual = item.label.selectedAreaIds.includes(areaId);
            const predicted = item.prediction.selectedAreaIds.includes(areaId);
            if (actual && predicted)
                truePositive += 1;
            else if (!actual && predicted)
                falsePositive += 1;
            else if (actual)
                falseNegative += 1;
        }
        perArea[areaId] = f1Count(truePositive, falsePositive, falseNegative);
    }
    const perAreaF1Values = Object.values(perArea)
        .map((value) => value.f1)
        .filter((value) => value !== null);
    const unknownCases = cases.filter((item) => !item.label.known);
    const unknownSubtype = Object.fromEntries(LUNA_UNKNOWN_TYPES.map((unknownType) => {
        let truePositive = 0;
        let falsePositive = 0;
        let falseNegative = 0;
        for (const item of unknownCases) {
            const actual = item.label.unknownType === unknownType;
            const predicted = !item.prediction.known &&
                item.prediction.unknownType === unknownType;
            if (actual && predicted)
                truePositive += 1;
            else if (!actual && predicted)
                falsePositive += 1;
            else if (actual)
                falseNegative += 1;
        }
        return [
            unknownType,
            f1Count(truePositive, falsePositive, falseNegative),
        ];
    }));
    const unknownF1Values = LUNA_UNKNOWN_TYPES
        .map((unknownType) => unknownSubtype[unknownType].f1)
        .filter((value) => value !== null);
    const knownRecall = accuracyCount(knownDecisionCorrect, knownCount);
    const unknownRecall = accuracyCount(unknownDecisionCorrect, unknownCount);
    const balancedAccuracy = knownRecall.accuracy === null || unknownRecall.accuracy === null
        ? null
        : (knownRecall.accuracy + unknownRecall.accuracy) / 2;
    const calibration = calibrationBins(cases, binCount);
    const thresholds = normalizedThresholds(cases, options.riskCoverageThresholds);
    const riskCoverage = thresholds.map((minimumConfidence) => {
        const retained = cases.filter((item) => item.prediction.confidence >= minimumConfidence);
        const correctCases = retained.filter((item) => isExactSemanticDecision(item.label, item.prediction)).length;
        const selectiveAccuracy = ratio(correctCases, retained.length);
        return {
            minimumConfidence,
            coveredCases: retained.length,
            correctCases,
            coverage: retained.length / cases.length,
            selectiveAccuracy,
            risk: selectiveAccuracy === null ? null : 1 - selectiveAccuracy,
        };
    });
    return {
        schemaVersion: 1,
        cases: cases.length,
        exactSemanticDecision: accuracyCount(semanticCorrect, cases.length),
        knownUnknown: {
            knownRecall,
            unknownRecall,
            balancedAccuracy,
        },
        knownCodingExactSet: accuracyCount(knownCodingSetCorrect, knownCodingCount),
        taskStrata,
        macroTaskStratumAccuracy: mean(representedTaskStrata.map((stratum) => taskStrata[stratum].accuracy)),
        representedTaskStrata: [...representedTaskStrata],
        missingTaskStrata: [...missingTaskStrata],
        perArea,
        perAreaMacroF1: mean(perAreaF1Values),
        unknownSubtype,
        unknownSubtypeMacroF1: mean(unknownF1Values),
        knownProbability: {
            derivation: "decision_confidence",
            brierScore: brierTotal / cases.length,
            expectedCalibrationError: calibration.expectedCalibrationError,
            binCount,
            bins: calibration.bins,
        },
        riskCoverage,
    };
};
export const calculateLunaAccuracyMetrics = (labels, predictions, options = {}) => calculateFromJoinedCases(joinLabelsAndPredictions(labels, predictions), options);
/**
 * Builds conservative dependence clusters as connected components: sharing
 * either a sessionHash or a lineageHash places episodes in the same cluster,
 * including transitive links across those two identifiers.
 */
export const buildSessionLineageClusters = (episodes) => {
    assertUniqueIds(episodes, (episode) => episode.id, "episode");
    const parent = episodes.map((_, index) => index);
    const find = (index) => {
        let root = index;
        while (parent[root] !== root)
            root = parent[root];
        while (parent[index] !== index) {
            const next = parent[index];
            parent[index] = root;
            index = next;
        }
        return root;
    };
    const union = (left, right) => {
        const a = find(left);
        const b = find(right);
        if (a !== b)
            parent[b] = a;
    };
    const firstBySession = new Map();
    const firstByLineage = new Map();
    for (const [index, episode] of episodes.entries()) {
        const sessionPeer = firstBySession.get(episode.sessionHash);
        if (sessionPeer === undefined) {
            firstBySession.set(episode.sessionHash, index);
        }
        else {
            union(index, sessionPeer);
        }
        const lineagePeer = firstByLineage.get(episode.lineageHash);
        if (lineagePeer === undefined) {
            firstByLineage.set(episode.lineageHash, index);
        }
        else {
            union(index, lineagePeer);
        }
    }
    const grouped = new Map();
    for (const [index, episode] of episodes.entries()) {
        const root = find(index);
        grouped.set(root, [...(grouped.get(root) ?? []), episode]);
    }
    return [...grouped.values()]
        .map((members) => {
        const episodeIds = members.map((episode) => episode.id).sort();
        return {
            id: episodeIds[0],
            episodeIds,
            sessionHashes: sortedUnique(members.map((episode) => episode.sessionHash)),
            lineageHashes: sortedUnique(members.map((episode) => episode.lineageHash)),
        };
    })
        .sort((left, right) => left.id.localeCompare(right.id));
};
const bootstrapMetricValue = (metrics, metric) => {
    switch (metric) {
        case "exactSemanticDecision":
            return metrics.exactSemanticDecision.accuracy;
        case "knownUnknownBalancedAccuracy":
            return metrics.knownUnknown.balancedAccuracy;
        case "knownCodingExactSetAccuracy":
            return metrics.knownCodingExactSet.accuracy;
        case "macroTaskStratumAccuracy":
            return metrics.macroTaskStratumAccuracy;
        case "perAreaMacroF1":
            return metrics.perAreaMacroF1;
        case "unknownSubtypeMacroF1":
            return metrics.unknownSubtypeMacroF1;
        case "knownProbabilityBrierScore":
            return metrics.knownProbability.brierScore;
        case "knownProbabilityExpectedCalibrationError":
            return metrics.knownProbability.expectedCalibrationError;
    }
};
const lowerIsBetterMetric = (metric) => metric === "knownProbabilityBrierScore" ||
    metric === "knownProbabilityExpectedCalibrationError";
const quantile = (sortedValues, probability) => {
    const index = Math.floor((sortedValues.length - 1) * probability);
    return sortedValues[index];
};
/**
 * Performs a paired non-parametric bootstrap over session/lineage dependence
 * clusters. Both candidates are evaluated on every sampled case. A bootstrap
 * draw is reported as discarded when its selected metric is undefined (for
 * example, balanced accuracy in a draw containing only known cases).
 */
export const compareLunaAccuracyByClusterBootstrap = (episodes, labels, leftPredictions, rightPredictions, options = {}) => {
    const iterations = options.iterations ?? 5_000;
    const seed = options.seed ?? 17;
    const confidenceLevel = options.confidenceLevel ?? 0.95;
    const metric = options.metric ?? "macroTaskStratumAccuracy";
    if (!Number.isInteger(iterations) || iterations < 100) {
        throw new Error("Bootstrap iterations must be an integer of at least 100");
    }
    if (!Number.isInteger(seed) ||
        seed < 0 ||
        seed > 0xffff_ffff) {
        throw new Error("Bootstrap seed must be a uint32 integer");
    }
    if (!Number.isFinite(confidenceLevel) ||
        confidenceLevel <= 0 ||
        confidenceLevel >= 1) {
        throw new Error("confidenceLevel must be between 0 and 1");
    }
    const leftCases = joinLabelsAndPredictions(labels, leftPredictions);
    const rightCases = joinLabelsAndPredictions(labels, rightPredictions);
    assertUniqueIds(episodes, (episode) => episode.id, "episode");
    const labelIds = new Set(labels.map((label) => label.taskEpisodeId));
    const episodeIds = new Set(episodes.map((episode) => episode.id));
    assertExactIdJoin(labelIds, episodeIds, "labels", "episodes");
    const clusters = buildSessionLineageClusters(episodes);
    if (clusters.length === 0) {
        throw new Error("Cluster bootstrap requires at least one cluster");
    }
    const leftById = new Map(leftCases.map((item) => [item.label.taskEpisodeId, item]));
    const rightById = new Map(rightCases.map((item) => [item.label.taskEpisodeId, item]));
    const metricOptions = {
        ...(options.calibrationBinCount === undefined
            ? {}
            : { calibrationBinCount: options.calibrationBinCount }),
        ...(options.codingEpisodeIds === undefined
            ? {}
            : { codingEpisodeIds: options.codingEpisodeIds }),
    };
    const metricOptionsForSample = (sample) => {
        if (options.codingEpisodeIds === undefined)
            return metricOptions;
        const sampledIds = new Set(sample.map((item) => item.label.taskEpisodeId));
        return {
            ...metricOptions,
            codingEpisodeIds: new Set([...options.codingEpisodeIds].filter((id) => sampledIds.has(id))),
        };
    };
    const observedLeft = bootstrapMetricValue(calculateFromJoinedCases(leftCases, metricOptions), metric);
    const observedRight = bootstrapMetricValue(calculateFromJoinedCases(rightCases, metricOptions), metric);
    if (observedLeft === null || observedRight === null) {
        throw new Error(`Bootstrap metric ${metric} is undefined on the full set`);
    }
    let state = seed >>> 0;
    const random = () => {
        state = (1_664_525 * state + 1_013_904_223) >>> 0;
        return state / 2 ** 32;
    };
    const differences = [];
    let discardedIterations = 0;
    for (let iteration = 0; iteration < iterations; iteration += 1) {
        const sampledLeft = [];
        const sampledRight = [];
        for (let draw = 0; draw < clusters.length; draw += 1) {
            const cluster = clusters[Math.floor(random() * clusters.length)];
            for (const episodeId of cluster.episodeIds) {
                sampledLeft.push(leftById.get(episodeId));
                sampledRight.push(rightById.get(episodeId));
            }
        }
        const leftValue = bootstrapMetricValue(calculateFromJoinedCases(sampledLeft, metricOptionsForSample(sampledLeft)), metric);
        const rightValue = bootstrapMetricValue(calculateFromJoinedCases(sampledRight, metricOptionsForSample(sampledRight)), metric);
        if (leftValue === null || rightValue === null) {
            discardedIterations += 1;
            continue;
        }
        differences.push(leftValue - rightValue);
    }
    if (differences.length === 0) {
        throw new Error(`Bootstrap metric ${metric} was undefined in every resample`);
    }
    const bootstrapMean = mean(differences);
    const variance = differences.length > 1
        ? differences.reduce((sum, value) => sum + (value - bootstrapMean) ** 2, 0) / (differences.length - 1)
        : 0;
    const sortedDifferences = [...differences].sort((left, right) => left - right);
    const tail = (1 - confidenceLevel) / 2;
    const higherIsBetter = !lowerIsBetterMetric(metric);
    let better = 0;
    let tied = 0;
    let nonPositive = 0;
    let nonNegative = 0;
    for (const difference of differences) {
        if ((higherIsBetter && difference > 0) ||
            (!higherIsBetter && difference < 0)) {
            better += 1;
        }
        else if (difference === 0) {
            tied += 1;
        }
        if (difference <= 0)
            nonPositive += 1;
        if (difference >= 0)
            nonNegative += 1;
    }
    return {
        schemaVersion: 1,
        clusterDefinition: "session_or_lineage_connected_component",
        metric,
        higherIsBetter,
        cases: labels.length,
        clusters: clusters.length,
        clusterSizes: clusters
            .map((cluster) => cluster.episodeIds.length)
            .sort((left, right) => left - right),
        iterationsRequested: iterations,
        iterationsCompleted: differences.length,
        discardedIterations,
        seed,
        observed: {
            left: observedLeft,
            right: observedRight,
            difference: observedLeft - observedRight,
        },
        bootstrap: {
            meanDifference: bootstrapMean,
            standardError: Math.sqrt(variance),
            confidenceInterval: {
                level: confidenceLevel,
                lower: quantile(sortedDifferences, tail),
                upper: quantile(sortedDifferences, 1 - tail),
            },
            probabilityLeftBetter: (better + 0.5 * tied) / differences.length,
            twoSidedSignPValue: Math.min(1, 2 * Math.min(nonPositive / differences.length, nonNegative / differences.length)),
        },
    };
};
