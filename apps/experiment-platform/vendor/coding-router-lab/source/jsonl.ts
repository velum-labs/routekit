import { mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const readJsonl = async <T>(file: string): Promise<T[]> => {
  const text = await readFile(file, "utf8");
  const records: T[] = [];
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as T);
    } catch (error) {
      throw new Error(`${file}:${index + 1}: invalid JSON: ${String(error)}`);
    }
  }
  return records;
};

export const writeJsonlPrivate = async (file: string, records: readonly unknown[]): Promise<void> => {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}`;
  await writeFile(temporary, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, { mode: 0o600 });
  await rename(temporary, file);
};

export const appendJsonl = async (file: string, record: unknown): Promise<void> => {
  await mkdir(path.dirname(file), { recursive: true });
  const handle = await open(file, "a", 0o600);
  try { await handle.writeFile(`${JSON.stringify(record)}\n`); } finally { await handle.close(); }
};

export const assertPrivateFile = async (file: string): Promise<void> => {
  const info = await stat(file);
  if ((info.mode & 0o077) !== 0) throw new Error(`${file} must not be group/world accessible`);
};
