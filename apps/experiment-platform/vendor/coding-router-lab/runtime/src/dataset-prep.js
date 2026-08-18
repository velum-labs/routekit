import { createReadStream } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
const taskIdentityText = (episode) => [
    episode.currentRequest,
    episode.taskAnchor,
    episode.precedingAssistant,
    ...(episode.earlierUserContext ?? []),
    episode.relevantDiagnostic,
]
    .filter(Boolean)
    .join("\n");
const likelyCodingPattern = /\b(?:implement|fix|refactor|test|build|lint|typecheck|bug|error|code|function|class|api|cli|daemon|gateway|router|provider|package|module|file|repo|commit|branch|typescript|javascript|python|rust|go|docker|ssh|deploy|config|docs?|readme|release|dependency|endpoint|database|schema|migration|stream|token|model)\b/iu;
export const selectEpisodeSplit = (episodes, split) => episodes.filter((episode) => episode.split === split);
const oracleDecisionStratum = (label) => label.known
    ? label.selectedAreaIds.length === 1
        ? "known_single"
        : "known_multi"
    : label.unknownType;
/**
 * Materializes a mechanically exact episode/label join for harness debugging
 * while preserving every unresolved source ID in an explicit report.
 *
 * This helper must not be used to relabel the source validation set or to
 * present the subset as a headline validation estimate.
 */
export const buildResolvedDevelopmentSubset = (episodes, adjudicatedLabels) => {
    const episodeIds = new Set();
    for (const episode of episodes) {
        if (episodeIds.has(episode.id)) {
            throw new Error(`Duplicate source episode: ${episode.id}`);
        }
        if (episode.split !== "validation") {
            throw new Error(`Resolved development source must be validation data: ${episode.id}`);
        }
        episodeIds.add(episode.id);
    }
    const labelById = new Map();
    for (const label of adjudicatedLabels) {
        if (labelById.has(label.taskEpisodeId)) {
            throw new Error(`Duplicate adjudicated development label: ${label.taskEpisodeId}`);
        }
        if (!episodeIds.has(label.taskEpisodeId)) {
            throw new Error(`Adjudicated label has no source episode: ${label.taskEpisodeId}`);
        }
        if (!label.oracle.adjudicated) {
            throw new Error(`Development label is not adjudicated: ${label.taskEpisodeId}`);
        }
        labelById.set(label.taskEpisodeId, label);
    }
    const resolvedEpisodes = episodes.filter((episode) => labelById.has(episode.id));
    const labels = resolvedEpisodes.map((episode) => labelById.get(episode.id));
    const unresolvedEpisodeIds = episodes
        .filter((episode) => !labelById.has(episode.id))
        .map((episode) => episode.id)
        .sort();
    const representedTaskStrata = {};
    for (const label of labels) {
        const stratum = oracleDecisionStratum(label);
        representedTaskStrata[stratum] =
            (representedTaskStrata[stratum] ?? 0) + 1;
    }
    return {
        episodes: resolvedEpisodes,
        labels,
        report: {
            schemaVersion: 1,
            role: "resolved_development_subset_not_headline_validation",
            sourceEpisodes: episodes.length,
            resolvedEpisodes: resolvedEpisodes.length,
            unresolvedEpisodes: unresolvedEpisodeIds.length,
            unresolvedEpisodeIds,
            representedTaskStrata,
            warning: "This exact resolved join is for canary and development runs only. It omits unresolved source cases and must not be reported as the complete validation estimate.",
        },
    };
};
const episodeHasTaskContext = (episode) => Boolean(episode.taskAnchor ||
    episode.precedingAssistant ||
    episode.earlierUserContext?.length ||
    episode.relevantDiagnostic);
/**
 * Selects a deterministic, coding-heavy ten-case harness canary from an exact
 * resolved development join. Labels influence coverage only; the canary is
 * explicitly forbidden from selecting the winning product configuration.
 */
export const selectLunaAccuracyDevelopmentCanary = (episodes, labels, codingDecisions, maximumCases = 10) => {
    if (!Number.isInteger(maximumCases) || maximumCases < 6) {
        throw new Error("Luna accuracy canary requires at least six cases");
    }
    const source = buildResolvedDevelopmentSubset(episodes, labels);
    if (source.report.unresolvedEpisodes > 0) {
        throw new Error("Luna accuracy canary requires an exact resolved episode/label join");
    }
    const episodeById = new Map(source.episodes.map((episode) => [episode.id, episode]));
    const missingCodingDecisions = source.episodes
        .map((episode) => episode.id)
        .filter((id) => !codingDecisions.has(id));
    const unknownCodingDecisions = [...codingDecisions.keys()].filter((id) => !episodeById.has(id));
    if (missingCodingDecisions.length || unknownCodingDecisions.length) {
        throw new Error(`Luna accuracy canary coding annotations do not exactly cover its source: missing=${missingCodingDecisions.join(",")}; unknown=${unknownCodingDecisions.join(",")}`);
    }
    const orderedLabels = [...source.labels].sort((left, right) => {
        const leftEpisode = episodeById.get(left.taskEpisodeId);
        const rightEpisode = episodeById.get(right.taskEpisodeId);
        return (leftEpisode.timestamp.localeCompare(rightEpisode.timestamp) ||
            left.taskEpisodeId.localeCompare(right.taskEpisodeId));
    });
    const known = orderedLabels.filter((label) => label.known);
    const knownCoding = known.filter((label) => codingDecisions.get(label.taskEpisodeId) === "coding");
    const unknown = orderedLabels.filter((label) => !label.known);
    const selected = new Map();
    const add = (label) => {
        if (label && selected.size < maximumCases) {
            selected.set(label.taskEpisodeId, label);
        }
    };
    // First cover every known area with a real coding case.
    const knownAreaIds = [
        ...new Set(knownCoding.flatMap((label) => label.selectedAreaIds)),
    ].sort();
    for (const areaId of knownAreaIds) {
        add(knownCoding.find((label) => label.selectedAreaIds.includes(areaId) &&
            !selected.has(label.taskEpisodeId)));
    }
    // Prefer boundary/multi-area and task-aware cases before chronological fill.
    for (const label of [...knownCoding].sort((left, right) => {
        const leftEpisode = episodeById.get(left.taskEpisodeId);
        const rightEpisode = episodeById.get(right.taskEpisodeId);
        return (right.selectedAreaIds.length - left.selectedAreaIds.length ||
            Number(episodeHasTaskContext(rightEpisode)) -
                Number(episodeHasTaskContext(leftEpisode)) ||
            leftEpisode.timestamp.localeCompare(rightEpisode.timestamp) ||
            left.taskEpisodeId.localeCompare(right.taskEpisodeId));
    })) {
        add(label);
        if (selected.size >=
            Math.min(maximumCases, Math.max(5, knownCoding.length))) {
            break;
        }
    }
    // Include each available unknown subtype once.
    for (const unknownType of [
        "new_repository_area",
        "insufficient_information",
        "outside_scope",
    ]) {
        add(unknown.find((label) => label.unknownType === unknownType &&
            !selected.has(label.taskEpisodeId)));
    }
    // Ensure the transport canary exercises both known and unknown parser paths
    // even when the real development set contains no coding-intent known case.
    const targetKnownDecisions = Math.min(known.length, Math.max(0, maximumCases - Math.min(3, unknown.length)), 5);
    const selectedKnownCount = () => [...selected.values()].filter((label) => label.known).length;
    for (const label of [...knownCoding, ...known]) {
        if (selectedKnownCount() >= targetKnownDecisions)
            break;
        add(label);
    }
    // Use known noncoding or ambiguous cases only after coding and unknown
    // coverage. They may help transport diversity but never masquerade as
    // coding cases in the report.
    for (const label of [...knownCoding, ...known, ...unknown])
        add(label);
    const selectedLabels = [...selected.values()];
    const selectedEpisodes = selectedLabels.map((label) => episodeById.get(label.taskEpisodeId));
    const taskStrata = {};
    const knownAreaCounts = {};
    for (const label of selectedLabels) {
        const stratum = oracleDecisionStratum(label);
        taskStrata[stratum] = (taskStrata[stratum] ?? 0) + 1;
        for (const areaId of label.selectedAreaIds) {
            knownAreaCounts[areaId] = (knownAreaCounts[areaId] ?? 0) + 1;
        }
    }
    const decisionFor = (label) => codingDecisions.get(label.taskEpisodeId);
    const codingCases = selectedLabels.filter((label) => decisionFor(label) === "coding").length;
    const knownCodingCases = selectedLabels.filter((label) => label.known && decisionFor(label) === "coding").length;
    const noncodingCases = selectedLabels.filter((label) => decisionFor(label) === "noncoding").length;
    const excludedAmbiguousCases = selectedLabels.filter((label) => decisionFor(label) === "excluded_ambiguous").length;
    return {
        episodes: selectedEpisodes,
        labels: selectedLabels,
        report: {
            schemaVersion: 1,
            role: "non_selective_harness_canary",
            requestedCases: maximumCases,
            selectedCases: selectedEpisodes.length,
            codingCases,
            knownCodingCases,
            noncodingCases,
            excludedAmbiguousCases,
            unknownCases: selectedLabels.filter((label) => !label.known).length,
            taskStrata,
            knownAreaCounts,
            contextualCases: selectedEpisodes.filter(episodeHasTaskContext).length,
            warning: "Use this non-selective subset only to validate prompts, parsing, persistence, and cost. Coding intent is reported from explicit annotations. Never rank product configurations from the canary.",
        },
    };
};
export const readUnlockedEpisodeSplits = async (file) => {
    const reference = [];
    const validation = [];
    let lockedTestCount = 0;
    const lines = createInterface({
        input: createReadStream(file, { encoding: "utf8" }),
        crlfDelay: Number.POSITIVE_INFINITY,
    });
    let lineNumber = 0;
    for await (const line of lines) {
        lineNumber += 1;
        if (!line.trim())
            continue;
        const match = /"split"\s*:\s*"(reference|validation|test)"/u.exec(line);
        if (!match) {
            throw new Error(`Episode line ${lineNumber} has no recognized split`);
        }
        const split = match[1];
        if (split === "test") {
            lockedTestCount += 1;
            continue;
        }
        const episode = JSON.parse(line);
        if (episode.split !== split) {
            throw new Error(`Episode line ${lineNumber} has an inconsistent split`);
        }
        (split === "reference" ? reference : validation).push(episode);
    }
    return { reference, validation, lockedTestCount };
};
/**
 * Builds a pre-call labeling plan without using task text as a label. Every
 * validation episode gets one Sol pass. Structurally difficult cases get a
 * second pass regardless of first-pass confidence; the remaining escalation
 * rules can be applied after the first pass.
 */
export const buildValidationEscalationPlan = (episodes) => {
    const validation = selectEpisodeSplit(episodes, "validation");
    const contextual = (episode) => Boolean(episode.taskAnchor ||
        episode.precedingAssistant ||
        (episode.earlierUserContext?.length ?? 0) > 0);
    const likelyMultiArea = (episode) => /\b(?:and|both|across|end-to-end|integrat|migration|release|deploy)\b/iu.test(episode.currentRequest);
    const mandatorySecondPassEpisodeIds = validation
        .filter((episode) => contextual(episode) ||
        Boolean(episode.relevantDiagnostic) ||
        likelyMultiArea(episode))
        .map((episode) => episode.id);
    return {
        schemaVersion: 1,
        policy: "one-pass-then-targeted-review-v1",
        primaryPassEpisodeIds: validation.map((episode) => episode.id),
        mandatorySecondPassEpisodeIds,
        postPassEscalationRules: [
            "Run a second pass when first-pass confidence is low or medium.",
            "Run a second pass when the first-pass decision is unknown.",
            "Run a second pass when the first pass selects two areas.",
            "Run a second pass when repository inspection or path evidence is missing where required.",
            "Run a third independent pass only when two completed passes disagree; adjudicate by strict majority.",
        ],
        counts: {
            primaryPass: validation.length,
            mandatorySecondPass: mandatorySecondPassEpisodeIds.length,
            likelyCoding: validation.filter((episode) => likelyCodingPattern.test(taskIdentityText(episode))).length,
            contextual: validation.filter(contextual).length,
            diagnostic: validation.filter((episode) => episode.relevantDiagnostic)
                .length,
            likelyMultiArea: validation.filter(likelyMultiArea).length,
        },
    };
};
export const selectSecondPassEpisodes = (episodes, firstPassLabels, plan) => {
    const validation = selectEpisodeSplit(episodes, "validation");
    const labelById = new Map();
    for (const label of firstPassLabels) {
        if (labelById.has(label.taskEpisodeId)) {
            throw new Error(`Duplicate first-pass label: ${label.taskEpisodeId}`);
        }
        labelById.set(label.taskEpisodeId, label);
    }
    const validationIds = new Set(validation.map((episode) => episode.id));
    for (const id of plan.primaryPassEpisodeIds) {
        if (!validationIds.has(id)) {
            throw new Error(`Validation plan references missing episode ${id}`);
        }
        if (!labelById.has(id)) {
            throw new Error(`Missing first-pass label for ${id}`);
        }
    }
    for (const id of labelById.keys()) {
        if (!validationIds.has(id)) {
            throw new Error(`First-pass label is not a validation episode: ${id}`);
        }
    }
    const mandatory = new Set(plan.mandatorySecondPassEpisodeIds);
    return validation.filter((episode) => {
        const label = labelById.get(episode.id);
        if (!label)
            return false;
        const requiresRepositoryInspection = label.known || label.unknownType === "new_repository_area";
        const inspectionMissing = requiresRepositoryInspection &&
            (!label.oracle.repositoryInspected ||
                (label.oracle.toolCalls ?? 0) < 1 ||
                label.relevantPaths.length === 0);
        return (mandatory.has(episode.id) ||
            label.confidence !== "high" ||
            !label.known ||
            label.selectedAreaIds.length === 2 ||
            inspectionMissing);
    });
};
export const selectDisagreementEpisodes = (episodes, firstPassLabels, secondPassLabels) => {
    const signature = (label) => JSON.stringify({
        selectedAreaIds: [...label.selectedAreaIds].sort(),
        known: label.known,
        unknownType: label.unknownType ?? null,
    });
    const firstById = new Map(firstPassLabels.map((label) => [label.taskEpisodeId, label]));
    const disagreements = new Set();
    for (const second of secondPassLabels) {
        const first = firstById.get(second.taskEpisodeId);
        if (!first) {
            throw new Error(`Second-pass label has no first-pass label: ${second.taskEpisodeId}`);
        }
        if (signature(first) !== signature(second)) {
            disagreements.add(second.taskEpisodeId);
        }
    }
    const byId = new Map(episodes.map((episode) => [episode.id, episode]));
    return [...disagreements]
        .map((id) => {
        const episode = byId.get(id);
        if (!episode)
            throw new Error(`Disagreement has no episode: ${id}`);
        return episode;
    })
        .sort((left, right) => left.timestamp.localeCompare(right.timestamp) ||
        left.id.localeCompare(right.id));
};
/**
 * Prepares the repository-derived coding stress set. `actualChangedPaths` are
 * stripped from runtime inputs and retained only in a separate evidence-label
 * file. These heuristic labels are not Sol silver labels and must be reported
 * separately from real Codex results.
 */
export const buildCodingChallengeSuite = (episodes, assignments, cards, split = "test") => {
    const assignmentById = new Map(assignments.map((assignment) => [
        assignment.taskEpisodeId,
        assignment.selectedAreaIds,
    ]));
    const allowedAreaIds = new Set(cards.map((card) => card.areaId));
    const sourceEpisodes = selectEpisodeSplit(episodes, split);
    const runtimeEpisodes = [];
    const evidenceLabels = [];
    const areaCounts = {};
    const warnings = [];
    for (const episode of sourceEpisodes) {
        if (episode.source !== "github") {
            throw new Error(`Challenge episode ${episode.id} is not GitHub-derived`);
        }
        const selectedAreaIds = assignmentById.get(episode.id);
        if (!selectedAreaIds) {
            throw new Error(`Missing challenge assignment for ${episode.id}`);
        }
        if (new Set(selectedAreaIds).size !== selectedAreaIds.length) {
            throw new Error(`Repeated challenge area for ${episode.id}`);
        }
        if (selectedAreaIds.length > 2) {
            throw new Error(`Challenge episode ${episode.id} selects more than two areas`);
        }
        for (const areaId of selectedAreaIds) {
            if (!allowedAreaIds.has(areaId)) {
                throw new Error(`Challenge episode ${episode.id} selects unknown area ${areaId}`);
            }
            areaCounts[areaId] = (areaCounts[areaId] ?? 0) + 1;
        }
        const { actualChangedPaths = [], ...runtimeEpisode } = episode;
        runtimeEpisodes.push(runtimeEpisode);
        evidenceLabels.push({
            schemaVersion: 1,
            taskEpisodeId: episode.id,
            selectedAreaIds,
            known: selectedAreaIds.length > 0,
            evidenceSource: "post-task-changed-path-heuristic",
            actualChangedPaths,
            note: "Post-task changed paths are label evidence only and were removed from the runtime episode.",
        });
    }
    if (sourceEpisodes.some((episode) => !(episode.actualChangedPaths?.length))) {
        warnings.push("At least one challenge case has no changed-path evidence.");
    }
    if (evidenceLabels.some((label) => !label.known)) {
        warnings.push("Unassigned cases are retained but require Sol or human adjudication before accuracy scoring.");
    }
    warnings.push("PR titles are coding-heavy stress prompts, not production-like Codex conversations; report this suite separately.");
    warnings.push("Changed-path assignments are heuristic evidence, not independent Sol silver labels.");
    return {
        episodes: runtimeEpisodes,
        evidenceLabels,
        report: {
            schemaVersion: 1,
            source: "github-pr-changed-paths",
            split,
            episodes: runtimeEpisodes.length,
            labeled: evidenceLabels.filter((label) => label.known).length,
            unlabeled: evidenceLabels.filter((label) => !label.known).length,
            singleArea: evidenceLabels.filter((label) => label.selectedAreaIds.length === 1).length,
            multiArea: evidenceLabels.filter((label) => label.selectedAreaIds.length === 2).length,
            areaCounts,
            warnings,
        },
    };
};
export const selectLabelsByEpisodeIds = (labels, episodeIds) => {
    const wanted = new Set(episodeIds);
    const selected = labels.filter((label) => wanted.has(label.taskEpisodeId));
    if (new Set(selected.map((label) => label.taskEpisodeId)).size !== selected.length) {
        throw new Error("Duplicate label in escalation selection");
    }
    return selected;
};
const assertRecord = (value, label) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
};
const parseRecoveredOracleDecision = (trace, taskEpisodeId, allowedAreaIds, model) => {
    let value;
    try {
        value = JSON.parse(trace.finalMessage);
    }
    catch {
        throw new Error(`Oracle trace has invalid final JSON: ${taskEpisodeId}`);
    }
    assertRecord(value, `Oracle decision for ${taskEpisodeId}`);
    const selectedAreaIds = value.selectedAreaIds;
    if (!Array.isArray(selectedAreaIds) ||
        selectedAreaIds.length > 2 ||
        !selectedAreaIds.every((entry) => typeof entry === "string") ||
        new Set(selectedAreaIds).size !== selectedAreaIds.length) {
        throw new Error(`Oracle trace has invalid selected areas: ${taskEpisodeId}`);
    }
    for (const areaId of selectedAreaIds) {
        if (!allowedAreaIds.has(areaId)) {
            throw new Error(`Oracle trace invented area ${areaId}: ${taskEpisodeId}`);
        }
    }
    const known = value.known;
    if (typeof known !== "boolean" ||
        known !== (selectedAreaIds.length > 0)) {
        throw new Error(`Oracle trace has inconsistent known flag: ${taskEpisodeId}`);
    }
    const unknownTypes = [
        "new_repository_area",
        "outside_scope",
        "insufficient_information",
    ];
    const unknownType = value.unknownType;
    if (known
        ? unknownType !== null
        : !unknownTypes.includes(unknownType)) {
        throw new Error(`Oracle trace has invalid unknown type: ${taskEpisodeId}`);
    }
    const difficulties = [
        "clear",
        "contextual",
        "boundary_multi_area",
        "unknown",
        "insufficient_information",
    ];
    if (typeof value.difficulty !== "string" ||
        !difficulties.includes(value.difficulty)) {
        throw new Error(`Oracle trace has invalid difficulty: ${taskEpisodeId}`);
    }
    const confidences = ["low", "medium", "high"];
    if (typeof value.confidence !== "string" ||
        !confidences.includes(value.confidence)) {
        throw new Error(`Oracle trace has invalid confidence: ${taskEpisodeId}`);
    }
    if (typeof value.reason !== "string" || !value.reason.trim()) {
        throw new Error(`Oracle trace has invalid reason: ${taskEpisodeId}`);
    }
    if (!Array.isArray(value.relevantPaths) ||
        !value.relevantPaths.every((entry) => typeof entry === "string" && entry.trim())) {
        throw new Error(`Oracle trace has invalid relevant paths: ${taskEpisodeId}`);
    }
    if (!Number.isInteger(trace.toolCalls) ||
        trace.toolCalls < 0 ||
        !Number.isInteger(trace.pass) ||
        trace.pass < 1) {
        throw new Error(`Oracle trace has invalid metadata: ${taskEpisodeId}`);
    }
    return {
        schemaVersion: 1,
        taskEpisodeId,
        selectedAreaIds,
        known,
        ...(!known
            ? {
                unknownType: unknownType,
            }
            : {}),
        difficulty: value.difficulty,
        confidence: value.confidence,
        reason: value.reason,
        relevantPaths: value.relevantPaths,
        oracle: {
            model,
            reasoningEffort: "high",
            passCount: 1,
            adjudicated: false,
            humanReviewed: false,
            toolCalls: trace.toolCalls,
            repositoryInspected: trace.toolCalls > 0,
        },
    };
};
/**
 * Recovers successful per-call oracle results after an interrupted
 * all-or-nothing `run-oracle` invocation.
 *
 * Only explicitly supplied episode IDs are accepted. This makes the helper
 * safe for validation recovery without reading or enumerating a locked test
 * split. It never edits or deletes the source traces.
 */
export const recoverOraclePassesFromTraces = async (input) => {
    if (!input.episodes.length) {
        throw new Error("Oracle recovery requires at least one expected episode");
    }
    if (!input.cards.length) {
        throw new Error("Oracle recovery requires Area Cards");
    }
    if (!input.model.trim()) {
        throw new Error("Oracle recovery requires a model");
    }
    const episodeIds = new Set();
    for (const episode of input.episodes) {
        if (episodeIds.has(episode.id)) {
            throw new Error(`Duplicate recovery episode: ${episode.id}`);
        }
        episodeIds.add(episode.id);
    }
    const allowedAreaIds = new Set(input.cards.map((card) => card.areaId));
    const traceEntries = (await readdir(input.traceDirectory))
        .filter((entry) => entry.endsWith(".json"))
        .sort();
    const filenamePattern = /^(.*)-pass-([1-9][0-9]*)\.json$/u;
    const recovered = [];
    const unexpectedEpisodeIds = new Set();
    const seenKeys = new Set();
    for (const entry of traceEntries) {
        const match = filenamePattern.exec(entry);
        if (!match?.[1] || !match[2]) {
            throw new Error(`Invalid oracle trace filename: ${entry}`);
        }
        const taskEpisodeId = match[1];
        const sourcePass = Number(match[2]);
        if (!episodeIds.has(taskEpisodeId)) {
            unexpectedEpisodeIds.add(taskEpisodeId);
            continue;
        }
        const key = `${taskEpisodeId}:${sourcePass}`;
        if (seenKeys.has(key)) {
            throw new Error(`Duplicate oracle trace pass: ${key}`);
        }
        seenKeys.add(key);
        const sourceTrace = path.resolve(input.traceDirectory, entry);
        const raw = JSON.parse(await readFile(sourceTrace, "utf8"));
        assertRecord(raw, `Oracle trace ${entry}`);
        if (raw.pass !== sourcePass ||
            typeof raw.finalMessage !== "string" ||
            typeof raw.toolCalls !== "number") {
            throw new Error(`Oracle trace metadata mismatch: ${entry}`);
        }
        const trace = {
            pass: sourcePass,
            finalMessage: raw.finalMessage,
            toolCalls: raw.toolCalls,
        };
        recovered.push({
            label: parseRecoveredOracleDecision(trace, taskEpisodeId, allowedAreaIds, input.model),
            trace: {
                taskEpisodeId,
                sourceTrace,
                sourcePass,
                isolationMode: input.isolationMode ?? "snapshot-only-clone",
            },
        });
    }
    recovered.sort((left, right) => left.label.taskEpisodeId.localeCompare(right.label.taskEpisodeId) ||
        left.trace.sourcePass - right.trace.sourcePass);
    const recoveredEpisodeIds = new Set(recovered.map((entry) => entry.label.taskEpisodeId));
    return {
        labels: recovered.map((entry) => entry.label),
        traceSources: recovered.map((entry) => entry.trace),
        summary: {
            schemaVersion: 1,
            expectedEpisodes: input.episodes.length,
            traceFiles: traceEntries.length,
            recoveredPasses: recovered.length,
            missingEpisodeIds: [...episodeIds]
                .filter((id) => !recoveredEpisodeIds.has(id))
                .sort(),
            unexpectedEpisodeIds: [...unexpectedEpisodeIds].sort(),
        },
    };
};
export const auditOraclePassCoverage = (episodes, passes) => {
    const expectedEpisodeIds = episodes.map((episode) => episode.id);
    if (expectedEpisodeIds.some((id) => !id.trim()) ||
        new Set(expectedEpisodeIds).size !== expectedEpisodeIds.length) {
        throw new Error("Oracle pass audit requires unique expected episodes");
    }
    const expected = new Set(expectedEpisodeIds);
    const grouped = new Map();
    for (const pass of passes) {
        grouped.set(pass.taskEpisodeId, [
            ...(grouped.get(pass.taskEpisodeId) ?? []),
            pass,
        ]);
    }
    const signature = (label) => JSON.stringify({
        known: label.known,
        selectedAreaIds: [...label.selectedAreaIds].sort(),
        unknownType: label.unknownType ?? null,
    });
    const passCounts = Object.fromEntries([...expected].sort().map((id) => [id, grouped.get(id)?.length ?? 0]));
    const duplicatePasses = [...grouped.entries()]
        .filter(([, values]) => values.length > 1)
        .map(([taskEpisodeId, values]) => ({
        taskEpisodeId,
        count: values.length,
    }))
        .sort((left, right) => left.taskEpisodeId.localeCompare(right.taskEpisodeId));
    const decisionDisagreementEpisodeIds = duplicatePasses
        .filter(({ taskEpisodeId }) => new Set((grouped.get(taskEpisodeId) ?? []).map(signature)).size > 1)
        .map(({ taskEpisodeId }) => taskEpisodeId);
    const missingEpisodeIds = [...expected]
        .filter((id) => !grouped.has(id))
        .sort();
    const unexpectedEpisodeIds = [...grouped.keys()]
        .filter((id) => !expected.has(id))
        .sort();
    return {
        schemaVersion: 1,
        expectedEpisodeIds: [...expected].sort(),
        passCounts,
        missingEpisodeIds,
        unexpectedEpisodeIds,
        duplicatePasses,
        decisionDisagreementEpisodeIds,
        readyForAdjudication: missingEpisodeIds.length === 0 &&
            unexpectedEpisodeIds.length === 0,
    };
};
export const mergeOraclePassArtifacts = (artifacts) => {
    if (!artifacts.length) {
        throw new Error("Oracle pass merge requires at least one artifact");
    }
    const merged = [];
    const keys = new Set();
    for (const [artifactIndex, artifact] of artifacts.entries()) {
        if (artifact.labels.length !== artifact.traceSources.length) {
            throw new Error(`Oracle artifact ${artifactIndex + 1} has mismatched labels and trace sources`);
        }
        const taskCounts = new Map();
        for (const label of artifact.labels) {
            taskCounts.set(label.taskEpisodeId, (taskCounts.get(label.taskEpisodeId) ?? 0) + 1);
        }
        const containsRepeatedTask = [...taskCounts.values()].some((count) => count > 1);
        const paired = [];
        if (containsRepeatedTask) {
            /*
             * Recovery emits labels and trace-source records in the same trace-file
             * order. When one artifact contains multiple votes for the same task,
             * task ID alone cannot disambiguate them, so require and preserve that
             * explicit positional pairing.
             */
            for (const [index, label] of artifact.labels.entries()) {
                const traceSource = artifact.traceSources[index];
                if (traceSource.taskEpisodeId !== label.taskEpisodeId) {
                    throw new Error(`Oracle artifact ${artifactIndex + 1} has ambiguous repeated-task pairing at record ${index + 1}`);
                }
                paired.push({ label, traceSource });
            }
        }
        else {
            const tracesByTask = new Map();
            for (const traceSource of artifact.traceSources) {
                tracesByTask.set(traceSource.taskEpisodeId, [
                    ...(tracesByTask.get(traceSource.taskEpisodeId) ?? []),
                    traceSource,
                ]);
            }
            for (const label of artifact.labels) {
                const matches = tracesByTask.get(label.taskEpisodeId) ?? [];
                if (matches.length !== 1) {
                    throw new Error(`Oracle artifact ${artifactIndex + 1} has ${matches.length} trace sources for label ${label.taskEpisodeId}`);
                }
                paired.push({ label, traceSource: matches[0] });
                tracesByTask.delete(label.taskEpisodeId);
            }
            if (tracesByTask.size > 0) {
                throw new Error(`Oracle artifact ${artifactIndex + 1} has trace sources without labels`);
            }
        }
        for (const { label, traceSource } of paired) {
            /*
             * `sourcePass` is local to one oracle invocation. Independent pass-one
             * runs therefore legitimately have the same task ID and sourcePass.
             * The preserved trace path is the stable invocation identity.
             */
            const key = [
                label.taskEpisodeId,
                traceSource.sourcePass,
                path.resolve(traceSource.sourceTrace),
            ].join(":");
            if (keys.has(key)) {
                throw new Error(`Duplicate oracle artifact pass: ${key}`);
            }
            keys.add(key);
            merged.push({ label, traceSource });
        }
    }
    merged.sort((left, right) => left.label.taskEpisodeId.localeCompare(right.label.taskEpisodeId) ||
        left.traceSource.sourcePass - right.traceSource.sourcePass ||
        path
            .resolve(left.traceSource.sourceTrace)
            .localeCompare(path.resolve(right.traceSource.sourceTrace)));
    return {
        labels: merged.map((entry) => entry.label),
        traceSources: merged.map((entry) => entry.traceSource),
    };
};
const oracleDecisionSignature = (label) => JSON.stringify({
    known: label.known,
    selectedAreaIds: [...label.selectedAreaIds].sort(),
    unknownType: label.unknownType ?? null,
});
/**
 * Selects one deterministic source pass and its paired trace for each final
 * adjudicated label.
 *
 * The final semantic decision must have a strict majority in the supplied
 * source passes. Among winning passes, selection is deterministic and favors
 * stronger auditable evidence: inspected repository evidence, more verified
 * paths, more tool calls, higher confidence, then earlier source pass/path.
 * The chosen pass itself remains unmodified so trace auditing can compare it
 * directly with the preserved source artifact.
 */
export const selectCanonicalOraclePasses = (input) => {
    if (input.passes.length !== input.traceSources.length) {
        throw new Error("Canonical oracle selection requires paired pass and trace-source records");
    }
    const finalById = new Map();
    for (const label of input.adjudicatedLabels) {
        if (finalById.has(label.taskEpisodeId)) {
            throw new Error(`Duplicate adjudicated oracle label: ${label.taskEpisodeId}`);
        }
        if (!label.oracle.adjudicated) {
            throw new Error(`Final oracle label is not adjudicated: ${label.taskEpisodeId}`);
        }
        finalById.set(label.taskEpisodeId, label);
    }
    const candidatesById = new Map();
    const sourceKeys = new Set();
    let ignoredUnadjudicatedPasses = 0;
    for (const [index, pass] of input.passes.entries()) {
        const traceSource = input.traceSources[index];
        if (traceSource.taskEpisodeId !== pass.taskEpisodeId) {
            throw new Error(`Oracle trace source does not match pass ${pass.taskEpisodeId}`);
        }
        const key = [
            traceSource.taskEpisodeId,
            traceSource.sourcePass,
            path.resolve(traceSource.sourceTrace),
        ].join(":");
        if (sourceKeys.has(key)) {
            throw new Error(`Duplicate oracle trace source: ${key}`);
        }
        sourceKeys.add(key);
        /*
         * A strict-majority adjudication intentionally omits unresolved tasks.
         * Their preserved votes are useful audit evidence, but no canonical
         * winning trace exists for them. Ignore those paired records explicitly
         * rather than forcing callers to create an error-prone filtered copy.
         */
        if (!finalById.has(pass.taskEpisodeId)) {
            ignoredUnadjudicatedPasses += 1;
            continue;
        }
        candidatesById.set(pass.taskEpisodeId, [
            ...(candidatesById.get(pass.taskEpisodeId) ?? []),
            { pass, traceSource },
        ]);
    }
    const confidenceRank = {
        low: 0,
        medium: 1,
        high: 2,
    };
    const selected = [];
    let rejectedMinorityPasses = 0;
    let unanimousSelections = 0;
    let majoritySelections = 0;
    for (const [taskEpisodeId, finalLabel] of [...finalById.entries()].sort(([left], [right]) => left.localeCompare(right))) {
        const candidates = candidatesById.get(taskEpisodeId) ?? [];
        if (!candidates.length) {
            throw new Error(`Adjudicated oracle label has no source passes: ${taskEpisodeId}`);
        }
        const finalSignature = oracleDecisionSignature(finalLabel);
        const winners = candidates.filter(({ pass }) => oracleDecisionSignature(pass) === finalSignature);
        if (winners.length <= candidates.length / 2) {
            throw new Error(`Adjudicated oracle label lacks a strict-majority source decision: ${taskEpisodeId}`);
        }
        if (finalLabel.oracle.passCount !== candidates.length) {
            throw new Error(`Adjudicated oracle pass count mismatch for ${taskEpisodeId}: expected ${finalLabel.oracle.passCount}, found ${candidates.length}`);
        }
        rejectedMinorityPasses += candidates.length - winners.length;
        if (winners.length === candidates.length) {
            unanimousSelections += 1;
        }
        else {
            majoritySelections += 1;
        }
        winners.sort((left, right) => {
            const leftInspected = left.pass.oracle.repositoryInspected === true ? 1 : 0;
            const rightInspected = right.pass.oracle.repositoryInspected === true ? 1 : 0;
            return (rightInspected - leftInspected ||
                right.pass.relevantPaths.length - left.pass.relevantPaths.length ||
                (right.pass.oracle.toolCalls ?? 0) -
                    (left.pass.oracle.toolCalls ?? 0) ||
                confidenceRank[right.pass.confidence] -
                    confidenceRank[left.pass.confidence] ||
                left.traceSource.sourcePass - right.traceSource.sourcePass ||
                left.traceSource.sourceTrace.localeCompare(right.traceSource.sourceTrace));
        });
        selected.push(winners[0]);
    }
    return {
        canonicalPasses: selected.map(({ pass }) => pass),
        canonicalTraceSources: selected.map(({ traceSource }) => traceSource),
        summary: {
            schemaVersion: 1,
            adjudicatedLabels: input.adjudicatedLabels.length,
            availablePasses: input.passes.length - ignoredUnadjudicatedPasses,
            ignoredUnadjudicatedPasses,
            selectedPasses: selected.length,
            rejectedMinorityPasses,
            unanimousSelections,
            majoritySelections,
        },
    };
};
