import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { writeFileAtomic } from "@velum-labs/routekit-runtime/filesystem";

const SKILL_NAME = "setup-eval-routing";
const SKILL_FILE = "SKILL.md";
const OWNERSHIP_FILE = ".routekit-install.json";

type SkillOwnership = {
  version: 1;
  owner: "routekit";
  skill: typeof SKILL_NAME;
  contentHash: string;
};

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function entryIfExists(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function assertDirectoryIfExists(path: string, label: string): void {
  const entry = entryIfExists(path);
  if (entry === undefined) return;
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error(`${label} must be a real directory: ${path}`);
  }
}

function assertRegularFileIfExists(path: string, label: string): void {
  const entry = entryIfExists(path);
  if (entry === undefined) return;
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new Error(`${label} must be a regular file: ${path}`);
  }
}

function paths(configPath: string): {
  skillsDirectory: string;
  skillDirectory: string;
  skillPath: string;
  ownershipPath: string;
} {
  const skillsDirectory = join(dirname(configPath), "skills");
  const skillDirectory = join(skillsDirectory, SKILL_NAME);
  return {
    skillsDirectory,
    skillDirectory,
    skillPath: join(skillDirectory, SKILL_FILE),
    ownershipPath: join(skillDirectory, OWNERSHIP_FILE)
  };
}

function sourcePath(): string {
  const packageEntry = fileURLToPath(import.meta.resolve("@velum-labs/routekit-eval-setup"));
  return resolve(dirname(packageEntry), "..", "skills", SKILL_NAME, SKILL_FILE);
}

function parseOwnership(path: string): SkillOwnership {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`RouteKit skill ownership metadata is invalid (${path})`, { cause: error });
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (value as Record<string, unknown>).version !== 1 ||
    (value as Record<string, unknown>).owner !== "routekit" ||
    (value as Record<string, unknown>).skill !== SKILL_NAME ||
    typeof (value as Record<string, unknown>).contentHash !== "string"
  ) {
    throw new Error(`RouteKit skill ownership metadata is invalid (${path})`);
  }
  return value as SkillOwnership;
}

function removeDirectoryIfEmpty(path: string): void {
  try {
    rmdirSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
  }
}

function inspectInstall(configPath: string): {
  resolved: ReturnType<typeof paths>;
  source: string;
} {
  const resolved = paths(configPath);
  assertDirectoryIfExists(resolved.skillsDirectory, "coding-agent skills directory");
  assertDirectoryIfExists(resolved.skillDirectory, `coding-agent ${SKILL_NAME} skill directory`);
  assertRegularFileIfExists(resolved.skillPath, `coding-agent ${SKILL_NAME} skill`);
  assertRegularFileIfExists(resolved.ownershipPath, "RouteKit skill ownership metadata");

  const source = readFileSync(sourcePath(), "utf8");
  const existing = existsSync(resolved.skillPath)
    ? readFileSync(resolved.skillPath, "utf8")
    : undefined;
  if (existsSync(resolved.ownershipPath)) {
    const ownership = parseOwnership(resolved.ownershipPath);
    if (
      existing !== undefined &&
      contentHash(existing) !== ownership.contentHash &&
      existing !== source
    ) {
      throw new Error(
        `the RouteKit-managed ${SKILL_NAME} skill was edited (${resolved.skillPath}); ` +
          "move it aside before rerunning the install"
      );
    }
  } else if (existing !== undefined && existing !== source) {
    throw new Error(
      `refusing to overwrite an existing ${SKILL_NAME} skill: ${resolved.skillPath}; ` +
        "move it aside before rerunning the install"
    );
  }
  return { resolved, source };
}

export function assertNativeEvalSkillInstallable(configPath: string): void {
  inspectInstall(configPath);
}

export function installNativeEvalSkill(configPath: string): string {
  const { resolved, source } = inspectInstall(configPath);
  mkdirSync(resolved.skillDirectory, { recursive: true });
  writeFileAtomic(resolved.skillPath, source, { mode: 0o644 });
  const ownership: SkillOwnership = {
    version: 1,
    owner: "routekit",
    skill: SKILL_NAME,
    contentHash: contentHash(source)
  };
  writeFileAtomic(resolved.ownershipPath, `${JSON.stringify(ownership, null, 2)}\n`, {
    mode: 0o600
  });
  return resolved.skillPath;
}

export function uninstallNativeEvalSkill(configPath: string): void {
  const resolved = paths(configPath);
  assertDirectoryIfExists(resolved.skillsDirectory, "coding-agent skills directory");
  assertDirectoryIfExists(resolved.skillDirectory, `coding-agent ${SKILL_NAME} skill directory`);
  assertRegularFileIfExists(resolved.skillPath, `coding-agent ${SKILL_NAME} skill`);
  assertRegularFileIfExists(resolved.ownershipPath, "RouteKit skill ownership metadata");
  if (!existsSync(resolved.ownershipPath)) return;

  const ownership = parseOwnership(resolved.ownershipPath);
  if (
    existsSync(resolved.skillPath) &&
    contentHash(readFileSync(resolved.skillPath, "utf8")) === ownership.contentHash
  ) {
    rmSync(resolved.skillPath);
  }
  rmSync(resolved.ownershipPath);
  removeDirectoryIfEmpty(resolved.skillDirectory);
  removeDirectoryIfEmpty(resolved.skillsDirectory);
}
