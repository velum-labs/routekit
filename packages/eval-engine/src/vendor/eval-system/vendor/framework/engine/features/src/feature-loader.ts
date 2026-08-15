import { Effect, FileSystem, Path, Result, Schema } from "effect";

import type {
  FeatureLoaderDiagnostic,
  FeatureLoaderWarning,
} from "./feature-loader-diagnostics.ts";
import type {
  FeatureLocation,
  LoaderContext,
  Resolved,
} from "./feature-loader-resolution.ts";
import type {
  DiscoverFeaturesOptions,
  DiscoveredFeatures,
  ResolvedContribution,
  ResolvedFeature,
} from "./feature-loader-types.ts";

import {
  DATA_CONTRIBUTION_FILES,
  FEATURE_MODULE_EXPORTS,
  FEATURE_MODULE_FILE,
  WORKSPACE_FEATURE_ID_PATTERN,
} from "../../../contracts/internal/src/author-schemas/feature-manifest.ts";
import {
  FeatureLoaderError,
  FeatureManifestParseError,
} from "../../../contracts/internal/src/errors.ts";
import {
  DefaultExportFeatureModuleDiagnostic,
  HollowFeatureDiagnostic,
  InvalidFeatureDirectoryWarning,
  InvalidFeatureManifestDiagnostic,
  InvalidFeatureModuleDiagnostic,
} from "./feature-loader-diagnostics.ts";
import {
  dataContribution,
  resolveContribution,
} from "./feature-loader-paths.ts";
import {
  DEFERRED_FEATURE_MODULE_EXPORTS,
  defaultExportFeatureModuleKeys,
  deferredFeatureModuleContribution,
  featureModuleContribution,
  importFeatureModule,
  resolveCommandContributions,
  resolvePromptContributions,
  resolveScheduleContributions,
  unrecognizedExportWarnings,
} from "./feature-loader-resolution.ts";
import {
  ROOT_SKILLS_DIRECTORY,
  ROOT_SKILLS_FEATURE_ID,
  resolveRootSkillFeature,
  scanRootSkillWarnings,
} from "./feature-loader-skills.ts";
import { formatUnknownError } from "../../../utils/core/src/error-formatting.ts";

const DIRECTORY_TYPE = "Directory";

const FEATURE_MANIFEST_FILE = "feature.json";

const scanFeaturesRoot = Effect.fn("FeatureLoader.scanFeaturesRoot")(function* (
  ctx: LoaderContext,
  featuresRoot: string
) {
  const rootExists = yield* ctx.fs.exists(featuresRoot).pipe(
    Effect.mapError(
      (cause) =>
        new FeatureLoaderError({
          cause,
          detail: `Could not stat ${featuresRoot}`,
          operation: "reading features root",
        })
    )
  );
  if (!rootExists) {
    return [] as readonly string[];
  }

  const names = yield* ctx.fs.readDirectory(featuresRoot).pipe(
    Effect.mapError(
      (cause) =>
        new FeatureLoaderError({
          cause,
          detail: `Could not read ${featuresRoot}`,
          operation: "scanning features root",
        })
    )
  );
  return [...names].toSorted();
});

const isDirectory = Effect.fn("FeatureLoader.isDirectory")(function* (
  ctx: LoaderContext,
  dir: string
) {
  const stat = yield* ctx.fs.stat(dir).pipe(
    Effect.mapError(
      (cause) =>
        new FeatureLoaderError({
          cause,
          detail: `Could not stat ${dir}`,
          operation: "stating feature directory",
        })
    )
  );
  return stat.type === DIRECTORY_TYPE;
});

/**
 * Discover nested skills (RFC 0002 skill.md): every `skills/<name>/SKILL.md`
 * under the feature directory is its own skill contribution, in addition to any
 * root `SKILL.md`. A feature with only nested skills is therefore not hollow.
 */
const resolveSkillContributions = Effect.fn(
  "FeatureLoader.resolveSkillContributions"
)(function* (ctx: LoaderContext, location: FeatureLocation) {
  const { featureDir } = location;
  const skillsDir = ctx.path.join(featureDir, "skills");
  const present = yield* ctx.fs
    .exists(skillsDir)
    .pipe(Effect.orElseSucceed(() => false));
  if (!present) {
    return {
      diagnostics: [],
      value: [],
    } satisfies Resolved<readonly ResolvedContribution[]>;
  }
  const names = yield* ctx.fs
    .readDirectory(skillsDir)
    .pipe(Effect.orElseSucceed(() => []));
  const contributions: ResolvedContribution[] = [];
  const diagnostics: FeatureLoaderDiagnostic[] = [];
  for (const name of [...names].toSorted()) {
    const file = `skills/${name}/SKILL.md`;
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
  return {
    diagnostics,
    value: contributions,
  } satisfies Resolved<readonly ResolvedContribution[]>;
});

const validateIgnoredFeatureManifest = Effect.fn(
  "FeatureLoader.validateIgnoredFeatureManifest"
)(function* (ctx: LoaderContext, location: FeatureLocation) {
  const { featureDir, featureId } = location;
  const resolved = yield* resolveContribution(
    ctx,
    location,
    FEATURE_MANIFEST_FILE
  );
  if (resolved.value !== "present") {
    return resolved.diagnostics;
  }

  const manifestPath = ctx.path.join(featureDir, FEATURE_MANIFEST_FILE);
  const raw = yield* ctx.fs.readFileString(manifestPath).pipe(Effect.result);
  // Map both failure modes (read error, then JSON parse) into a single typed
  // channel so the `Result.isFailure` check below has one uniform failure type
  // — a raw read `PlatformError` and a `FeatureManifestParseError` would
  // otherwise unify to a union that trips `exactOptionalPropertyTypes`.
  const parsed = Result.isFailure(raw)
    ? Result.fail(new FeatureManifestParseError({ cause: raw.failure }))
    : yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(
        raw.success
      ).pipe(
        Effect.mapError((cause) => new FeatureManifestParseError({ cause })),
        Effect.result
      );
  if (Result.isFailure(parsed)) {
    return [
      ...resolved.diagnostics,
      new InvalidFeatureManifestDiagnostic({
        detail: formatUnknownError(parsed.failure),
        featureId,
      }),
    ];
  }
  return resolved.diagnostics;
});

const resolveFeatureModuleContributions = Effect.fn(
  "FeatureLoader.resolveFeatureModuleContributions"
)(function* (ctx: LoaderContext, location: FeatureLocation) {
  const { featureDir, featureId } = location;
  const resolved = yield* resolveContribution(
    ctx,
    location,
    FEATURE_MODULE_FILE
  );
  if (resolved.value !== "present") {
    return {
      deferredContributions: [],
      diagnostics: resolved.diagnostics,
      value: [],
      warnings: [],
    };
  }

  const modulePath = ctx.path.join(featureDir, FEATURE_MODULE_FILE);
  const imported = yield* importFeatureModule(modulePath).pipe(Effect.result);
  if (Result.isFailure(imported)) {
    return {
      deferredContributions: [],
      diagnostics: [
        ...resolved.diagnostics,
        new InvalidFeatureModuleDiagnostic({
          detail: formatUnknownError(imported.failure),
          featureId,
        }),
      ],
      value: [],
      warnings: [],
    };
  }

  const module = imported.success;
  if (defaultExportFeatureModuleKeys(module).length > 0) {
    return {
      deferredContributions: [],
      diagnostics: [
        ...resolved.diagnostics,
        new DefaultExportFeatureModuleDiagnostic({ featureId }),
      ],
      value: [],
      warnings: [],
    };
  }

  return {
    deferredContributions: DEFERRED_FEATURE_MODULE_EXPORTS.flatMap(
      (descriptor) => deferredFeatureModuleContribution(module, descriptor)
    ),
    diagnostics: resolved.diagnostics,
    value: FEATURE_MODULE_EXPORTS.flatMap((descriptor) =>
      featureModuleContribution(module, descriptor)
    ),
    warnings: unrecognizedExportWarnings(module, featureId),
  };
});

const resolveDataContributions = Effect.fn(
  "FeatureLoader.resolveDataContributions"
)(function* (ctx: LoaderContext, location: FeatureLocation) {
  const contributions: ResolvedContribution[] = [];
  const diagnostics: FeatureLoaderDiagnostic[] = [];

  for (const contribution of DATA_CONTRIBUTION_FILES) {
    const resolved = yield* resolveContribution(
      ctx,
      location,
      contribution.file
    );
    diagnostics.push(...resolved.diagnostics);
    if (resolved.value !== "present") {
      continue;
    }
    contributions.push(dataContribution(contribution));
  }

  return {
    diagnostics,
    value: contributions,
  } satisfies Resolved<readonly ResolvedContribution[]>;
});

const resolveContributions = Effect.fn("FeatureLoader.resolveContributions")(
  function* (ctx: LoaderContext, location: FeatureLocation) {
    const modules = yield* resolveFeatureModuleContributions(ctx, location);
    const data = yield* resolveDataContributions(ctx, location);
    const skills = yield* resolveSkillContributions(ctx, location);
    const schedules = yield* resolveScheduleContributions(
      ctx,
      location,
      resolveContribution
    );
    const commands = yield* resolveCommandContributions(
      ctx,
      location,
      resolveContribution
    );
    const prompts = yield* resolvePromptContributions(
      ctx,
      location,
      resolveContribution
    );
    return {
      deferredContributions: modules.deferredContributions,
      diagnostics: [
        ...modules.diagnostics,
        ...data.diagnostics,
        ...skills.diagnostics,
        ...schedules.diagnostics,
        ...commands.diagnostics,
        ...prompts.diagnostics,
      ],
      value: [
        ...modules.value,
        ...data.value,
        ...skills.value,
        ...schedules.value,
        ...commands.value,
        ...prompts.value,
      ],
      warnings: modules.warnings,
    };
  }
);

const resolveFeature = Effect.fn("FeatureLoader.resolveFeature")(function* (
  ctx: LoaderContext,
  location: FeatureLocation
) {
  const { featureId } = location;
  const manifestDiagnostics = yield* validateIgnoredFeatureManifest(
    ctx,
    location
  );
  const contributions = yield* resolveContributions(ctx, location);
  const diagnostics = [...manifestDiagnostics, ...contributions.diagnostics];
  const valid = diagnostics.length === 0;
  const hollow = contributions.value.length === 0;

  // Hollow only matters loudly when the feature is otherwise valid; an invalid
  // feature already reports a fatal diagnostic and would double-report here.
  const hollowWarning: readonly FeatureLoaderWarning[] =
    hollow && valid ? [new HollowFeatureDiagnostic({ featureId })] : [];
  const warnings = [...contributions.warnings, ...hollowWarning];

  return {
    contributions: contributions.value,
    ...(contributions.deferredContributions.length === 0
      ? {}
      : { deferredContributions: contributions.deferredContributions }),
    diagnostics,
    hollow,
    id: featureId,
    valid,
    ...(warnings.length === 0 ? {} : { warnings }),
  } satisfies ResolvedFeature;
});

export const discoverFeatures = Effect.fn("FeatureLoader.discoverFeatures")(
  function* (featuresRoot: string, options: DiscoverFeaturesOptions = {}) {
    const ctx: LoaderContext = {
      fs: yield* FileSystem.FileSystem,
      path: yield* Path.Path,
    };
    const affectedFeatureIds =
      options.affectedFeatureIds === undefined
        ? undefined
        : new Set(options.affectedFeatureIds);
    const previousById = new Map(
      (options.previousFeatures ?? []).map((feature) => [feature.id, feature])
    );
    // RFC 0002 requires ascending code-point order, which plain sort() provides.
    const sorted = yield* scanFeaturesRoot(ctx, featuresRoot);
    const features: ResolvedFeature[] = [];
    const warnings: FeatureLoaderWarning[] = [];
    for (const id of sorted) {
      if (id === ROOT_SKILLS_DIRECTORY) {
        continue;
      }
      const dir = ctx.path.join(featuresRoot, id);
      if (yield* isDirectory(ctx, dir)) {
        if (id.startsWith(".")) {
          continue;
        }
        if (!WORKSPACE_FEATURE_ID_PATTERN.test(id)) {
          // The directory name is the feature id; skipping invalid names keeps
          // them out of registries, event provenance, and use(featureId) lookups.
          warnings.push(
            new InvalidFeatureDirectoryWarning({ directoryName: id })
          );
          continue;
        }
        const previous = previousById.get(id);
        if (
          previous !== undefined &&
          affectedFeatureIds !== undefined &&
          !affectedFeatureIds.has(id)
        ) {
          features.push(previous);
          continue;
        }
        features.push(
          yield* resolveFeature(ctx, {
            featureDir: dir,
            featureId: id,
          })
        );
      }
    }
    const previousRootSkills = previousById.get(ROOT_SKILLS_FEATURE_ID);
    const rootSkills =
      affectedFeatureIds !== undefined &&
      !affectedFeatureIds.has(ROOT_SKILLS_FEATURE_ID)
        ? previousRootSkills
        : yield* resolveRootSkillFeature(ctx, featuresRoot);
    if (rootSkills !== undefined) {
      features.push(rootSkills);
      features.sort((left, right) => (left.id < right.id ? -1 : 1));
    }
    warnings.push(...(yield* scanRootSkillWarnings(ctx, featuresRoot, sorted)));
    return {
      features,
      warnings,
    } satisfies DiscoveredFeatures;
  }
);
