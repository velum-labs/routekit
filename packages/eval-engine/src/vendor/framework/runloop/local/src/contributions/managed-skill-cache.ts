import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";

import { Effect, FileSystem, Option, Path } from "effect";

import type { ManagedSkillPointer } from "../../../../contracts/internal/src/author-schemas/skill.ts";

import { parseMarkdownFrontmatter } from "../../../../utils/core/src/markdown-frontmatter.ts";

/**
 * On-disk layout for resolved managed skills (RFC 0002 skill.md). The cache is
 * namespaced by pointer kind because the two kinds differ in scope: a canonical
 * id is globally unique and safe to share across every workspace under one
 * `$HOME`, while a slug is unique only within the resolving workspace and must
 * be isolated per workspace or two workspaces sharing `$HOME` would serve each
 * other's cached content.
 */

const SKILLS_CACHE_DIR_SEGMENTS = [".ori", "skills-cache"] as const;
const SKILL_FILE_NAME = "SKILL.md";

const defaultSkillsCacheRoot = (path: Path.Path): string =>
  path.join(homedir(), ...SKILLS_CACHE_DIR_SEGMENTS);

// A slug is unique only within one workspace, so its cache generations are
// scoped by a stable hash of the workspace root; an id is globally unique and
// needs no such scope. The root is resolved to its real path first so a
// workspace reached through a symlink shares one cache namespace with its
// target; a root that does not exist yet hashes as written.
const workspaceCacheKey = (workspaceRoot: string): string => {
  let canonicalRoot = workspaceRoot;
  try {
    canonicalRoot = realpathSync(workspaceRoot);
  } catch {
    // Keep the raw path when it cannot be resolved.
  }
  return createHash("sha256").update(canonicalRoot).digest("hex");
};

const cachedSkillDir = (input: {
  readonly cacheRoot: string;
  readonly path: Path.Path;
  readonly pointer: ManagedSkillPointer;
  readonly version: number;
  readonly workspaceRoot: string;
}): string => {
  const scope =
    input.pointer.kind === "id"
      ? input.path.join("id", input.pointer.value)
      : input.path.join(
          "slug",
          workspaceCacheKey(input.workspaceRoot),
          input.pointer.value
        );
  return input.path.join(input.cacheRoot, scope, String(input.version));
};

// The lock file lives under the workspace root, so it is workspace-scoped by
// location; the key is namespaced by pointer kind so an id and a slug spelled
// the same never share one entry.
const skillsLockKey = (pointer: ManagedSkillPointer): string =>
  `${pointer.kind}:${pointer.value}`;

const readCachedSkillDocument = Effect.fn("ManagedSkill.readCachedDocument")(
  function* (cacheDir: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const raw = yield* fs
      .readFileString(path.join(cacheDir, SKILL_FILE_NAME))
      .pipe(Effect.option);
    if (Option.isNone(raw)) {
      return;
    }
    const parsed = yield* parseMarkdownFrontmatter(raw.value);
    return {
      body: parsed.body,
      frontmatter: parsed.frontmatter,
    };
  }
);

export {
  SKILL_FILE_NAME,
  cachedSkillDir,
  defaultSkillsCacheRoot,
  readCachedSkillDocument,
  skillsLockKey,
  workspaceCacheKey,
};
