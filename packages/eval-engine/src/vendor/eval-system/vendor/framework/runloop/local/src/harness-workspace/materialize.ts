import type { FileSystem, Path } from "effect";

import { Effect, Option, Result, Schema } from "effect";

import type { SkillRegistryEntry } from "../../../../contracts/internal/src/author-schemas/skill.ts";
import type { SkillMaterialization } from "./snapshot.ts";
import type { MaterializedSkillsManifest } from "./steps.ts";

import { RuntimeServerError } from "../../../../contracts/internal/src/errors.ts";
import { encodeJsonString } from "../../../../contracts/internal/src/json.ts";
import {
  ensureDirectory,
  isSafeSkillDirectoryName,
} from "./links.ts";
import { mapPlatformError } from "../runtime/server-error.ts";

export const MANIFEST_VERSION = 2;

export const EMPTY_GENERATION = 0;

export const JSON_INDENT = 2;

const MaterializedSkillsManifestSchema = Schema.Struct({
  fingerprint: Schema.String,
  generation: Schema.Number,
  links: Schema.Array(Schema.String),
  version: Schema.Literal(MANIFEST_VERSION),
});

export const decodeMaterializedSkillsManifestJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(MaterializedSkillsManifestSchema),
  {
    onExcessProperty: "error",
  }
);

const emptyMaterializedSkillsManifest: MaterializedSkillsManifest = {
  fingerprint: "",
  generation: EMPTY_GENERATION,
  links: [],
  version: MANIFEST_VERSION,
};

const makeSkillMaterialization = Effect.fn(
  "HarnessWorkspaceMaterializer.makeSkillMaterialization"
)(function* (
  path: Path.Path,
  featuresRoot: string,
  skill: SkillRegistryEntry
): Effect.fn.Return<SkillMaterialization, RuntimeServerError> {
  if (!isSafeSkillDirectoryName(skill.name)) {
    return yield* new RuntimeServerError({
      detail: `skill "${skill.name}" cannot be materialized because its name is not a safe directory name`,
      operation: "materializing feature skills",
    });
  }

  return {
    name: skill.name,
    ...(skill.sourceDir === undefined
      ? {}
      : { preferNativeAgentsDirectory: true }),
    // Built-in skills carry an explicit sourceDir outside the feature root.
    sourceDir:
      skill.sourceDir ??
      path.dirname(path.join(featuresRoot, skill.featureId, skill.sourcePath)),
  };
});

export const readMaterializedSkillsManifest = Effect.fn(
  "HarnessWorkspaceMaterializer.readManifest"
)(function* (
  fs: FileSystem.FileSystem,
  manifestPath: string
): Effect.fn.Return<MaterializedSkillsManifest, RuntimeServerError> {
  const raw = yield* fs.readFileString(manifestPath).pipe(Effect.option);
  if (Option.isNone(raw)) {
    return emptyMaterializedSkillsManifest;
  }

  const decoded = yield* decodeMaterializedSkillsManifestJson(raw.value).pipe(
    Effect.result
  );
  if (Result.isFailure(decoded)) {
    return emptyMaterializedSkillsManifest;
  }

  return decoded.success;
});

export const writeMaterializedSkillsManifest = Effect.fn(
  "HarnessWorkspaceMaterializer.writeManifest"
)(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  input: {
    readonly manifest: MaterializedSkillsManifest;
    readonly manifestPath: string;
  }
) {
  yield* ensureDirectory(fs, path.dirname(input.manifestPath));
  const serialized = yield* encodeJsonString(
    MaterializedSkillsManifestSchema,
    JSON_INDENT
  )(input.manifest).pipe(
    Effect.mapError(
      (cause) =>
        new RuntimeServerError({
          detail: String(cause),
          operation: "encoding materialized feature skills manifest",
        })
    )
  );
  yield* fs
    .writeFileString(input.manifestPath, `${serialized}\n`)
    .pipe(mapPlatformError("writing materialized feature skills manifest"));
});

interface SkillMaterializations {
  readonly materializations: readonly SkillMaterialization[];
  readonly warnings: readonly string[];
}

const skillSourceIsDirectory = Effect.fn(
  "HarnessWorkspaceMaterializer.skillSourceIsDirectory"
)(function* (fs: FileSystem.FileSystem, sourceDir: string) {
  const info = yield* fs.stat(sourceDir).pipe(Effect.option);
  return Option.isSome(info) && info.value.type === "Directory";
});

/**
 * The boot skill registry is resolved once per boot, but the snapshot is
 * regenerated at every run boundary — so a skill's source tree can disappear
 * (a feature directory renamed or deleted mid-session) while its registry entry
 * lives on. Dropping such a skill with a warning keeps the run alive; copying it
 * would fail the whole turn, and keeping it in the materialization set would
 * leave a dangling link at its managed skill path.
 */
export const makeSkillMaterializations = Effect.fn(
  "HarnessWorkspaceMaterializer.makeSkillMaterializations"
)(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  input: {
    readonly featuresRoot: string;
    readonly skills: readonly SkillRegistryEntry[];
  }
): Effect.fn.Return<SkillMaterializations, RuntimeServerError> {
  const materializations: SkillMaterialization[] = [];
  const warnings: string[] = [];
  for (const skill of input.skills) {
    const materialization = yield* makeSkillMaterialization(
      path,
      input.featuresRoot,
      skill
    );
    if (yield* skillSourceIsDirectory(fs, materialization.sourceDir)) {
      materializations.push(materialization);
      continue;
    }
    warnings.push(
      `skill "${materialization.name}" was skipped: its source directory ${materialization.sourceDir} does not exist`
    );
  }
  return {
    materializations: materializations.toSorted((left, right) =>
      left.name.localeCompare(right.name)
    ),
    warnings,
  };
});

export type { SkillMaterializations };
