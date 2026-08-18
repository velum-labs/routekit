import { contentHash } from "./hash.js";
const words = (text) => text.toLowerCase()
    .replace(/[.,!?;:]+(?=\s|$)/gu, " ")
    .replace(/[^a-z0-9_./-]+/gu, " ")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
const normalized = (text) => words(text).join(" ");
const taskIdentityText = (episode) => [
    episode.currentRequest,
    episode.taskAnchor,
    episode.precedingAssistant,
    ...(episode.earlierUserContext ?? []),
    episode.relevantDiagnostic,
].filter(Boolean).join("\n");
const shingles = (text) => {
    const tokens = words(text);
    if (tokens.length < 3)
        return new Set(tokens);
    return new Set(tokens.slice(0, -2).map((_, index) => tokens.slice(index, index + 3).join(" ")));
};
const jaccard = (left, right) => {
    if (left.size === 0 && right.size === 0)
        return 1;
    let intersection = 0;
    for (const item of left)
        if (right.has(item))
            intersection += 1;
    return intersection / (left.size + right.size - intersection);
};
const percentile = (values, fraction) => {
    if (values.length === 0)
        return 0;
    const ordered = [...values].sort((a, b) => a - b);
    return ordered[Math.min(ordered.length - 1, Math.floor((ordered.length - 1) * fraction))] ?? 0;
};
const isV2 = (episode) => episode.schemaVersion === 2;
const likelyCoding = (episode) => {
    const text = [episode.taskAnchor, episode.currentRequest, episode.relevantDiagnostic].filter(Boolean).join(" ");
    return /\b(?:implement|fix|refactor|test|build|lint|typecheck|bug|error|code|function|class|api|cli|daemon|package|module|file|repo|commit|branch|typescript|javascript|python|rust|go|docker|deploy|config|docs?|readme|release|dependency|endpoint|database|schema|migration)\b/iu.test(text);
};
const increment = (record, key) => { record[key] = (record[key] ?? 0) + 1; };
const groupsFrom = (episodes, key) => {
    const grouped = new Map();
    for (const episode of episodes)
        grouped.set(key(episode), [...(grouped.get(key(episode)) ?? []), episode]);
    return [...grouped.entries()].filter(([, values]) => values.length > 1).map(([hash, values]) => ({
        groupHash: contentHash(hash), size: values.length, episodeIds: values.map((item) => item.id).sort(),
        splits: [...new Set(values.map((item) => item.split))].sort(),
    })).sort((a, b) => b.size - a.size || a.groupHash.localeCompare(b.groupHash));
};
const nearGroups = (episodes, threshold = 0.82) => {
    const sets = episodes.map((episode) => shingles(taskIdentityText(episode)));
    const parent = episodes.map((_, index) => index);
    const find = (index) => parent[index] === index ? index : (parent[index] = find(parent[index]));
    const union = (left, right) => { const a = find(left), b = find(right); if (a !== b)
        parent[b] = a; };
    for (let left = 0; left < episodes.length; left += 1) {
        for (let right = left + 1; right < episodes.length; right += 1) {
            if (normalized(taskIdentityText(episodes[left])) === normalized(taskIdentityText(episodes[right])))
                continue;
            if (jaccard(sets[left], sets[right]) >= threshold)
                union(left, right);
        }
    }
    const grouped = new Map();
    episodes.forEach((episode, index) => grouped.set(find(index), [...(grouped.get(find(index)) ?? []), episode]));
    return [...grouped.values()].filter((items) => items.length > 1).map((items) => ({
        groupHash: contentHash(items.map((item) => item.id).sort()), size: items.length,
        episodeIds: items.map((item) => item.id).sort(), splits: [...new Set(items.map((item) => item.split))].sort(),
    })).sort((a, b) => b.size - a.size);
};
export const buildDatasetQualityReport = (episodes, cards) => {
    const repositoryIds = {}, collectorVersions = {};
    const sources = {}, originators = {}, turnStatuses = {};
    let metadataResolved = 0, fallbackResolved = 0, recordedRedactions = 0;
    let referentialRequests = 0, referentialWithPriorContext = 0, taskAwareComplete = 0, diagnosticFollowups = 0;
    let managedContextFindings = 0, secretFindings = 0, likelyCodingCount = 0;
    let contextual = 0, diagnosticHeavy = 0, likelyMultiArea = 0, corrections = 0, insufficientInformation = 0;
    const managed = /<\/?(?:system_instruction|in-app-browser-context|managed-context|developer|environment_context)[^>]*>/iu;
    const secret = /(?:sk-(?:or-)?[A-Za-z0-9_-]{12,}|authorization\s*:\s*bearer\s+[^\s]+|-----BEGIN (?:RSA |OPENSSH )?PRIVATE KEY-----|(?:api[_-]?key|password|secret|token)\s*[=:]\s*["']?[A-Za-z0-9_\-./+]{16,})/iu;
    for (const episode of episodes) {
        increment(repositoryIds, episode.repositoryId);
        const allText = [episode.currentRequest, episode.taskAnchor, episode.precedingAssistant, ...(episode.earlierUserContext ?? []), episode.relevantDiagnostic].filter(Boolean).join("\n");
        if (managed.test(allText))
            managedContextFindings += 1;
        if (secret.test(allText))
            secretFindings += 1;
        if (likelyCoding(episode))
            likelyCodingCount += 1;
        if (episode.relevantDiagnostic)
            diagnosticFollowups += 1;
        if (episode.taskAnchor || episode.precedingAssistant)
            contextual += 1;
        if (episode.relevantDiagnostic)
            diagnosticHeavy += 1;
        if (/\b(?:and|both|across|end-to-end|integrat|migration|release|deploy)\b/iu.test(episode.currentRequest))
            likelyMultiArea += 1;
        if (/\b(?:no[, ]|I meant|rather than|not the|instead)\b/iu.test(episode.currentRequest))
            corrections += 1;
        if (/^(?:fix it|do it|help|continue|try again)[.!?\s]*$/iu.test(episode.currentRequest.trim()) && !episode.taskAnchor && !episode.precedingAssistant)
            insufficientInformation += 1;
        if (isV2(episode)) {
            increment(collectorVersions, episode.provenance.collectorVersion);
            increment(sources, episode.provenance.sessionSource ?? "unknown");
            increment(originators, episode.provenance.originatorId ?? "unknown");
            increment(turnStatuses, episode.provenance.turnStatus);
            recordedRedactions += episode.provenance.redactionCount;
            if (episode.provenance.snapshotSource === "session_meta")
                metadataResolved += 1;
            else
                fallbackResolved += 1;
            if (episode.provenance.context.isReferentialRequest) {
                referentialRequests += 1;
                if (episode.taskAnchor || episode.precedingAssistant || (episode.earlierUserContext?.length ?? 0) > 0)
                    referentialWithPriorContext += 1;
            }
        }
        else
            increment(collectorVersions, "legacy-v1");
        if (episode.taskAnchor && episode.precedingAssistant)
            taskAwareComplete += 1;
    }
    const exactGroups = groupsFrom(episodes, (episode) => normalized(taskIdentityText(episode)));
    const nearDuplicateGroups = nearGroups(episodes);
    const lineageGroups = groupsFrom(episodes, (episode) => episode.lineageHash);
    const chronologicalGroups = new Map();
    for (const episode of episodes)
        chronologicalGroups.set(episode.lineageHash, [...(chronologicalGroups.get(episode.lineageHash) ?? []), episode]);
    const orderedGroups = [...chronologicalGroups.values()].sort((a, b) => Date.parse(a[0].timestamp) - Date.parse(b[0].timestamp));
    const referenceEnd = Math.floor(orderedGroups.length * 0.7), validationEnd = Math.floor(orderedGroups.length * 0.85);
    const candidateChronologicalSplits = { reference: 0, validation: 0, test: 0 };
    orderedGroups.forEach((group, index) => {
        const split = index < referenceEnd ? "reference" : index < validationEnd ? "validation" : "test";
        candidateChronologicalSplits[split] += group.length;
    });
    const validSnapshots = episodes.filter((episode) => /^[0-9a-f]{7,64}$/iu.test(episode.repositorySnapshot)).length;
    const promptLengths = episodes.map((episode) => episode.currentRequest.length);
    const episodeById = new Map(episodes.map((episode) => [episode.id, episode]));
    const areaCoverage = cards?.map((card) => {
        const presentReferenceExamples = card.positiveExampleIds.filter((id) => episodeById.get(id)?.split === "reference").length;
        return {
            areaId: card.areaId, configuredExamples: card.positiveExampleIds.length, presentReferenceExamples,
            missingExampleIds: card.positiveExampleIds.length - presentReferenceExamples,
            meetsMinimumFive: presentReferenceExamples >= 5,
        };
    });
    const validationCount = episodes.filter((episode) => episode.split === "validation").length;
    const testCount = episodes.filter((episode) => episode.split === "test").length;
    const validationTest = episodes.filter((episode) => episode.split !== "reference");
    const chronologyByRepository = new Map();
    for (const episode of episodes)
        chronologyByRepository.set(episode.repositoryId, [...(chronologyByRepository.get(episode.repositoryId) ?? []), episode]);
    const chronologyViolations = [...chronologyByRepository.values()].filter((group) => {
        const reference = group.filter((episode) => episode.split === "reference").map((episode) => Date.parse(episode.timestamp));
        const validation = group.filter((episode) => episode.split === "validation").map((episode) => Date.parse(episode.timestamp));
        const test = group.filter((episode) => episode.split === "test").map((episode) => Date.parse(episode.timestamp));
        if (reference.length === 0 || validation.length === 0 || test.length === 0)
            return true;
        return Math.max(...reference) > Math.min(...validation) || Math.max(...validation) > Math.min(...test);
    }).length;
    const contextualValidationTest = validationTest.filter((episode) => Boolean(episode.taskAnchor || episode.precedingAssistant)).length;
    const likelyMultiAreaValidationTest = validationTest.filter((episode) => /\b(?:and|both|across|end-to-end|integrat|migration|release|deploy)\b/iu.test(episode.currentRequest)).length;
    const stageACanary = {
        ready: episodes.length >= 10 && contextual >= 2 && likelyMultiArea >= 2,
        requiredEpisodes: episodes.length, contextual, likelyMultiArea, diagnosticHeavy,
    };
    const stageBPilot = {
        ready: validationCount >= 20 && testCount >= 30 && contextualValidationTest >= 10 && likelyMultiAreaValidationTest >= 10,
        validation: validationCount, test: testCount, contextualValidationTest, likelyMultiAreaValidationTest,
    };
    const gates = [
        { gate: "single-target-repository", passed: Object.keys(repositoryIds).length === 1, detail: `${Object.keys(repositoryIds).length} repository IDs present` },
        { gate: "no-managed-context", passed: managedContextFindings === 0, detail: `${managedContextFindings} findings` },
        { gate: "no-detected-secrets", passed: secretFindings === 0, detail: `${secretFindings} findings` },
        { gate: "valid-snapshot-for-every-episode", passed: validSnapshots === episodes.length && episodes.length > 0, detail: `${validSnapshots}/${episodes.length}` },
        { gate: "referential-context-available", passed: referentialRequests === referentialWithPriorContext, detail: `${referentialWithPriorContext}/${referentialRequests}` },
        { gate: "no-lineage-crosses-current-splits", passed: lineageGroups.every((group) => group.splits.length === 1), detail: `${lineageGroups.filter((group) => group.splits.length > 1).length} crossing groups` },
        { gate: "no-exact-duplicates-across-current-splits", passed: exactGroups.every((group) => group.splits.length === 1), detail: `${exactGroups.filter((group) => group.splits.length > 1).length} crossing groups` },
        { gate: "current-splits-strictly-chronological", passed: chronologyViolations === 0, detail: `${chronologyViolations} repository violations` },
        ...(areaCoverage ? [{ gate: "five-reference-examples-per-area", passed: areaCoverage.every((area) => area.meetsMinimumFive), detail: `${areaCoverage.filter((area) => area.meetsMinimumFive).length}/${areaCoverage.length} areas` }] : []),
    ];
    const warnings = [];
    if (episodes.length < 50)
        warnings.push("Fewer than 50 episodes; classifier comparisons will have wide uncertainty.");
    if (likelyCodingCount / Math.max(1, episodes.length) < 0.5)
        warnings.push("Most episodes are noncoding or ambiguous by the conservative heuristic; curation is required.");
    if (fallbackResolved > 0)
        warnings.push(`${fallbackResolved} episodes use a fallback snapshot rather than session metadata.`);
    if (!cards)
        warnings.push("Area coverage was not evaluated because no Area Cards were supplied.");
    if (diagnosticFollowups === 0)
        warnings.push("No diagnostic-follow-up episodes were recovered.");
    if (!stageACanary.ready)
        warnings.push("The dataset does not yet meet the structural target for a ten-case contextual/boundary canary.");
    if (!stageBPilot.ready)
        warnings.push("The dataset does not yet meet the Stage B pilot targets (20 validation, 30 test, 10 contextual validation/test, 10 likely multi-area validation/test).");
    if (nearDuplicateGroups.some((group) => group.splits.length > 1))
        warnings.push("Near-duplicate groups cross current splits and require review before labeling.");
    return {
        schemaVersion: 1, generatedAt: new Date().toISOString(), repositoryIds, episodes: episodes.length,
        snapshots: { valid: validSnapshots, metadataResolved, fallbackResolved, resolutionRate: validSnapshots / Math.max(1, episodes.length) },
        context: {
            taskAwareComplete, taskAwareCompleteRate: taskAwareComplete / Math.max(1, episodes.length),
            referentialRequests, referentialWithPriorContext, referentialContextRate: referentialWithPriorContext / Math.max(1, referentialRequests),
            diagnosticFollowups,
        },
        promptLengths: {
            minimum: promptLengths.length ? Math.min(...promptLengths) : 0, p25: percentile(promptLengths, 0.25), median: percentile(promptLengths, 0.5),
            p75: percentile(promptLengths, 0.75), p95: percentile(promptLengths, 0.95), maximum: Math.max(...promptLengths, 0),
        },
        provenance: { collectorVersions, sources, originators, turnStatuses },
        privacy: { managedContextFindings, secretFindings, recordedRedactions },
        duplicates: {
            exactGroups, nearDuplicateGroups, exactCrossSplitGroups: exactGroups.filter((group) => group.splits.length > 1).length,
            nearCrossSplitGroups: nearDuplicateGroups.filter((group) => group.splits.length > 1).length,
        },
        lineage: {
            groups: chronologicalGroups.size, crossSplitGroups: lineageGroups.filter((group) => group.splits.length > 1).length,
            largestGroup: Math.max(...[...chronologicalGroups.values()].map((group) => group.length), 0),
        },
        candidateChronologicalSplits,
        chronology: { currentSplitsStrictlyChronological: chronologyViolations === 0, violations: chronologyViolations },
        taskType: { likelyCoding: likelyCodingCount, likelyNoncodingOrAmbiguous: episodes.length - likelyCodingCount },
        promptForms: {
            explicitOrNatural: episodes.length - contextual, contextual, diagnosticHeavy, likelyMultiArea, corrections, insufficientInformation,
        },
        linkage: {
            changedPathEpisodes: episodes.filter((episode) => (episode.actualChangedPaths?.length ?? 0) > 0).length,
            commitSnapshotEpisodes: validSnapshots,
            prMentionEpisodes: episodes.filter((episode) => /(?:pull\/|#)\d+\b/u.test(episode.currentRequest)).length,
        },
        ...(areaCoverage ? { areaCoverage } : {}),
        experimentTargets: { stageACanary, stageBPilot },
        readiness: { ready: gates.every((gate) => gate.passed) && stageACanary.ready, gates, warnings },
    };
};
