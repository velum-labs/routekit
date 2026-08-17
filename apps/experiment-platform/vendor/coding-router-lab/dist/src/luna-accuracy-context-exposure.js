import { contentHash, sha256 } from "./hash.js";
import { LUNA_ACCURACY_TASK_BUDGET_CHARACTER_CAPS, serializeLunaAccuracyTaskContext, } from "./luna-accuracy-context.js";
import { LUNA_GROUNDED_CODING_VARIANT_KINDS, } from "./luna-accuracy-coding-development.js";
import { validateEpisodes, validateRepositoryProfile, } from "./validation.js";
export const LUNA_CONTEXT_BUDGET_EXPOSURE_AUDIT_VERSION = "luna-context-budget-exposure-v1";
const OMISSION_MARKER = "…[omitted]…";
const MINIMUM_EVIDENCE_CHARACTERS = 16;
const MAXIMUM_EVIDENCE_CHARACTERS = 2_048;
export const LUNA_NATURAL_CONTEXT_EVIDENCE_FIELDS = [
    "task_anchor",
    "earlier_user_context",
    "preceding_assistant",
    "relevant_diagnostic",
    "current_request",
];
const blankSourceCounts = () => ({
    codex: 0,
    github: 0,
    derived: 0,
});
const blankFieldCounts = () => ({
    task_anchor: 0,
    earlier_user_context: 0,
    preceding_assistant: 0,
    relevant_diagnostic: 0,
    current_request: 0,
});
const blankTransformationCounts = () => ({
    referential: 0,
    long_relevant_context: 0,
    irrelevant_distractor: 0,
    diagnostic_followup: 0,
    controlled_truncation: 0,
    unclassified: 0,
});
const range = (values) => {
    if (values.length === 0) {
        throw new Error("Cannot summarize an empty numeric collection");
    }
    const sorted = [...values].sort((left, right) => left - right);
    const midpoint = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 1
        ? sorted[midpoint]
        : (sorted[midpoint - 1] + sorted[midpoint]) / 2;
    return {
        minimum: sorted[0],
        median,
        maximum: sorted.at(-1),
    };
};
const rawTaskCharacters = (episode) => [
    episode.taskAnchor,
    ...(episode.earlierUserContext ?? []),
    episode.precedingAssistant,
    episode.relevantDiagnostic,
    episode.currentRequest,
]
    .filter((value) => typeof value === "string")
    .join("\n").length;
const taskTextFields = (episode) => [
    episode.taskAnchor ?? "",
    ...(episode.earlierUserContext ?? []),
    episode.precedingAssistant ?? "",
    episode.relevantDiagnostic ?? "",
    episode.currentRequest,
];
const countOccurrences = (haystack, needle) => {
    if (!needle)
        return 0;
    let count = 0;
    let offset = 0;
    while (offset <= haystack.length - needle.length) {
        const found = haystack.indexOf(needle, offset);
        if (found < 0)
            break;
        count += 1;
        offset = found + needle.length;
    }
    return count;
};
const serializedTaskContains = (serialized, format, evidence) => {
    if (format === "compact_json") {
        const parsed = JSON.parse(serialized);
        return Object.values(parsed.task_context ?? {}).some((value) => typeof value === "string" && value.includes(evidence));
    }
    const taskStartMarker = format === "labeled_sections"
        ? "[TASK ANCHOR]"
        : "[TASK ANCHOR — governing objective]";
    const taskStart = serialized.indexOf(taskStartMarker);
    if (taskStart < 0) {
        throw new Error(`Serialized ${format} context lacks its task marker`);
    }
    return serialized.slice(taskStart).includes(evidence);
};
const evidenceFieldValue = (episode, requirement) => {
    if (requirement.field === "task_anchor") {
        return episode.taskAnchor ?? null;
    }
    if (requirement.field === "preceding_assistant") {
        return episode.precedingAssistant ?? null;
    }
    if (requirement.field === "relevant_diagnostic") {
        return episode.relevantDiagnostic ?? null;
    }
    if (requirement.field === "current_request") {
        return episode.currentRequest;
    }
    const index = requirement.earlierUserContextIndex;
    if (!Number.isInteger(index) ||
        index === undefined ||
        index < 0) {
        return null;
    }
    return episode.earlierUserContext?.[index] ?? null;
};
const basicRequirementShapeIsValid = (requirement) => requirement.schemaVersion === 1 &&
    typeof requirement.requirementId === "string" &&
    requirement.requirementId.trim().length > 0 &&
    typeof requirement.taskEpisodeId === "string" &&
    requirement.taskEpisodeId.trim().length > 0 &&
    LUNA_NATURAL_CONTEXT_EVIDENCE_FIELDS.includes(requirement.field) &&
    requirement.provenance === "natural_user_session" &&
    requirement.routingRole === "decisive" &&
    typeof requirement.reviewer === "string" &&
    requirement.reviewer.trim().length > 0 &&
    requirement.selectedWithoutModelPredictions === true &&
    typeof requirement.evidenceSha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(requirement.evidenceSha256);
const issue = (issueCounts, code) => {
    issueCounts[code] = (issueCounts[code] ?? 0) + 1;
};
const validateEvidenceRequirements = (requirements, episodesById, serializationsById, taskFormat) => {
    const valid = [];
    const issueCounts = {};
    const requirementIds = new Set();
    for (const requirement of requirements) {
        if (!basicRequirementShapeIsValid(requirement)) {
            issue(issueCounts, "invalid_requirement_shape");
            continue;
        }
        if (requirementIds.has(requirement.requirementId)) {
            issue(issueCounts, "duplicate_requirement_id");
            continue;
        }
        requirementIds.add(requirement.requirementId);
        const episode = episodesById.get(requirement.taskEpisodeId);
        if (!episode) {
            issue(issueCounts, "missing_episode");
            continue;
        }
        if (episode.source !== "codex") {
            issue(issueCounts, "episode_is_not_natural_codex");
            continue;
        }
        const fieldValue = evidenceFieldValue(episode, requirement);
        if (fieldValue === null) {
            issue(issueCounts, "invalid_field_or_index");
            continue;
        }
        if (!Number.isInteger(requirement.startCharacter) ||
            !Number.isInteger(requirement.endCharacter) ||
            requirement.startCharacter < 0 ||
            requirement.endCharacter <= requirement.startCharacter ||
            requirement.endCharacter > fieldValue.length) {
            issue(issueCounts, "invalid_offsets");
            continue;
        }
        const evidence = fieldValue.slice(requirement.startCharacter, requirement.endCharacter);
        if (evidence.length < MINIMUM_EVIDENCE_CHARACTERS ||
            evidence.length > MAXIMUM_EVIDENCE_CHARACTERS) {
            issue(issueCounts, "evidence_length_out_of_range");
            continue;
        }
        if (evidence.trim() !== evidence) {
            issue(issueCounts, "evidence_has_boundary_whitespace");
            continue;
        }
        if (sha256(evidence) !== requirement.evidenceSha256) {
            issue(issueCounts, "evidence_hash_mismatch");
            continue;
        }
        const completeTaskText = taskTextFields(episode).join("\n");
        if (countOccurrences(completeTaskText, evidence) !== 1) {
            issue(issueCounts, "evidence_not_unique_in_task_context");
            continue;
        }
        const serialization = serializationsById.get(episode.id);
        if (!serialization) {
            throw new Error(`Missing serialization for ${episode.id}`);
        }
        valid.push({
            requirement,
            episode,
            evidence,
            retainedAtLower: serializedTaskContains(serialization.lower, taskFormat, evidence),
            retainedAtHigher: serializedTaskContains(serialization.higher, taskFormat, evidence),
        });
    }
    return { valid, issueCounts };
};
const budgetSummary = (serializations, budget, side) => {
    const characterCap = LUNA_ACCURACY_TASK_BUDGET_CHARACTER_CAPS[budget];
    return {
        budget,
        characterCap,
        casesWithRawTaskFieldCharactersAboveCap: serializations.filter((item) => item.rawTaskCharacters > characterCap).length,
        casesWithOmissionMarker: serializations.filter((item) => item[side].includes(OMISSION_MARKER)).length,
        serializedCharacters: range(serializations.map((item) => item[side].length)),
    };
};
/**
 * Audits whether a dataset actually presents different task information at
 * two context budgets. It performs no model inference and emits no task text
 * or raw per-case identifiers.
 *
 * A serialization difference is only a capacity/exposure diagnostic.
 * Natural-recall exposure additionally requires prediction-blind reviewed
 * decisive-evidence spans that are absent at the lower budget and retained at
 * the higher budget.
 */
export const auditLunaContextBudgetExposure = (input) => {
    if (input.episodes.length === 0) {
        throw new Error("Context-budget exposure audit requires episodes");
    }
    validateRepositoryProfile(input.profile);
    validateEpisodes([...input.episodes]);
    for (const episode of input.episodes) {
        if (episode.repositoryId !== input.profile.repositoryId) {
            throw new Error(`Context-budget episode repository mismatch: ${episode.id}`);
        }
    }
    const lowerCap = LUNA_ACCURACY_TASK_BUDGET_CHARACTER_CAPS[input.lowerBudget];
    const higherCap = LUNA_ACCURACY_TASK_BUDGET_CHARACTER_CAPS[input.higherBudget];
    if (lowerCap >= higherCap) {
        throw new Error("Higher context budget must exceed lower context budget");
    }
    const episodesById = new Map();
    for (const episode of input.episodes) {
        if (episodesById.has(episode.id)) {
            throw new Error(`Duplicate context-budget episode: ${episode.id}`);
        }
        episodesById.set(episode.id, episode);
    }
    const transformationByEpisodeId = new Map();
    let unmatchedProvenance = 0;
    for (const provenance of input.provenance ?? []) {
        if (!LUNA_GROUNDED_CODING_VARIANT_KINDS.includes(provenance.variantKind)) {
            throw new Error(`Unsupported context-exposure transformation: ${String(provenance.variantKind)}`);
        }
        if (!episodesById.has(provenance.derivativeEpisodeId)) {
            unmatchedProvenance += 1;
            continue;
        }
        if (transformationByEpisodeId.has(provenance.derivativeEpisodeId)) {
            throw new Error(`Duplicate context-exposure provenance: ${provenance.derivativeEpisodeId}`);
        }
        transformationByEpisodeId.set(provenance.derivativeEpisodeId, provenance.variantKind);
    }
    const serializations = input.episodes.map((episode) => ({
        episode,
        lower: serializeLunaAccuracyTaskContext(episode, input.profile, input.taskFormat, input.lowerBudget, input.profileDetail),
        higher: serializeLunaAccuracyTaskContext(episode, input.profile, input.taskFormat, input.higherBudget, input.profileDetail),
        rawTaskCharacters: rawTaskCharacters(episode),
        transformationKind: transformationByEpisodeId.get(episode.id) ?? "unclassified",
    }));
    const serializationsById = new Map(serializations.map((item) => [item.episode.id, item]));
    const different = serializations.filter((item) => item.lower !== item.higher);
    const additionalCharacters = different.map((item) => item.higher.length - item.lower.length);
    const differencesByTransformationKind = blankTransformationCounts();
    for (const item of different) {
        differencesByTransformationKind[item.transformationKind] += 1;
    }
    const requirements = input.evidenceRequirements ?? [];
    const requirementValidation = validateEvidenceRequirements(requirements, episodesById, serializationsById, input.taskFormat);
    const validByField = blankFieldCounts();
    for (const item of requirementValidation.valid) {
        validByField[item.requirement.field] += 1;
    }
    const requirementsByEpisode = new Map();
    for (const item of requirementValidation.valid) {
        requirementsByEpisode.set(item.episode.id, [
            ...(requirementsByEpisode.get(item.episode.id) ?? []),
            item,
        ]);
    }
    const anyOnlyHigherEpisodeIds = new Set();
    const qualifiedEpisodeIds = new Set();
    const qualifiedLineages = new Set();
    for (const [episodeId, episodeRequirements] of requirementsByEpisode) {
        if (episodeRequirements.some((item) => !item.retainedAtLower && item.retainedAtHigher)) {
            anyOnlyHigherEpisodeIds.add(episodeId);
        }
        if (episodeRequirements.every((item) => item.retainedAtHigher) &&
            episodeRequirements.some((item) => !item.retainedAtLower)) {
            qualifiedEpisodeIds.add(episodeId);
            qualifiedLineages.add(episodesById.get(episodeId).lineageHash);
        }
    }
    const sourceCounts = blankSourceCounts();
    for (const episode of input.episodes)
        sourceCounts[episode.source] += 1;
    const lowerSummary = budgetSummary(serializations, input.lowerBudget, "lower");
    const higherSummary = budgetSummary(serializations, input.higherBudget, "higher");
    const issueTotal = Object.values(requirementValidation.issueCounts).reduce((sum, count) => sum + (count ?? 0), 0);
    let claimScope;
    if (different.length === 0) {
        claimScope = "no_budget_exposure";
    }
    else if (qualifiedEpisodeIds.size > 0) {
        claimScope = "natural_recall_exposure_available";
    }
    else if (differencesByTransformationKind.long_relevant_context ===
        different.length) {
        claimScope = "neutral_context_robustness_only";
    }
    else {
        claimScope = "capacity_exposure_only";
    }
    const warnings = [
        "Serialization differences measure context exposure, not classifier accuracy; this audit makes no inference calls.",
    ];
    if (different.length === 0) {
        warnings.push("The two budgets serialize every case identically, so this dataset cannot distinguish them.");
    }
    if (requirements.length === 0) {
        warnings.push("No prediction-blind reviewed decisive-evidence requirements were supplied, so the audit cannot support a natural long-context recall claim.");
    }
    if (issueTotal > 0) {
        warnings.push("One or more decisive-evidence requirements failed local validation and are excluded from recall-qualified counts.");
    }
    if (claimScope === "neutral_context_robustness_only") {
        warnings.push("All observed budget differences are generated long-relevant-context transformations. They test robustness to extra neutral context, not recovery of routing facts lost at the lower budget.");
    }
    if (higherSummary.casesWithOmissionMarker > 0) {
        warnings.push("The higher budget still clips at least one case; retained-evidence checks, not raw length alone, determine recall exposure.");
    }
    if (qualifiedEpisodeIds.size > 0) {
        warnings.push("Recall-qualified exposure does not establish statistical adequacy. Pre-register the required independent-lineage count and cluster all analysis by lineage before reading predictions.");
    }
    if (unmatchedProvenance > 0) {
        warnings.push(`${unmatchedProvenance} provenance record(s) did not join this episode set and were ignored.`);
    }
    return {
        schemaVersion: 1,
        specificationVersion: LUNA_CONTEXT_BUDGET_EXPOSURE_AUDIT_VERSION,
        role: "offline_context_capacity_diagnostic_not_accuracy_evidence",
        datasetBindingHash: contentHash({
            profile: input.profile,
            episodes: input.episodes,
            provenance: input.provenance ?? [],
            evidenceRequirements: requirements,
        }),
        configuration: {
            taskFormat: input.taskFormat,
            profileDetail: input.profileDetail,
            lowerBudget: input.lowerBudget,
            higherBudget: input.higherBudget,
        },
        dataset: {
            episodes: input.episodes.length,
            independentLineages: new Set(input.episodes.map((episode) => episode.lineageHash)).size,
            sourceCounts,
        },
        budgets: {
            lower: lowerSummary,
            higher: higherSummary,
        },
        comparison: {
            identicalSerializedContexts: input.episodes.length - different.length,
            differentSerializedContexts: different.length,
            independentLineagesWithDifferentSerializedContexts: new Set(different.map((item) => item.episode.lineageHash)).size,
            casesWhereHigherBudgetIsLonger: different.filter((item) => item.higher.length > item.lower.length).length,
            casesWhereHigherBudgetIsShorter: different.filter((item) => item.higher.length < item.lower.length).length,
            sameLengthButDifferentContexts: different.filter((item) => item.higher.length === item.lower.length).length,
            lowerBudgetOmittedHigherBudgetDidNot: serializations.filter((item) => item.lower.includes(OMISSION_MARKER) &&
                !item.higher.includes(OMISSION_MARKER)).length,
            additionalSerializedCharactersWhenDifferent: additionalCharacters.length > 0
                ? range(additionalCharacters)
                : null,
            differencesByTransformationKind,
        },
        evidenceRequirements: {
            provided: requirements.length,
            valid: requirementValidation.valid.length,
            invalid: issueTotal,
            issueCounts: requirementValidation.issueCounts,
            validByField,
            retainedAtLowerBudget: requirementValidation.valid.filter((item) => item.retainedAtLower).length,
            retainedAtHigherBudget: requirementValidation.valid.filter((item) => item.retainedAtHigher).length,
            retainedOnlyAtHigherBudget: requirementValidation.valid.filter((item) => !item.retainedAtLower && item.retainedAtHigher).length,
            absentAtBothBudgets: requirementValidation.valid.filter((item) => !item.retainedAtLower && !item.retainedAtHigher).length,
            episodesWithAnyDecisiveEvidenceOnlyAtHigherBudget: anyOnlyHigherEpisodeIds.size,
            episodesWithAllDecisiveEvidenceAtHigherAndAtLeastOneMissingAtLower: qualifiedEpisodeIds.size,
            independentLineagesWithAllDecisiveEvidenceAtHigherAndAtLeastOneMissingAtLower: qualifiedLineages.size,
        },
        claimScope,
        privacy: {
            externalCallsMade: 0,
            rawTaskTextIncluded: false,
            rawEvidenceTextIncluded: false,
            rawEpisodeIdentifiersIncluded: false,
            rawLineageIdentifiersIncluded: false,
            reviewerIdentifiersIncluded: false,
        },
        warnings,
    };
};
