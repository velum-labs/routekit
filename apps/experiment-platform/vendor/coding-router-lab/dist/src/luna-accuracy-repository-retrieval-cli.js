import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { materializeLunaRepositoryRetrievalEpisodes, writeLunaRepositoryRetrievalMaterialization, } from "./luna-accuracy-repository-retrieval.js";
const usage = `Usage:
  node --experimental-strip-types src/luna-accuracy-repository-retrieval-cli.ts \\
    --repository PATH --episodes FILE --output-directory DIR \\
    --mode paths|paths_and_symbols|paths_and_snippets \\
    [--maximum-files N] [--maximum-characters N] \\
    [--maximum-snippet-characters N] [--generated-at ISO]

This command deliberately accepts no labels, predictions, changed paths, or
post-task diffs. It reads only task-aware episode fields and exact pre-task Git
snapshots.`;
const argumentsList = process.argv.slice(2);
const value = (flag) => {
    const index = argumentsList.indexOf(flag);
    return index < 0 ? undefined : argumentsList[index + 1];
};
const required = (flag) => {
    const result = value(flag);
    if (!result)
        throw new Error(`Missing ${flag}\n\n${usage}`);
    return result;
};
const optionalInteger = (flag) => {
    const raw = value(flag);
    if (raw === undefined)
        return undefined;
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed)) {
        throw new Error(`${flag} must be an integer`);
    }
    return parsed;
};
const readJsonl = async (file) => (await readFile(file, "utf8"))
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
const mode = required("--mode");
const maximumFiles = optionalInteger("--maximum-files");
const maximumCharacters = optionalInteger("--maximum-characters");
const maximumSnippetCharacters = optionalInteger("--maximum-snippet-characters");
const generatedAt = value("--generated-at");
const startedAt = performance.now();
const materialization = await materializeLunaRepositoryRetrievalEpisodes({
    repository: resolve(required("--repository")),
    episodes: await readJsonl(resolve(required("--episodes"))),
    options: {
        mode,
        ...(maximumFiles === undefined ? {} : { maximumFiles }),
        ...(maximumCharacters === undefined ? {} : { maximumCharacters }),
        ...(maximumSnippetCharacters === undefined
            ? {}
            : { maximumSnippetCharacters }),
    },
    ...(generatedAt === undefined ? {} : { generatedAt }),
});
const wallClockMilliseconds = performance.now() - startedAt;
const files = await writeLunaRepositoryRetrievalMaterialization({
    outputDirectory: resolve(required("--output-directory")),
    materialization,
});
console.log(JSON.stringify({
    ok: true,
    mode,
    files,
    manifest: materialization.manifest,
    operational: {
        wallClockMilliseconds,
        meanWallClockMillisecondsPerEpisode: wallClockMilliseconds / materialization.episodes.length,
    },
}, null, 2));
