import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { join, sep } from "node:path";
import { randomId } from "../runtime-timing.js";
import { trimSurroundingSlashes } from "../network/url.js";

/** The `git diff` of a working tree, or undefined when clean or not a repo. */
export function captureWorktreeDiff(cwd: string): string | undefined {
  try {
    const result = spawnSync("git", ["-C", cwd, "diff"], { encoding: "utf8" });
    const stdout = result.stdout ?? "";
    return result.status === 0 && stdout.length > 0 ? stdout : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Create an output directory. When it lives under one of the caller-owned
 * data-directory segments, drop a self-ignoring `.gitignore` so generated
 * artifacts never pollute the user's working tree.
 */
export function ensureRunOutputDir(
  dir: string,
  options: { dataDirectoryNames?: readonly string[] } = {}
): string {
  mkdirSync(dir, { recursive: true });
  const normalized = dir.split(sep).join("/");
  const inManagedDirectory = (options.dataDirectoryNames ?? []).some((name) => {
    const segment = trimSurroundingSlashes(name.split(sep).join("/"));
    return segment.length > 0 && `/${normalized}/`.includes(`/${segment}/`);
  });
  if (inManagedDirectory) {
    const ignorePath = join(dir, ".gitignore");
    if (!existsSync(ignorePath)) writeFileSync(ignorePath, "*\n");
  }
  return dir;
}

/** Atomically replace a UTF-8 file by writing a sibling temporary first. */
export function writeFileAtomic(
  path: string,
  content: string,
  options: { mode?: number } = {}
): void {
  const temporary = `${path}.${process.pid}.${randomId(8)}.tmp`;
  try {
    writeFileSync(temporary, content, {
      encoding: "utf8",
      ...(options.mode !== undefined ? { mode: options.mode } : {})
    });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export type FileLock = { release(): void };

/**
 * Acquire an exclusive lock file. Creation is atomic; callers own retry policy
 * and must release the returned handle.
 */
export function tryAcquireFileLock(path: string): FileLock | undefined {
  let descriptor: number;
  try {
    descriptor = openSync(path, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw error;
  }
  let released = false;
  return {
    release(): void {
      if (released) return;
      released = true;
      closeSync(descriptor);
      rmSync(path, { force: true });
    }
  };
}
