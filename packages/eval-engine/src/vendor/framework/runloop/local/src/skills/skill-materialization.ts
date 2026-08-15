import type { FileSystem, Path } from "effect";

import { tmpdir } from "node:os";

import { Effect, Option } from "effect";

import { mapPlatformError } from "../runtime/server-error.ts";

const CACHE_KEY_MODULUS = 4_294_967_291;
const CACHE_KEY_MULTIPLIER = 33;
const CACHE_KEY_RADIX = 36;
export type EmbeddedSkillFiles = readonly (readonly [string, string])[];

export const textImport = (content: unknown): string => {
  if (typeof content === "string") {
    return content;
  }
  throw new Error("embedded built-in skill import did not resolve to text");
};

const makeCacheKey = (files: EmbeddedSkillFiles): string => {
  let hash = 5381;
  for (const [relativePath, content] of files) {
    for (let index = 0; index < relativePath.length; index += 1) {
      hash =
        (hash * CACHE_KEY_MULTIPLIER + (relativePath.codePointAt(index) ?? 0)) %
        CACHE_KEY_MODULUS;
    }
    for (let index = 0; index < content.length; index += 1) {
      hash =
        (hash * CACHE_KEY_MULTIPLIER + (content.codePointAt(index) ?? 0)) %
        CACHE_KEY_MODULUS;
    }
  }
  return Math.trunc(hash).toString(CACHE_KEY_RADIX);
};

export const materializeEmbeddedSkillFiles = Effect.fn(
  "BuiltInSkillMaterialization.materializeEmbeddedSkillFiles"
)(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  input: {
    readonly cachePrefix: string;
    readonly files: EmbeddedSkillFiles;
  }
) {
  const sourceDir = path.join(
    tmpdir(),
    `${input.cachePrefix}-${makeCacheKey(input.files)}`
  );
  for (const [relativePath, content] of input.files) {
    const filePath = path.join(sourceDir, relativePath);
    const current = yield* fs.readFileString(filePath).pipe(Effect.option);
    if (Option.isSome(current) && current.value === content) {
      continue;
    }
    yield* fs
      .makeDirectory(path.dirname(filePath), { recursive: true })
      .pipe(mapPlatformError("creating embedded built-in skill cache"));
    yield* fs
      .writeFileString(filePath, content)
      .pipe(mapPlatformError("writing embedded built-in skill cache"));
  }
  return sourceDir;
});

export const resolveSkillSourceDir = Effect.fn(
  "BuiltInSkillMaterialization.resolveSkillSourceDir"
)(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  input: {
    readonly cachePrefix: string;
    readonly files: EmbeddedSkillFiles;
    readonly probeRelativePath: string;
    readonly sourceTreeDir: string | undefined;
  }
) {
  if (input.sourceTreeDir === undefined) {
    return yield* materializeEmbeddedSkillFiles(fs, path, {
      cachePrefix: input.cachePrefix,
      files: input.files,
    });
  }
  const sourceTreeSkillPath = path.join(
    input.sourceTreeDir,
    input.probeRelativePath
  );
  const sourceTreeSkillExists = yield* fs
    .exists(sourceTreeSkillPath)
    .pipe(mapPlatformError("checking built-in skill source tree"));
  if (sourceTreeSkillExists) {
    return input.sourceTreeDir;
  }

  return yield* materializeEmbeddedSkillFiles(fs, path, {
    cachePrefix: input.cachePrefix,
    files: input.files,
  });
});
