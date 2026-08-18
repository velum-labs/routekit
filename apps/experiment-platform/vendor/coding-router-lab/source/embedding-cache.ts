import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { contentHash } from "./hash.ts";
import type { DenseVector } from "./types.ts";

export interface EmbeddingCacheEntry {
  model: string;
  inputHash: string;
  vector: number[];
  createdAt: string;
}

export class EmbeddingCache {
  readonly root: string;
  constructor(root: string) { this.root = root; }
  key(model: string, text: string): string { return contentHash({ model, text, serialization: "embedding-cache-v1" }); }
  private file(key: string): string { return path.join(this.root, `${key}.json`); }
  async get(model: string, id: string, text: string): Promise<DenseVector | undefined> {
    const key = this.key(model, text);
    try {
      const entry = JSON.parse(await readFile(this.file(key), "utf8")) as EmbeddingCacheEntry;
      if (entry.model !== model || entry.inputHash !== contentHash(text)) throw new Error(`Embedding cache corruption: ${key}`);
      return { id, values: entry.vector };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  async put(model: string, text: string, vector: DenseVector): Promise<void> {
    const key = this.key(model, text); await mkdir(this.root, { recursive: true, mode: 0o700 });
    const entry: EmbeddingCacheEntry = { model, inputHash: contentHash(text), vector: vector.values, createdAt: new Date().toISOString() };
    await writeFile(this.file(key), `${JSON.stringify(entry)}\n`, { mode: 0o600, flag: "wx" }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
  }
}
