export const areaOverviewText = (card) => [
    `Area: ${card.name}`,
    `Description: ${card.description}`,
    `Includes: ${card.inclusions.join("; ")}`,
    `Excludes: ${card.exclusions.join("; ")}`,
    `Paths: ${card.pathAnchors.join(", ")}`,
    `Components: ${card.componentAnchors.join(", ")}`,
    `Symbols: ${card.symbolAnchors.join(", ")}`,
    `Code summaries: ${card.codeSummaries.join("; ")}`,
    `Boundary examples: ${card.boundaryExamples.join("; ")}`,
    card.codeSnippets.length ? `Code:\n${card.codeSnippets.join("\n---\n")}` : "",
].filter(Boolean).join("\n");
export const referenceTaskText = (episode) => [episode.taskAnchor, episode.currentRequest].filter(Boolean).join("\n");
