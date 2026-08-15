import { Effect } from "effect";

import type {
  FeatureLoaderDiagnostic,
  FeatureLoaderWarning,
} from "./feature-loader-diagnostics.ts";
import type {
  FeatureLocation,
  LoaderContext,
} from "./feature-loader-resolution.ts";
import type {
  ResolvedContribution,
  ResolvedFeature,
} from "./feature-loader-types.ts";

import { WORKSPACE_FEATURE_ID_PATTERN } from "../../../contracts/internal/src/author-schemas/feature-manifest.ts";
import {
  ReservedRootSkillsFileWarning,
  UnrecognizedSkillPathWarning,
} from "./feature-loader-diagnostics.ts";
import { resolveContribution } from "./feature-loader-paths.ts";

const DIRECTORY_TYPE = "Directory";
export const ROOT_SKILLS_DIRECTORY = "skills";
export const ROOT_SKILLS_FEATURE_ID = "skills";
const SKILL_FILE = "SKILL.md";
const MAX_UNRECOGNIZED_SKILL_SCAN_DEPTH = 4;
const FEATURE_ROOT_SKILL_SEGMENTS = 2;
const NESTED_SKILL_SEGMENTS = 4;
const ROOT_SKILL_SEGMENTS = 3;
const FEATURE_MODULE_FILE = "feature.ts";
const FEATURE_MANIFEST_FILE = "feature.json";
const RESERVED_ROOT_SKILLS_FILES = new Set([
  FEATURE_MODULE_FILE,
  FEATURE_MANIFEST_FILE,
  SKILL_FILE,
]);
const PRUNED_DIRECTORY_NAMES = new Set([
  ".git",
  ".next",
  ".turbo",
  ".vite",
  "build",
  "coverage",
  "generated",
  "lib",
  "dist",
  "node_modules",
  "out",
  "target",
  "tmp",
  "vendor",
]);

const isDirectory = Effect.fn("FeatureLoaderSkills.isDirectory")(function* (
  ctx: LoaderContext,
  directory: string
) {
  const stat = yield* ctx.fs.stat(directory).pipe(Effect.option);
  if (stat._tag === "None") {
    return false;
  }
  return stat.value.type === DIRECTORY_TYPE;
});

const isWithinRoot = Effect.fn("FeatureLoaderSkills.isWithinRoot")(function* (
  ctx: LoaderContext,
  root: string,
  target: string
) {
  const realRoot = yield* ctx.fs
    .realPath(root)
    .pipe(Effect.orElseSucceed(() => ctx.path.resolve(root)));
  const realTarget = yield* ctx.fs
    .realPath(target)
    .pipe(Effect.orElseSucceed(() => ctx.path.resolve(target)));
  return realTarget.startsWith(`${realRoot}${ctx.path.sep}`);
});

const isRecognizedSkillPath = (
  segments: readonly string[],
  recognizedFeatureIds: ReadonlySet<string>
): boolean => {
  if (segments.at(-1) !== SKILL_FILE) {
    return false;
  }
  if (
    segments.length === FEATURE_ROOT_SKILL_SEGMENTS &&
    segments[0] !== ROOT_SKILLS_DIRECTORY
  ) {
    return recognizedFeatureIds.has(segments[0] ?? "");
  }
  if (segments.length === NESTED_SKILL_SEGMENTS && segments[1] === "skills") {
    return recognizedFeatureIds.has(segments[0] ?? "");
  }
  return (
    segments.length === ROOT_SKILL_SEGMENTS &&
    segments[0] === ROOT_SKILLS_DIRECTORY
  );
};

const shouldPruneDirectory = (
  name: string,
  segments: readonly string[],
  recognizedFeatureIds: ReadonlySet<string>
): boolean =>
  PRUNED_DIRECTORY_NAMES.has(name) &&
  !(segments.length === 0 && recognizedFeatureIds.has(name));

const shouldSkipEntry = (
  name: string,
  segments: readonly string[],
  recognizedFeatureIds: ReadonlySet<string>
): boolean =>
  name.startsWith(".") ||
  shouldPruneDirectory(name, segments, recognizedFeatureIds);

export const scanUnrecognizedSkillPaths = Effect.fn(
  "FeatureLoaderSkills.scanUnrecognizedSkillPaths"
)(function* (
  ctx: LoaderContext,
  featuresRoot: string,
  featureIds: readonly string[]
) {
  const root = ctx.path.resolve(featuresRoot);
  const recognizedFeatureIds = new Set(
    featureIds.filter((id) => WORKSPACE_FEATURE_ID_PATTERN.test(id))
  );
  const warnings: FeatureLoaderWarning[] = [];

  const walk = Effect.fn("FeatureLoaderSkills.walk")(
    (
      directory: string,
      segments: readonly string[],
      depth: number
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (depth > MAX_UNRECOGNIZED_SKILL_SCAN_DEPTH) {
          return;
        }
        const entries = yield* ctx.fs
          .readDirectory(directory)
          .pipe(Effect.orElseSucceed(() => []));
        for (const entry of [...entries].toSorted()) {
          if (shouldSkipEntry(entry, segments, recognizedFeatureIds)) {
            continue;
          }
          const target = ctx.path.join(directory, entry);
          const targetSegments = [...segments, entry];
          if (entry === SKILL_FILE) {
            if (
              targetSegments.length === FEATURE_ROOT_SKILL_SEGMENTS &&
              targetSegments[0] === ROOT_SKILLS_DIRECTORY
            ) {
              continue;
            }
            if (!isRecognizedSkillPath(targetSegments, recognizedFeatureIds)) {
              warnings.push(
                new UnrecognizedSkillPathWarning({
                  filePath: targetSegments.join("/"),
                })
              );
            }
            continue;
          }
          if (
            targetSegments.length === 1 &&
            targetSegments[0] !== ROOT_SKILLS_DIRECTORY &&
            !recognizedFeatureIds.has(targetSegments[0] ?? "")
          ) {
            continue;
          }
          if (
            (yield* isDirectory(ctx, target)) &&
            (yield* isWithinRoot(ctx, root, target))
          ) {
            yield* walk(target, targetSegments, depth + 1);
          }
        }
      })
  );

  yield* walk(root, [], 0);
  return warnings;
});

export const scanReservedRootSkillsFiles = Effect.fn(
  "FeatureLoaderSkills.scanReservedRootSkillsFiles"
)(function* (ctx: LoaderContext, featuresRoot: string) {
  const skillsDir = ctx.path.join(featuresRoot, ROOT_SKILLS_DIRECTORY);
  if (
    !(yield* ctx.fs
      .exists(skillsDir)
      .pipe(Effect.orElseSucceed(() => false))) ||
    !(yield* isDirectory(ctx, skillsDir))
  ) {
    return [];
  }

  const warnings: FeatureLoaderWarning[] = [];
  const entries = yield* ctx.fs
    .readDirectory(skillsDir)
    .pipe(Effect.orElseSucceed(() => []));
  for (const entry of [...entries].toSorted()) {
    if (!RESERVED_ROOT_SKILLS_FILES.has(entry)) {
      continue;
    }
    const target = ctx.path.join(skillsDir, entry);
    if (!(yield* isDirectory(ctx, target))) {
      warnings.push(new ReservedRootSkillsFileWarning({ fileName: entry }));
    }
  }
  return warnings;
});

export const scanRootSkillWarnings = Effect.fn(
  "FeatureLoaderSkills.scanRootSkillWarnings"
)(function* (
  ctx: LoaderContext,
  featuresRoot: string,
  featureIds: readonly string[]
) {
  return [
    ...(yield* scanReservedRootSkillsFiles(ctx, featuresRoot)),
    ...(yield* scanUnrecognizedSkillPaths(ctx, featuresRoot, featureIds)),
  ];
});

export const resolveRootSkillFeature = Effect.fn(
  "FeatureLoaderSkills.resolveRootSkillFeature"
)(function* (ctx: LoaderContext, featuresRoot: string) {
  const skillsDir = ctx.path.join(featuresRoot, ROOT_SKILLS_DIRECTORY);
  const present = yield* ctx.fs
    .exists(skillsDir)
    .pipe(Effect.orElseSucceed(() => false));
  if (!present || !(yield* isDirectory(ctx, skillsDir))) {
    return;
  }

  const names = yield* ctx.fs
    .readDirectory(skillsDir)
    .pipe(Effect.orElseSucceed(() => []));
  const contributions: ResolvedContribution[] = [];
  const diagnostics: FeatureLoaderDiagnostic[] = [];
  const location: FeatureLocation = {
    featureDir: skillsDir,
    featureId: ROOT_SKILLS_FEATURE_ID,
  };
  for (const name of [...names].toSorted()) {
    const file = `${name}/${SKILL_FILE}`;
    const resolved = yield* resolveContribution(ctx, location, file);
    diagnostics.push(...resolved.diagnostics);
    if (resolved.value === "present") {
      contributions.push({
        entryKey: `skill/${name}`,
        file,
        kind: "skill",
      });
    }
  }
  if (contributions.length === 0 && diagnostics.length === 0) {
    return;
  }
  return {
    contributions,
    diagnostics,
    hollow: false,
    id: ROOT_SKILLS_FEATURE_ID,
    valid: diagnostics.length === 0,
  } satisfies ResolvedFeature;
});
