import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const createRunDirectory = async (root: string, runId: string): Promise<string> => {
  const directory = path.join(root, runId);
  await mkdir(path.join(directory, "private", "oracle-traces"), { recursive: true, mode: 0o700 });
  await mkdir(path.join(directory, "derived"), { recursive: true });
  await mkdir(path.join(directory, "metrics"), { recursive: true });
  return directory;
};

export const writeImmutable = async (file: string, value: unknown, privateFile = false): Promise<void> => {
  await mkdir(path.dirname(file), { recursive: true, mode: privateFile ? 0o700 : 0o755 });
  const text = typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(file, text, { flag: "wx", mode: privateFile ? 0o600 : 0o644 });
};
