import type { Path } from "effect";

import type { SkillMaterialization } from "./snapshot.ts";

import {
  SNAPSHOT_CURRENT_LINK,
  SNAPSHOT_ROOT,
} from "./snapshot.ts";

const AGENTS_SKILL_ROOT = ".agents/skills";
const CLAUDE_SKILL_ROOT = ".claude/skills";
const CODE_SKILLS_ROOT = ".ori/code-skills";
const MATERIALIZED_SKILLS_MANIFEST = ".ori/materialized-skills.json";
const MANIFEST_VERSION = 2;

export interface SkillLink {
  readonly relativePath: string;
  readonly skipIfNativeExists?: boolean;
  readonly targetPath: string;
}

export interface MaterializedSkillsManifest {
  readonly fingerprint: string;
  readonly generation: number;
  readonly links: readonly string[];
  readonly version: typeof MANIFEST_VERSION;
}

export interface HarnessWorkspacePaths {
  readonly agentsSkillRoot: string;
  readonly claudeSkillRoot: string;
  readonly codeSkillsRoot: string;
  readonly featuresRoot: string;
  readonly manifestPath: string;
  readonly snapshotRoot: string;
  readonly snapshotCurrent: string;
  readonly workspaceRoot: string;
}

/**
 * The workspace root that anchors skill materialization: `dirname(featuresRoot)`
 * by default (the `ori dev`/`ori start` shape, where `featuresRoot` is
 * `<project>/features` or a nested intern subtree and `cwd` sits somewhere in
 * that same tree), or `cwd` itself when the caller explicitly says its
 * `featuresRoot` is disjoint from the launch directory.
 *
 * This used to be inferred purely from path shape, first via an ancestor
 * check between `cwd` and `dirname(featuresRoot)`, then via a structural
 * check on `featuresRoot` alone. Neither survives: an ancestor check can't
 * tell `ori dev`'s nested-intern shape (`cwd=/repo`,
 * `featuresRoot=/repo/features/toney/features`) apart from `ori code`
 * launched from an ancestor of its global workspace (`cwd=~`,
 * `featuresRoot=~/.ori/global/features`); and a `featuresRoot`-equality check
 * can't tell `ori code` apart from `ori dev`'s own fallback to that identical
 * `~/.ori/global/features` (RFC 0004 dev.md), which wants the opposite
 * anchor. Only the caller's actual intent disambiguates these, so it now
 * passes `anchorToCwd` explicitly (see `prepareAndLogWorkspace` in
 * `harness-workspace.ts`) instead of relying on inference from either path
 * shape.
 */
export const resolveHarnessWorkspaceRoot = (
  path: Path.Path,
  input: {
    readonly anchorToCwd?: boolean | undefined;
    readonly cwd: string;
    readonly featuresRoot: string;
  }
): string => {
  if (input.anchorToCwd) {
    return path.resolve(input.cwd);
  }
  const featuresRoot = path.resolve(input.featuresRoot);
  return path.dirname(featuresRoot);
};

export const makeHarnessWorkspacePaths = (
  path: Path.Path,
  featuresRootInput: string,
  workspaceRootInput: string
): HarnessWorkspacePaths => {
  const featuresRoot = path.resolve(featuresRootInput);
  const workspaceRoot = path.resolve(workspaceRootInput);
  return {
    agentsSkillRoot: path.join(workspaceRoot, AGENTS_SKILL_ROOT),
    claudeSkillRoot: path.join(workspaceRoot, CLAUDE_SKILL_ROOT),
    codeSkillsRoot: path.join(workspaceRoot, CODE_SKILLS_ROOT),
    featuresRoot,
    manifestPath: path.join(workspaceRoot, MATERIALIZED_SKILLS_MANIFEST),
    snapshotRoot: path.join(workspaceRoot, SNAPSHOT_ROOT),
    snapshotCurrent: path.join(
      workspaceRoot,
      SNAPSHOT_ROOT,
      SNAPSHOT_CURRENT_LINK
    ),
    workspaceRoot,
  };
};

export const makeManifest = (input: {
  readonly fingerprint: string;
  readonly generation: number;
  readonly links: readonly string[];
}): MaterializedSkillsManifest => ({
  fingerprint: input.fingerprint,
  generation: input.generation,
  links: input.links.toSorted(),
  version: MANIFEST_VERSION,
});

export const makeDesiredSkillLinks = (
  path: Path.Path,
  input: {
    readonly materializations: readonly SkillMaterialization[];
    readonly workspaceRoot: string;
  }
): readonly SkillLink[] => {
  const agentsLinks = input.materializations.map((skill) => ({
    relativePath: path.join(AGENTS_SKILL_ROOT, skill.name),
    ...(skill.preferNativeAgentsDirectory ? { skipIfNativeExists: true } : {}),
    targetPath: path.join(
      input.workspaceRoot,
      SNAPSHOT_ROOT,
      SNAPSHOT_CURRENT_LINK,
      skill.name
    ),
  }));
  // Keep the Claude-native view available for any harness that scans it.
  const claudeCompatibilityLinks = input.materializations.map((skill) => ({
    relativePath: path.join(CLAUDE_SKILL_ROOT, skill.name),
    targetPath: path.join(input.workspaceRoot, AGENTS_SKILL_ROOT, skill.name),
  }));
  return [...agentsLinks, ...claudeCompatibilityLinks];
};
