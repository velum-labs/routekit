export const TASK_SERIALIZATION_VERSION = "task-envelope-v1";
const MAX_REQUEST_CONTEXT_CHARS = 16_384;
const MAX_PROFILE_CHARS = 3_072;
const section = (name, value) => value?.trim() ? `[${name}]\n${value.trim()}` : "";
export const serializeRepositoryProfile = (profile) => [
    `Repository: ${profile.name}`,
    `Purpose: ${profile.purpose}`,
    `Languages: ${profile.languages.join(", ")}`,
    `Frameworks: ${profile.frameworks.join(", ")}`,
    "Components:",
    ...profile.components.map((item) => `- ${item.name}: ${item.purpose} (${item.paths.join(", ")})`),
].join("\n").slice(0, MAX_PROFILE_CHARS);
export const serializeTaskEnvelope = (episode, profile) => {
    const optional = [
        section("TASK ANCHOR", episode.taskAnchor),
        section("RECENT ASSISTANT CONTEXT", episode.precedingAssistant),
        section("EARLIER USER CONTEXT", episode.earlierUserContext?.join("\n\n")),
        section("RELEVANT DIAGNOSTIC", episode.relevantDiagnostic),
    ].filter(Boolean);
    const required = section("CURRENT REQUEST", episode.currentRequest);
    const truncatedSections = [];
    let body = [required, ...optional].join("\n\n");
    while (body.length > MAX_REQUEST_CONTEXT_CHARS && optional.length > 0) {
        const removed = optional.pop();
        if (removed)
            truncatedSections.push(removed.match(/^\[([^\]]+)/)?.[1] ?? "optional");
        body = [required, ...optional].join("\n\n");
    }
    if (body.length > MAX_REQUEST_CONTEXT_CHARS) {
        body = body.slice(0, MAX_REQUEST_CONTEXT_CHARS);
        truncatedSections.push("CURRENT REQUEST");
    }
    return {
        version: TASK_SERIALIZATION_VERSION,
        text: `${body}\n\n${section("REPOSITORY PROFILE", serializeRepositoryProfile(profile))}`,
        truncatedSections,
    };
};
