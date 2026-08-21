import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { writeFileAtomic } from "@velum-labs/routekit-runtime/filesystem";

const SKILL_NAME = "routekit";
const LEGACY_SKILL_NAME = "setup-eval-routing";
const SKILL_FILE = "SKILL.md";
const OWNERSHIP_FILE = ".routekit-install.json";

type SkillOwnership = {
  version: 2;
  owner: "routekit";
  skill: typeof SKILL_NAME;
  files: Readonly<Record<string, string>>;
};

type LegacySkillOwnership = {
  version: 1;
  owner: "routekit";
  skill: typeof LEGACY_SKILL_NAME;
  contentHash: string;
};

type SourceFile = {
  relativePath: string;
  content: string;
  contentHash: string;
};

export type NativeRouteKitSkillInstallResult = {
  skillPath: string;
  legacySkill: "absent" | "removed" | "preserved";
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

function paths(
  configPath: string,
  skillName = SKILL_NAME
): {
  skillsDirectory: string;
  skillDirectory: string;
  skillPath: string;
  ownershipPath: string;
} {
  const skillsDirectory = join(dirname(configPath), "skills");
  const skillDirectory = join(skillsDirectory, skillName);
  return {
    skillsDirectory,
    skillDirectory,
    skillPath: join(skillDirectory, SKILL_FILE),
    ownershipPath: join(skillDirectory, OWNERSHIP_FILE)
  };
}

function sourceDirectory(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "skills", SKILL_NAME);
}

function normalizedRelativePath(path: string): string {
  return path.split(sep).join("/");
}

function assertSafeRelativePath(path: string): void {
  if (
    path.length === 0 ||
    isAbsolute(path) ||
    path === ".." ||
    path.startsWith("../") ||
    path.includes("/../")
  ) {
    throw new Error(`RouteKit skill ownership contains an unsafe path: ${path}`);
  }
}

function readSourceFiles(): readonly SourceFile[] {
  const root = sourceDirectory();
  const files: SourceFile[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`RouteKit skill source must not contain symbolic links: ${path}`);
      }
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`RouteKit skill source must contain only files and directories: ${path}`);
      }
      const content = readFileSync(path, "utf8");
      files.push({
        relativePath: normalizedRelativePath(relative(root, path)),
        content,
        contentHash: contentHash(content)
      });
    }
  };
  visit(root);
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function readTargetFilePaths(directory: string): readonly string[] {
  if (!existsSync(directory)) return [];
  const files: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`coding-agent RouteKit skill must not contain symbolic links: ${path}`);
      }
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(
          `coding-agent RouteKit skill must contain only files and directories: ${path}`
        );
      }
      files.push(normalizedRelativePath(relative(directory, path)));
    }
  };
  visit(directory);
  return files.sort();
}

function parseOwnership(path: string): SkillOwnership {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`RouteKit skill ownership metadata is invalid (${path})`, { cause: error });
  }
  const record = value as Record<string, unknown>;
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    record.version !== 2 ||
    record.owner !== "routekit" ||
    record.skill !== SKILL_NAME ||
    typeof record.files !== "object" ||
    record.files === null ||
    Array.isArray(record.files)
  ) {
    throw new Error(`RouteKit skill ownership metadata is invalid (${path})`);
  }
  const files = record.files as Record<string, unknown>;
  for (const [relativePath, hash] of Object.entries(files)) {
    assertSafeRelativePath(relativePath);
    if (typeof hash !== "string") {
      throw new Error(`RouteKit skill ownership metadata is invalid (${path})`);
    }
  }
  return value as SkillOwnership;
}

function parseLegacyOwnership(path: string): LegacySkillOwnership {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`RouteKit legacy skill ownership metadata is invalid (${path})`, {
      cause: error
    });
  }
  const record = value as Record<string, unknown>;
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    record.version !== 1 ||
    record.owner !== "routekit" ||
    record.skill !== LEGACY_SKILL_NAME ||
    typeof record.contentHash !== "string"
  ) {
    throw new Error(`RouteKit legacy skill ownership metadata is invalid (${path})`);
  }
  return value as LegacySkillOwnership;
}

function removeDirectoryIfEmpty(path: string): void {
  try {
    rmdirSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
  }
}

function removeEmptyParents(path: string, root: string): void {
  let current = dirname(path);
  while (current !== root && current.startsWith(`${root}${sep}`)) {
    removeDirectoryIfEmpty(current);
    current = dirname(current);
  }
}

function inspectInstall(configPath: string): {
  resolved: ReturnType<typeof paths>;
  sourceFiles: readonly SourceFile[];
  previousOwnership?: SkillOwnership;
} {
  const resolved = paths(configPath);
  assertDirectoryIfExists(resolved.skillsDirectory, "coding-agent skills directory");
  assertDirectoryIfExists(resolved.skillDirectory, `coding-agent ${SKILL_NAME} skill directory`);
  assertRegularFileIfExists(resolved.ownershipPath, "RouteKit skill ownership metadata");

  const sourceFiles = readSourceFiles();
  const sourceByPath = new Map(sourceFiles.map((file) => [file.relativePath, file]));
  const targetPaths = readTargetFilePaths(resolved.skillDirectory).filter(
    (relativePath) => relativePath !== OWNERSHIP_FILE
  );

  if (existsSync(resolved.ownershipPath)) {
    const ownership = parseOwnership(resolved.ownershipPath);
    for (const [relativePath, previousHash] of Object.entries(ownership.files)) {
      const targetPath = join(resolved.skillDirectory, relativePath);
      assertRegularFileIfExists(targetPath, `coding-agent ${SKILL_NAME} skill file`);
      if (!existsSync(targetPath)) continue;
      const actualHash = contentHash(readFileSync(targetPath, "utf8"));
      const nextHash = sourceByPath.get(relativePath)?.contentHash;
      if (actualHash !== previousHash && actualHash !== nextHash) {
        throw new Error(
          `the RouteKit-managed ${SKILL_NAME} skill was edited (${targetPath}); ` +
            "move it aside before rerunning the install"
        );
      }
    }
    for (const source of sourceFiles) {
      if (ownership.files[source.relativePath] !== undefined) continue;
      const targetPath = join(resolved.skillDirectory, source.relativePath);
      assertRegularFileIfExists(targetPath, `coding-agent ${SKILL_NAME} skill file`);
      if (
        existsSync(targetPath) &&
        contentHash(readFileSync(targetPath, "utf8")) !== source.contentHash
      ) {
        throw new Error(
          `refusing to overwrite an unowned ${SKILL_NAME} skill file: ${targetPath}; ` +
            "move it aside before rerunning the install"
        );
      }
    }
    return { resolved, sourceFiles, previousOwnership: ownership };
  }

  if (targetPaths.length > 0) {
    const exactSource =
      targetPaths.length === sourceFiles.length &&
      targetPaths.every((relativePath) => {
        const source = sourceByPath.get(relativePath);
        return (
          source !== undefined &&
          contentHash(readFileSync(join(resolved.skillDirectory, relativePath), "utf8")) ===
            source.contentHash
        );
      });
    if (!exactSource) {
      throw new Error(
        `refusing to overwrite an existing ${SKILL_NAME} skill: ${resolved.skillDirectory}; ` +
          "move it aside before rerunning the install"
      );
    }
  }
  return { resolved, sourceFiles };
}

function removeLegacyManagedSkill(configPath: string): "absent" | "removed" | "preserved" {
  const resolved = paths(configPath, LEGACY_SKILL_NAME);
  const skillEntry = entryIfExists(resolved.skillDirectory);
  const ownershipEntry = entryIfExists(resolved.ownershipPath);
  if (skillEntry === undefined && ownershipEntry === undefined) return "absent";
  if (
    skillEntry?.isSymbolicLink() === true ||
    (skillEntry !== undefined && !skillEntry.isDirectory()) ||
    ownershipEntry?.isSymbolicLink() === true ||
    (ownershipEntry !== undefined && !ownershipEntry.isFile())
  ) {
    return "preserved";
  }
  if (ownershipEntry === undefined) return "preserved";

  let ownership: LegacySkillOwnership;
  try {
    ownership = parseLegacyOwnership(resolved.ownershipPath);
  } catch {
    return "preserved";
  }
  const unownedPaths = readTargetFilePaths(resolved.skillDirectory).filter(
    (relativePath) => relativePath !== SKILL_FILE && relativePath !== OWNERSHIP_FILE
  );
  const legacySkillEntry = entryIfExists(resolved.skillPath);
  const unchanged =
    legacySkillEntry === undefined ||
    (!legacySkillEntry.isSymbolicLink() &&
      legacySkillEntry.isFile() &&
      contentHash(readFileSync(resolved.skillPath, "utf8")) === ownership.contentHash);
  const removable = unchanged && unownedPaths.length === 0;
  if (removable && legacySkillEntry !== undefined) rmSync(resolved.skillPath);
  rmSync(resolved.ownershipPath);
  removeDirectoryIfEmpty(resolved.skillDirectory);
  removeDirectoryIfEmpty(resolved.skillsDirectory);
  return removable ? "removed" : "preserved";
}

export function assertNativeRouteKitSkillInstallable(configPath: string): void {
  inspectInstall(configPath);
}

export function installNativeRouteKitSkill(configPath: string): NativeRouteKitSkillInstallResult {
  const { resolved, sourceFiles, previousOwnership } = inspectInstall(configPath);
  mkdirSync(resolved.skillDirectory, { recursive: true });
  for (const source of sourceFiles) {
    const targetPath = join(resolved.skillDirectory, source.relativePath);
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileAtomic(targetPath, source.content, { mode: 0o644 });
  }
  for (const relativePath of Object.keys(previousOwnership?.files ?? {})) {
    if (sourceFiles.some((file) => file.relativePath === relativePath)) continue;
    const targetPath = join(resolved.skillDirectory, relativePath);
    if (existsSync(targetPath)) rmSync(targetPath);
    removeEmptyParents(targetPath, resolved.skillDirectory);
  }
  const ownership: SkillOwnership = {
    version: 2,
    owner: "routekit",
    skill: SKILL_NAME,
    files: Object.fromEntries(sourceFiles.map((file) => [file.relativePath, file.contentHash]))
  };
  writeFileAtomic(resolved.ownershipPath, `${JSON.stringify(ownership, null, 2)}\n`, {
    mode: 0o600
  });
  return {
    skillPath: resolved.skillPath,
    legacySkill: removeLegacyManagedSkill(configPath)
  };
}

export function uninstallNativeRouteKitSkill(configPath: string): void {
  const resolved = paths(configPath);
  assertDirectoryIfExists(resolved.skillsDirectory, "coding-agent skills directory");
  assertDirectoryIfExists(resolved.skillDirectory, `coding-agent ${SKILL_NAME} skill directory`);
  assertRegularFileIfExists(resolved.ownershipPath, "RouteKit skill ownership metadata");
  if (existsSync(resolved.ownershipPath)) {
    const ownership = parseOwnership(resolved.ownershipPath);
    for (const [relativePath, installedHash] of Object.entries(ownership.files)) {
      const targetPath = join(resolved.skillDirectory, relativePath);
      assertRegularFileIfExists(targetPath, `coding-agent ${SKILL_NAME} skill file`);
      if (
        existsSync(targetPath) &&
        contentHash(readFileSync(targetPath, "utf8")) === installedHash
      ) {
        rmSync(targetPath);
      }
      removeEmptyParents(targetPath, resolved.skillDirectory);
    }
    rmSync(resolved.ownershipPath);
    removeDirectoryIfEmpty(resolved.skillDirectory);
    removeDirectoryIfEmpty(resolved.skillsDirectory);
  }
  removeLegacyManagedSkill(configPath);
}
