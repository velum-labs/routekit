import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { sha256 } from "./hash.js";
import { readJsonl, writeJsonlPrivate } from "./jsonl.js";
import { extractLunaRepositoryRetrievalTerms } from "./luna-accuracy-repository-retrieval.js";
import { redactText } from "./validation.js";
const execFileAsync = promisify(execFile);
const args = process.argv.slice(2);
const value = (flag) => {
    const index = args.indexOf(flag);
    return index < 0 ? undefined : args[index + 1];
};
const required = (flag) => {
    const found = value(flag);
    if (!found)
        throw new Error(`Missing ${flag}`);
    return found;
};
const maximumPaths = Number(value("--maximum-paths") ?? "4");
const maximumSnippetCharacters = Number(value("--maximum-snippet-characters") ?? "2200");
if (!Number.isSafeInteger(maximumPaths) ||
    maximumPaths < 1 ||
    maximumPaths > 8 ||
    !Number.isSafeInteger(maximumSnippetCharacters) ||
    maximumSnippetCharacters < 200 ||
    maximumSnippetCharacters > 8_000) {
    throw new Error("Invalid snippet limits");
}
const repository = path.resolve(required("--repository"));
const sourceEpisodes = await readJsonl(path.resolve(required("--episodes")));
const baseEpisodesFile = value("--base-episodes");
const baseEpisodes = baseEpisodesFile
    ? await readJsonl(path.resolve(baseEpisodesFile))
    : sourceEpisodes;
const labels = await readJsonl(path.resolve(required("--labels")));
const output = path.resolve(required("--output"));
const manifestOutput = path.resolve(required("--manifest-output"));
const labelById = new Map(labels.map((label) => [label.taskEpisodeId, label]));
const baseById = new Map(baseEpisodes.map((episode) => [episode.id, episode]));
if (labelById.size !== sourceEpisodes.length ||
    baseById.size !== sourceEpisodes.length) {
    throw new Error("Episodes, base episodes, and labels must have identical IDs");
}
const readSnapshotPath = async (snapshot, repositoryPath) => {
    if (!/^[0-9a-f]{40,64}$/u.test(snapshot) ||
        repositoryPath.startsWith("/") ||
        repositoryPath.includes("\0") ||
        repositoryPath.split("/").includes("..")) {
        throw new Error("Unsafe snapshot path");
    }
    const result = await execFileAsync("git", ["-C", repository, "show", `${snapshot}:${repositoryPath}`], { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
    return redactText(result.stdout.replaceAll("\r\n", "\n")).text;
};
const bestLine = (content, queryTerms) => {
    const lines = content.split("\n");
    let selected = 0;
    let selectedScore = -1;
    for (const [index, line] of lines.entries()) {
        const normalized = line.toLowerCase();
        const score = queryTerms.reduce((sum, term) => sum + (normalized.includes(term) ? 1 : 0), 0);
        if (score > selectedScore) {
            selected = index;
            selectedScore = score;
        }
    }
    return selected;
};
const excerpt = (content, center) => {
    const lines = content.split("\n");
    let start = center;
    let end = center;
    let text = lines[center] ?? "";
    while (true) {
        const before = start > 0 ? lines[start - 1] : undefined;
        const after = end + 1 < lines.length ? lines[end + 1] : undefined;
        if (before === undefined && after === undefined)
            break;
        const takeBefore = before !== undefined &&
            (after === undefined || center - start <= end - center);
        const candidate = takeBefore
            ? `${before}\n${text}`
            : `${text}\n${after ?? ""}`;
        if (candidate.length > maximumSnippetCharacters)
            break;
        if (takeBefore)
            start -= 1;
        else
            end += 1;
        text = candidate;
    }
    return { startLine: start + 1, endLine: end + 1, text };
};
const materialized = [];
const provenance = [];
for (const source of sourceEpisodes) {
    const label = labelById.get(source.id);
    const base = baseById.get(source.id);
    if (!label || !base)
        throw new Error(`Missing data for ${source.id}`);
    const queryTerms = extractLunaRepositoryRetrievalTerms([
        source.taskAnchor,
        ...(source.earlierUserContext ?? []),
        source.precedingAssistant,
        source.currentRequest,
    ]
        .filter((item) => Boolean(item))
        .join("\n"));
    const snippets = [];
    const paths = [];
    for (const repositoryPath of label.relevantPaths.slice(0, maximumPaths)) {
        const content = await readSnapshotPath(source.repositorySnapshot, repositoryPath);
        const selected = excerpt(content, bestLine(content, queryTerms));
        snippets.push([
            `- ${repositoryPath}:${selected.startLine}-${selected.endLine}`,
            "```text",
            selected.text,
            "```",
        ].join("\n"));
        paths.push({
            path: repositoryPath,
            startLine: selected.startLine,
            endLine: selected.endLine,
            textSha256: sha256(selected.text),
        });
    }
    const oracleEvidence = [
        "[SOL-CITED PRE-TASK REPOSITORY EVIDENCE]",
        "Excerpts from paths independently cited by the offline Sol judge at the exact pre-task snapshot. The excerpts are diagnostic ceiling evidence, not production retrieval and do not include area labels or changed-file metadata.",
        ...snippets,
    ].join("\n");
    const { actualChangedPaths: _removed, ...runtimeBase } = base;
    materialized.push({
        ...runtimeBase,
        relevantDiagnostic: [base.relevantDiagnostic, oracleEvidence]
            .filter((item) => Boolean(item?.trim()))
            .join("\n\n"),
    });
    provenance.push({
        taskEpisodeId: source.id,
        repositorySnapshot: source.repositorySnapshot,
        paths,
    });
}
await writeJsonlPrivate(output, materialized);
await writeFile(manifestOutput, `${JSON.stringify({
    schemaVersion: 1,
    specificationVersion: "sol-cited-pre-task-snippets-v1",
    repository,
    episodes: materialized.length,
    maximumPaths,
    maximumSnippetCharacters,
    combinedWithDeterministicEvidence: Boolean(baseEpisodesFile),
    safeguards: {
        exactPreTaskSnapshots: true,
        areaLabelsRendered: false,
        changedPathsRendered: false,
        postTaskDiffsRead: false,
    },
    hashes: {
        sourceEpisodes: sha256(await readFile(path.resolve(required("--episodes")))),
        labels: sha256(await readFile(path.resolve(required("--labels")))),
        runtimeEpisodes: sha256(await readFile(output)),
        provenance: sha256(JSON.stringify(provenance)),
    },
    provenance,
}, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({
    ok: true,
    episodes: materialized.length,
    output,
    manifestOutput,
    totalPaths: provenance.reduce((sum, item) => sum + item.paths.length, 0),
}, null, 2));
