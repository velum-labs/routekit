import type { FileSystem, Path } from "effect";

import { Effect, Option } from "effect";

import type {
  HarnessWorkspacePaths,
  SkillLink,
} from "./steps.ts";

import { RuntimeServerError } from "../../../../contracts/internal/src/errors.ts";
import { SNAPSHOT_ROOT } from "./snapshot.ts";
import { mapPlatformError } from "../runtime/server-error.ts";

export const AGENTS_SKILL_ROOT = ".agents/skills";

export const CLAUDE_SKILL_ROOT = ".claude/skills";

const DIRECTORY_TYPE = "Directory";

export const isSafeSkillDirectoryName = (name: string): boolean =>
  name.length > 0 &&
  name !== "." &&
  name !== ".." &&
  !name.includes("/") &&
  !name.includes("\\");

export const ensureDirectory = (
  fs: FileSystem.FileSystem,
  directory: string
): Effect.Effect<void, RuntimeServerError> =>
  fs
    .makeDirectory(directory, { recursive: true })
    .pipe(mapPlatformError("creating harness workspace directory"));

// What to do with the state already occupying a desired link path (RFC 0002
// skill.md "Reconciling the managed skill roots").
type SymlinkSlotAction =
  | { readonly action: "create" }
  | { readonly action: "keep" }
  | { readonly action: "skip"; readonly warning: string };

const isWithinDirectory = (
  path: Path.Path,
  directory: string,
  candidate: string
): boolean => {
  const relative = path.relative(directory, candidate);
  return (
    relative.length > 0 &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );
};

// True when a symlink at `linkPath` pointing at `linkTarget` resolves inside the
// workspace's own managed tree (the snapshot store or the agents skill root) — the
// only shapes RouteKitEval materializes, so such a link is safe to adopt and rewrite.
export const resolvesWithinManagedTree = (
  path: Path.Path,
  input: {
    readonly linkPath: string;
    readonly linkTarget: string;
    readonly workspaceRoot: string;
  }
): boolean => {
  const resolvedTarget = path.isAbsolute(input.linkTarget)
    ? path.normalize(input.linkTarget)
    : path.resolve(path.dirname(input.linkPath), input.linkTarget);
  const managedRoots = [
    path.join(input.workspaceRoot, SNAPSHOT_ROOT),
    path.join(input.workspaceRoot, AGENTS_SKILL_ROOT),
  ];
  return managedRoots.some((root) =>
    isWithinDirectory(path, root, resolvedTarget)
  );
};

/**
 * Reconcile the existing state at `linkPath` before a symlink is written.
 * Adopts a stale link RouteKitEval owns (recorded in the manifest or resolving into the
 * managed tree), keeps a correct link or a native directory, skips a foreign
 * symlink with a warning, and fails only on a non-symlink occupant.
 */
const prepareSymlinkSlot = Effect.fn(
  "HarnessWorkspaceMaterializer.prepareSymlinkSlot"
)(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  input: {
    readonly linkPath: string;
    readonly linkTarget: string;
    readonly owned: boolean;
    readonly skipIfNativeExists?: boolean;
    readonly workspaceRoot: string;
  }
): Effect.fn.Return<SymlinkSlotAction, RuntimeServerError> {
  const currentLink = yield* fs.readLink(input.linkPath).pipe(Effect.option);
  if (Option.isSome(currentLink)) {
    if (currentLink.value === input.linkTarget) {
      return { action: "keep" };
    }
    // A link RouteKitEval may rewrite: one the manifest recorded, or one that still
    // resolves into the workspace's managed tree (an orphan from an interrupted
    // run or an older link layout). Anything else is a foreign, author-owned
    // symlink.
    const reclaimable =
      input.owned ||
      resolvesWithinManagedTree(path, {
        linkPath: input.linkPath,
        linkTarget: currentLink.value,
        workspaceRoot: input.workspaceRoot,
      });
    if (!reclaimable) {
      return {
        action: "skip",
        warning: `skipped materializing skill link ${input.linkPath}: a non-RouteKitEval symlink already points to ${currentLink.value}; leaving it untouched`,
      };
    }
    yield* fs
      .remove(input.linkPath, { force: true })
      .pipe(mapPlatformError("replacing materialized skill link"));
    return { action: "create" };
  }

  const linkExists = yield* fs
    .exists(input.linkPath)
    .pipe(mapPlatformError("checking materialized skill link"));
  if (linkExists) {
    if (input.skipIfNativeExists) {
      const info = yield* fs
        .stat(input.linkPath)
        .pipe(mapPlatformError("checking native skill directory"));
      if (info.type === DIRECTORY_TYPE) {
        return { action: "keep" };
      }
    }
    return yield* new RuntimeServerError({
      detail: `skill link path already exists and is not a symlink: ${input.linkPath}`,
      operation: "materializing feature skills",
    });
  }

  return { action: "create" };
});

const makeRelativeLinkTarget = (
  path: Path.Path,
  linkPath: string,
  targetPath: string
): string => {
  const relative = path.relative(path.dirname(linkPath), targetPath);
  return relative.length > 0 ? relative : ".";
};

// Reconcile one managed skill link. Returns `Option.none()` when the link is
// now materialized (created, adopted, already correct, or a built-in native
// directory left in place), or `Option.some(warning)` when a foreign symlink
// was skipped.
const ensureSymlink = Effect.fn("HarnessWorkspaceMaterializer.ensureSymlink")(
  function* (
    fs: FileSystem.FileSystem,
    path: Path.Path,
    input: {
      readonly linkPath: string;
      readonly owned: boolean;
      readonly skipIfNativeExists?: boolean;
      readonly targetPath: string;
      readonly workspaceRoot: string;
    }
  ): Effect.fn.Return<Option.Option<string>, RuntimeServerError> {
    const targetExists = yield* fs
      .exists(input.targetPath)
      .pipe(mapPlatformError("checking skill materialization target"));
    if (!targetExists) {
      return yield* new RuntimeServerError({
        detail: `materialized skill target does not exist: ${input.targetPath}`,
        operation: "materializing feature skills",
      });
    }

    const linkTarget = makeRelativeLinkTarget(
      path,
      input.linkPath,
      input.targetPath
    );
    const slot = yield* prepareSymlinkSlot(fs, path, {
      ...input,
      linkTarget,
    });
    if (slot.action === "skip") {
      return Option.some(slot.warning);
    }
    if (slot.action === "keep") {
      return Option.none<string>();
    }

    yield* fs
      .symlink(linkTarget, input.linkPath)
      .pipe(mapPlatformError("creating materialized skill link"));
    return Option.none<string>();
  }
);

const isDirectChildOfRoot = (normalized: string, root: string): boolean => {
  const rootParts = root.split("/");
  const parts = normalized.split("/");
  return (
    parts.length === rootParts.length + 1 &&
    rootParts.every((part, index) => parts[index] === part) &&
    isSafeSkillDirectoryName(parts[rootParts.length] ?? "")
  );
};

const isManagedRelativeSkillPath = (
  path: Path.Path,
  relativePath: string
): boolean => {
  if (path.isAbsolute(relativePath)) {
    return false;
  }
  const normalized = path.normalize(relativePath).replaceAll("\\", "/");
  return (
    isDirectChildOfRoot(normalized, AGENTS_SKILL_ROOT) ||
    isDirectChildOfRoot(normalized, CLAUDE_SKILL_ROOT)
  );
};

const collectManagedLinkCandidates = Effect.fn(
  "HarnessWorkspaceMaterializer.collectManagedLinkCandidates"
)(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  input: {
    readonly previousLinks: readonly string[];
    readonly workspaceRoot: string;
  }
) {
  const candidates = new Set<string>(input.previousLinks);
  for (const root of [AGENTS_SKILL_ROOT, CLAUDE_SKILL_ROOT]) {
    const entries = yield* fs
      .readDirectory(path.join(input.workspaceRoot, root))
      .pipe(Effect.catchCause(() => Effect.succeed<readonly string[]>([])));
    for (const entry of entries) {
      candidates.add(`${root}/${entry}`);
    }
  }
  return candidates;
});

const removeStaleLinks = Effect.fn(
  "HarnessWorkspaceMaterializer.removeStaleLinks"
)(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  input: {
    readonly desiredRelativePaths: ReadonlySet<string>;
    readonly previousLinks: readonly string[];
    readonly workspaceRoot: string;
  }
) {
  const previousLinkSet = new Set(input.previousLinks);
  // Derive removable links from the on-disk managed roots, not just the recorded
  // manifest, so orphans left by an interrupted run (links written before the
  // manifest) are still cleaned up.
  const candidates = yield* collectManagedLinkCandidates(fs, path, {
    previousLinks: input.previousLinks,
    workspaceRoot: input.workspaceRoot,
  });
  for (const relativePath of candidates) {
    if (
      input.desiredRelativePaths.has(relativePath) ||
      !isManagedRelativeSkillPath(path, relativePath)
    ) {
      continue;
    }
    const linkPath = path.join(input.workspaceRoot, relativePath);
    const linkTarget = yield* fs.readLink(linkPath).pipe(Effect.option);
    if (Option.isNone(linkTarget)) {
      continue;
    }
    // Only reclaim links RouteKitEval owns: ones the manifest recorded, or ones that still
    // resolve into the workspace's managed tree. A foreign symlink is left alone.
    const reclaimable =
      previousLinkSet.has(relativePath) ||
      resolvesWithinManagedTree(path, {
        linkPath,
        linkTarget: linkTarget.value,
        workspaceRoot: input.workspaceRoot,
      });
    if (!reclaimable) {
      continue;
    }
    yield* fs
      .remove(linkPath, { force: true })
      .pipe(mapPlatformError("removing stale materialized skill link"));
  }
});

export interface SkillLinkReconciliation {
  // Only the links actually materialized; a skipped foreign path is excluded so
  // the manifest never claims it as owned.
  readonly materializedRelativePaths: readonly string[];
  readonly warnings: readonly string[];
}

/**
 * Reconcile the materialized skill links on disk: ensure the skill-root
 * directories exist, prune managed links no longer desired (derived from the
 * on-disk roots, not just the manifest), then create/adopt each desired
 * symlink. Foreign symlinks are skipped with a warning instead of failing.
 */
export const reconcileSkillLinks = Effect.fn(
  "HarnessWorkspaceMaterializer.reconcileSkillLinks"
)(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  input: {
    readonly desiredLinks: readonly SkillLink[];
    readonly paths: HarnessWorkspacePaths;
    readonly previousLinks: readonly string[];
    readonly previousOwnedPaths: ReadonlySet<string>;
  }
): Effect.fn.Return<SkillLinkReconciliation, RuntimeServerError> {
  const { paths } = input;
  const desiredRelativePaths = new Set(
    input.desiredLinks.map((link) => link.relativePath)
  );

  yield* ensureDirectory(fs, paths.agentsSkillRoot);
  yield* ensureDirectory(fs, paths.claudeSkillRoot);
  yield* removeStaleLinks(fs, path, {
    desiredRelativePaths,
    previousLinks: input.previousLinks,
    workspaceRoot: paths.workspaceRoot,
  });

  const materializedRelativePaths: string[] = [];
  const warnings: string[] = [];
  for (const link of input.desiredLinks) {
    const skipWarning = yield* ensureSymlink(fs, path, {
      linkPath: path.join(paths.workspaceRoot, link.relativePath),
      owned: input.previousOwnedPaths.has(link.relativePath),
      ...(link.skipIfNativeExists ? { skipIfNativeExists: true } : {}),
      targetPath: link.targetPath,
      workspaceRoot: paths.workspaceRoot,
    });
    if (Option.isSome(skipWarning)) {
      warnings.push(skipWarning.value);
      continue;
    }
    materializedRelativePaths.push(link.relativePath);
  }

  return {
    materializedRelativePaths,
    warnings,
  };
});
