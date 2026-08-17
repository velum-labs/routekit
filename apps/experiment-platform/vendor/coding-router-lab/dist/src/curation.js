import { isReferentialRequest } from "./codex-collector.js";
const isV2 = (episode) => episode.schemaVersion === 2;
const likelyMeta = (text) => /\b(?:which experiment|experiment sequence|what do you need from me|how (?:do|can) I (?:give|send|share)|give you access|can you access|export (?:the|this|my) thread|attach (?:a|the) file|what did you build|what do you see|start openrouter oauth|github cli device login)\b/iu.test(text);
const normalizedTaskEnvelope = (episode) => [
    episode.currentRequest,
    episode.taskAnchor,
    episode.precedingAssistant,
    ...(episode.earlierUserContext ?? []),
    episode.relevantDiagnostic,
].filter(Boolean).join("\n").toLowerCase()
    .replace(/[.,!?;:]+(?=\s|$)/gu, " ")
    .replace(/[^a-z0-9_./-]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
const minimumTimestamp = (episodes) => Math.min(...episodes.map((episode) => Date.parse(episode.timestamp)));
const maximumTimestamp = (episodes) => Math.max(...episodes.map((episode) => Date.parse(episode.timestamp)));
const isChronologicalBoundary = (ordered, index) => {
    const leftMaximum = index === 0 ? Number.NEGATIVE_INFINITY : Math.max(...ordered.slice(0, index).map(maximumTimestamp));
    const rightMinimum = index === ordered.length ? Number.POSITIVE_INFINITY : Math.min(...ordered.slice(index).map(minimumTimestamp));
    return leftMaximum <= rightMinimum;
};
const chronologicalBoundaries = (ordered, targetReference, targetValidationEnd) => {
    let best;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let referenceEnd = 1; referenceEnd <= ordered.length - 2; referenceEnd += 1) {
        if (!isChronologicalBoundary(ordered, referenceEnd))
            continue;
        for (let validationEnd = referenceEnd + 1; validationEnd <= ordered.length - 1; validationEnd += 1) {
            if (!isChronologicalBoundary(ordered, validationEnd))
                continue;
            const distance = Math.abs(referenceEnd - targetReference) + Math.abs(validationEnd - targetValidationEnd);
            if (distance < bestDistance) {
                best = { referenceEnd, validationEnd };
                bestDistance = distance;
            }
        }
    }
    if (!best)
        throw new Error("Unable to assign strictly chronological split boundaries");
    return best;
};
export const curateEpisodes = (episodes, decisions = [], splitFractions = { reference: 0.7, validation: 0.15 }) => {
    if (splitFractions.reference <= 0 || splitFractions.validation <= 0 || splitFractions.reference + splitFractions.validation >= 1) {
        throw new Error("Split fractions must leave positive reference, validation, and test partitions");
    }
    const decisionById = new Map(decisions.map((decision) => [decision.episodeId, decision]));
    const excluded = [];
    const candidates = episodes.filter((episode) => {
        const decision = decisionById.get(episode.id);
        if (decision?.action === "exclude") {
            excluded.push({ episodeId: episode.id, reason: decision.reason });
            return false;
        }
        if (decision?.action === "include")
            return true;
        if (isV2(episode) && episode.provenance.turnStatus !== "complete") {
            excluded.push({ episodeId: episode.id, reason: "turn_not_complete" });
            return false;
        }
        if (likelyMeta(episode.currentRequest)) {
            excluded.push({ episodeId: episode.id, reason: "likely_experiment_or_access_meta" });
            return false;
        }
        if (isReferentialRequest(episode.currentRequest) && !episode.taskAnchor && !episode.precedingAssistant && !(episode.earlierUserContext?.length)) {
            excluded.push({ episodeId: episode.id, reason: "referential_without_visible_context" });
            return false;
        }
        return true;
    });
    const firstByExactEnvelope = new Map();
    for (const episode of [...candidates].sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp) || left.id.localeCompare(right.id))) {
        const envelope = normalizedTaskEnvelope(episode);
        if (firstByExactEnvelope.has(envelope)) {
            excluded.push({ episodeId: episode.id, reason: "repeated_exact_task_envelope" });
        }
        else {
            firstByExactEnvelope.set(envelope, episode);
        }
    }
    const deduplicated = [...firstByExactEnvelope.values()];
    const lineageGroups = new Map();
    for (const episode of deduplicated)
        lineageGroups.set(episode.lineageHash, [...(lineageGroups.get(episode.lineageHash) ?? []), episode]);
    const ordered = [...lineageGroups.values()].sort((left, right) => {
        const time = minimumTimestamp(left) - minimumTimestamp(right);
        return time || maximumTimestamp(left) - maximumTimestamp(right) || left[0].lineageHash.localeCompare(right[0].lineageHash);
    });
    const targetReferenceGroups = Math.floor(ordered.length * splitFractions.reference);
    const targetValidationEnd = targetReferenceGroups + Math.floor(ordered.length * splitFractions.validation);
    const { referenceEnd: referenceGroups, validationEnd } = chronologicalBoundaries(ordered, targetReferenceGroups, targetValidationEnd);
    const curated = [];
    ordered.forEach((group, index) => {
        const split = index < referenceGroups ? "reference" : index < validationEnd ? "validation" : "test";
        curated.push(...group.map((episode) => ({ ...episode, split })));
    });
    curated.sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp) || left.id.localeCompare(right.id));
    const splits = { reference: 0, validation: 0, test: 0 };
    for (const episode of curated)
        splits[episode.split] += 1;
    return { episodes: curated, excluded, summary: { input: episodes.length, included: curated.length, excluded: excluded.length, splits, lineageGroups: ordered.length } };
};
