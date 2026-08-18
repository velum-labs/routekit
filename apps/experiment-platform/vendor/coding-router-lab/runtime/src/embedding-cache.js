import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { contentHash } from "./hash.js";
export class EmbeddingCache {
    root;
    constructor(root) { this.root = root; }
    key(model, text) { return contentHash({ model, text, serialization: "embedding-cache-v1" }); }
    file(key) { return path.join(this.root, `${key}.json`); }
    async get(model, id, text) {
        const key = this.key(model, text);
        try {
            const entry = JSON.parse(await readFile(this.file(key), "utf8"));
            if (entry.model !== model || entry.inputHash !== contentHash(text))
                throw new Error(`Embedding cache corruption: ${key}`);
            return { id, values: entry.vector };
        }
        catch (error) {
            if (error.code === "ENOENT")
                return undefined;
            throw error;
        }
    }
    async put(model, text, vector) {
        const key = this.key(model, text);
        await mkdir(this.root, { recursive: true, mode: 0o700 });
        const entry = { model, inputHash: contentHash(text), vector: vector.values, createdAt: new Date().toISOString() };
        await writeFile(this.file(key), `${JSON.stringify(entry)}\n`, { mode: 0o600, flag: "wx" }).catch((error) => { if (error.code !== "EEXIST")
            throw error; });
    }
}
