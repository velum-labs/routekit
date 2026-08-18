import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
const assertText = (value, field) => {
    if (!value.trim())
        throw new Error(`${field} must not be blank`);
};
const unique = (values) => new Set(values).size === values.length;
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
export const validateRepositoryProfile = (profile) => {
    if (profile.schemaVersion !== 1)
        throw new Error("Unsupported repository profile schema");
    assertText(profile.repositoryId, "repositoryId");
    assertText(profile.snapshot, "snapshot");
    assertText(profile.name, "name");
    assertText(profile.purpose, "purpose");
    if (profile.components.length === 0)
        throw new Error("Repository profile requires components");
};
export const validateAreaCards = (cards, profile, options = {}) => {
    if (cards.length < 2)
        throw new Error("At least two Area Cards are required");
    const ids = cards.map((card) => card.areaId);
    if (!unique(ids))
        throw new Error("Area IDs must be unique");
    const known = new Set(ids);
    for (const card of cards) {
        if (card.schemaVersion !== 1)
            throw new Error(`Unsupported Area Card schema: ${card.areaId}`);
        if (card.repositoryId !== profile.repositoryId)
            throw new Error(`Area Card repository mismatch: ${card.areaId}`);
        assertText(card.name, `${card.areaId}.name`);
        assertText(card.description, `${card.areaId}.description`);
        if (card.inclusions.length < 1)
            throw new Error(`${card.areaId} requires inclusions`);
        if ((options.requirePositiveExamples ?? true) &&
            card.positiveExampleIds.length < 1) {
            throw new Error(`${card.areaId} requires positive examples`);
        }
        for (const confusable of card.confusableAreaIds)
            if (!known.has(confusable))
                throw new Error(`${card.areaId} references unknown confusable area ${confusable}`);
        const codeCharacters = card.codeSnippets.reduce((sum, item) => sum + item.length, 0);
        if (card.codeSnippets.length > 3 || codeCharacters > 3_000)
            throw new Error(`${card.areaId} exceeds code snippet limits`);
    }
};
const managedContext = /<\/?(?:system_instruction|in-app-browser-context|managed-context|developer)[^>]*>/iu;
const likelySecret = /(?:sk-(?:or-)?[A-Za-z0-9_-]{12,}|authorization\s*:\s*bearer|-----BEGIN (?:RSA |OPENSSH )?PRIVATE KEY-----|(?:api[_-]?key|password|secret|token)\s*[=:]\s*["']?[A-Za-z0-9_\-./+]{16,})/iu;
export const validateEpisodes = (episodes, cards) => {
    const ids = new Set();
    const lineageSplit = new Map();
    const contentSplit = new Map();
    const referenceIds = new Set(cards?.flatMap((card) => card.positiveExampleIds) ?? []);
    for (const episode of episodes) {
        if (ids.has(episode.id))
            throw new Error(`Duplicate episode ID: ${episode.id}`);
        ids.add(episode.id);
        assertText(episode.currentRequest, `${episode.id}.currentRequest`);
        const allText = [episode.currentRequest, episode.taskAnchor, episode.precedingAssistant, ...(episode.earlierUserContext ?? []), episode.relevantDiagnostic].filter(Boolean).join("\n");
        if (managedContext.test(allText))
            throw new Error(`${episode.id} contains managed context`);
        if (likelySecret.test(allText))
            throw new Error(`${episode.id} contains a likely secret`);
        const priorSplit = lineageSplit.get(episode.lineageHash);
        if (priorSplit && priorSplit !== episode.split)
            throw new Error(`Lineage crosses splits: ${episode.lineageHash}`);
        lineageSplit.set(episode.lineageHash, episode.split);
        const normalized = normalizedTaskEnvelope(episode);
        const duplicateSplit = contentSplit.get(normalized);
        if (duplicateSplit && duplicateSplit !== episode.split)
            throw new Error(`Exact task duplicate crosses splits: ${episode.id}`);
        contentSplit.set(normalized, episode.split);
        if (episode.split !== "reference" && referenceIds.has(episode.id))
            throw new Error(`Validation/test episode leaks into Area Card: ${episode.id}`);
    }
    const byRepository = new Map();
    for (const episode of episodes)
        byRepository.set(episode.repositoryId, [...(byRepository.get(episode.repositoryId) ?? []), episode]);
    for (const group of byRepository.values()) {
        const maxReference = Math.max(...group.filter((item) => item.split === "reference").map((item) => Date.parse(item.timestamp)), Number.NEGATIVE_INFINITY);
        const minValidation = Math.min(...group.filter((item) => item.split === "validation").map((item) => Date.parse(item.timestamp)), Number.POSITIVE_INFINITY);
        const maxValidation = Math.max(...group.filter((item) => item.split === "validation").map((item) => Date.parse(item.timestamp)), Number.NEGATIVE_INFINITY);
        const minTest = Math.min(...group.filter((item) => item.split === "test").map((item) => Date.parse(item.timestamp)), Number.POSITIVE_INFINITY);
        if (maxReference > minValidation || maxValidation > minTest)
            throw new Error("Splits are not strictly chronological");
    }
};
export const validateBenchmarkDataset = (profile, cards, episodes, labels, options = {}) => {
    validateRepositoryProfile(profile);
    validateAreaCards(cards, profile, options);
    validateEpisodes(episodes, cards);
    validateSilverLabels(labels, cards);
    const episodeIds = new Set();
    for (const episode of episodes) {
        if (episode.repositoryId !== profile.repositoryId) {
            throw new Error(`Episode repository mismatch: ${episode.id} belongs to ${episode.repositoryId}`);
        }
        episodeIds.add(episode.id);
    }
    const labelIds = new Set();
    for (const label of labels) {
        if (labelIds.has(label.taskEpisodeId)) {
            throw new Error(`Duplicate benchmark label: ${label.taskEpisodeId}`);
        }
        labelIds.add(label.taskEpisodeId);
        if (!episodeIds.has(label.taskEpisodeId)) {
            throw new Error(`Benchmark label has no episode: ${label.taskEpisodeId}`);
        }
    }
    for (const id of episodeIds) {
        if (!labelIds.has(id)) {
            throw new Error(`Benchmark episode has no label: ${id}`);
        }
    }
};
export const validateSilverLabels = (labels, cards) => {
    const known = new Set(cards.map((card) => card.areaId));
    for (const label of labels) {
        if (label.selectedAreaIds.length > 2)
            throw new Error(`${label.taskEpisodeId} selects more than two areas`);
        if (!unique(label.selectedAreaIds))
            throw new Error(`${label.taskEpisodeId} repeats an area`);
        for (const area of label.selectedAreaIds)
            if (!known.has(area))
                throw new Error(`${label.taskEpisodeId} selects unknown area ${area}`);
        if (label.known !== (label.selectedAreaIds.length > 0))
            throw new Error(`${label.taskEpisodeId} known flag conflicts with selected areas`);
        if (!label.known && !label.unknownType)
            throw new Error(`${label.taskEpisodeId} requires unknownType`);
        if (label.oracle.humanReviewed !== false)
            throw new Error("Silver labels must record humanReviewed=false");
    }
};
const pathExistsAtSnapshot = async (repository, snapshot, repositoryPath) => {
    try {
        await execFileAsync("git", ["-C", repository, "cat-file", "-e", `${snapshot}:${repositoryPath}`], { maxBuffer: 1024 * 1024 });
        return true;
    }
    catch {
        return false;
    }
};
export const auditSilverLabelRepositoryEvidence = async (labels, episodes, repository) => {
    const episodesById = new Map(episodes.map((episode) => [episode.id, episode]));
    const missingPaths = [];
    const missingEpisodes = [];
    const insufficientInspection = [];
    let labelsRequiringInspection = 0;
    let labelsWithInspection = 0;
    let pathsChecked = 0;
    for (const label of labels) {
        const episode = episodesById.get(label.taskEpisodeId);
        if (!episode) {
            missingEpisodes.push(label.taskEpisodeId);
            continue;
        }
        const requiresInspection = label.known || label.unknownType === "new_repository_area";
        if (requiresInspection) {
            labelsRequiringInspection += 1;
            if (label.oracle.repositoryInspected === true &&
                (label.oracle.toolCalls ?? 0) > 0 &&
                label.relevantPaths.length > 0) {
                labelsWithInspection += 1;
            }
            else {
                insufficientInspection.push(label.taskEpisodeId);
            }
        }
        for (const repositoryPath of label.relevantPaths) {
            pathsChecked += 1;
            if (!(await pathExistsAtSnapshot(repository, episode.repositorySnapshot, repositoryPath))) {
                missingPaths.push({
                    taskEpisodeId: label.taskEpisodeId,
                    repositorySnapshot: episode.repositorySnapshot,
                    path: repositoryPath,
                });
            }
        }
    }
    return {
        schemaVersion: 1,
        repository,
        labels: labels.length,
        labelsRequiringInspection,
        labelsWithInspection,
        pathsChecked,
        missingPaths,
        missingEpisodes,
        insufficientInspection,
        ready: missingPaths.length === 0 &&
            missingEpisodes.length === 0 &&
            insufficientInspection.length === 0,
    };
};
export const redactText = (input) => {
    let redactions = 0;
    let text = input
        .replace(/<system_instruction>[\s\S]*?<\/system_instruction>/giu, () => { redactions += 1; return "[REDACTED MANAGED CONTEXT]"; })
        .replace(/<in-app-browser-context>[\s\S]*?<\/in-app-browser-context>/giu, () => { redactions += 1; return "[REDACTED MANAGED CONTEXT]"; })
        .replace(/<developer>[\s\S]*?<\/developer>/giu, () => { redactions += 1; return "[REDACTED MANAGED CONTEXT]"; })
        .replace(/-----BEGIN (?:RSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |OPENSSH )?PRIVATE KEY-----/giu, () => { redactions += 1; return "[REDACTED PRIVATE KEY]"; })
        .replace(/sk-(?:or-)?[A-Za-z0-9_-]{12,}/gu, () => { redactions += 1; return "[REDACTED API KEY]"; })
        .replace(/(authorization\s*:\s*bearer\s+)[^\s"']+/giu, (_, prefix) => { redactions += 1; return `${prefix}[REDACTED]`; })
        .replace(/((?:api[_-]?key|password|secret|token)\s*[=:]\s*["']?)[A-Za-z0-9_\-./+]{16,}/giu, (_, prefix) => { redactions += 1; return `${prefix}[REDACTED]`; });
    text = text.replace(/\/Users\/[^/\s]+/gu, "/Users/[USER]").replace(/\/home\/[^/\s]+/gu, "/home/[USER]");
    return { text, redactions };
};
