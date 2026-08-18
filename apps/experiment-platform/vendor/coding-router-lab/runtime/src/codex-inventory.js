import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import { normalizeRepositoryUrl } from "./codex-collector.js";
const walk = async (root) => {
    const output = [];
    for (const entry of await readdir(root, { withFileTypes: true })) {
        const full = path.join(root, entry.name);
        if (entry.isDirectory())
            output.push(...await walk(full));
        else if (entry.isFile() && entry.name.endsWith(".jsonl"))
            output.push(full);
    }
    return output;
};
const increment = (record, key) => { record[key] = (record[key] ?? 0) + 1; };
const text = (value) => typeof value === "string" && value.trim() ? value : undefined;
const readMetadata = async (file) => {
    const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Number.POSITIVE_INFINITY });
    let parseErrors = 0;
    try {
        for await (const line of lines) {
            if (!line.trim())
                continue;
            let record;
            try {
                record = JSON.parse(line);
            }
            catch {
                parseErrors += 1;
                continue;
            }
            if (record.type === "session_meta")
                return { payload: record.payload ?? {}, parseErrors };
        }
        return { parseErrors };
    }
    finally {
        lines.close();
    }
};
export const inventoryCodexRepositories = async (codexHome) => {
    const files = [];
    for (const root of [path.join(codexHome, "sessions"), path.join(codexHome, "archived_sessions")]) {
        try {
            files.push(...await walk(root));
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
    }
    const repositories = new Map();
    let sessionMetadataRecords = 0, sessionsWithoutRepositoryUrl = 0, parseErrors = 0;
    for (const file of files.sort()) {
        const metadata = await readMetadata(file);
        parseErrors += metadata.parseErrors;
        if (!metadata.payload) {
            sessionsWithoutRepositoryUrl += 1;
            continue;
        }
        sessionMetadataRecords += 1;
        const payload = metadata.payload;
        const git = payload.git && typeof payload.git === "object" ? payload.git : {};
        const repositoryUrl = text(git.repository_url);
        if (!repositoryUrl) {
            sessionsWithoutRepositoryUrl += 1;
            continue;
        }
        const normalizedRepositoryUrl = normalizeRepositoryUrl(repositoryUrl);
        const timestamp = text(payload.timestamp);
        const current = repositories.get(normalizedRepositoryUrl) ?? {
            normalizedRepositoryUrl, sessionFiles: 0, sessionsWithSnapshot: 0,
            earliestSessionTimestamp: null, latestSessionTimestamp: null, sources: {}, originators: {},
        };
        current.sessionFiles += 1;
        if (text(git.commit_hash))
            current.sessionsWithSnapshot += 1;
        if (timestamp && (!current.earliestSessionTimestamp || timestamp < current.earliestSessionTimestamp))
            current.earliestSessionTimestamp = timestamp;
        if (timestamp && (!current.latestSessionTimestamp || timestamp > current.latestSessionTimestamp))
            current.latestSessionTimestamp = timestamp;
        increment(current.sources, text(payload.source) ?? "unknown");
        increment(current.originators, text(payload.originator) ?? "unknown");
        repositories.set(normalizedRepositoryUrl, current);
    }
    return {
        schemaVersion: 1, generatedAt: new Date().toISOString(), filesScanned: files.length,
        sessionMetadataRecords, repositories: [...repositories.values()].sort((a, b) => b.sessionFiles - a.sessionFiles || a.normalizedRepositoryUrl.localeCompare(b.normalizedRepositoryUrl)),
        sessionsWithoutRepositoryUrl, parseErrors,
        privacy: { onlySessionMetadataExtracted: true, promptTextEmitted: false, assistantTextEmitted: false, toolOutputEmitted: false, reasoningEmitted: false },
    };
};
