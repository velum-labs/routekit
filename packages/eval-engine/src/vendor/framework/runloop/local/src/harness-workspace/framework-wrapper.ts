import type { Crypto, FileSystem, Path } from "effect";

import { join as joinPath } from "node:path";

import { Clock, Effect, Option } from "effect";

import type { RuntimeServerError } from "../../../../contracts/internal/src/errors.ts";
import type { SkillMaterialization } from "./snapshot.ts";

import { mapPlatformError } from "../runtime/server-error.ts";

export const ensureCodeSkillsWrapper = Effect.fn(
  "HarnessWorkspaceMaterializer.ensureCodeSkillsWrapper"
)(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  input: {
    readonly codeSkillsRoot: string;
    readonly generationDir: string;
    readonly crypto: Crypto.Crypto;
  }
): Effect.fn.Return<void, RuntimeServerError> {
  yield* fs
    .makeDirectory(input.codeSkillsRoot, { recursive: true })
    .pipe(mapPlatformError("creating code skill wrapper directory"));
  const skillsLinkPath = path.join(input.codeSkillsRoot, "skills");
  const swapLinkPath = path.join(
    input.codeSkillsRoot,
    `skills.swap-${yield* input.crypto.randomUUIDv4.pipe(Effect.orDie)}`
  );
  yield* fs
    .remove(swapLinkPath, {
      force: true,
      recursive: true,
    })
    .pipe(mapPlatformError("clearing code skill wrapper swap link"));
  const linkTarget = path.relative(input.codeSkillsRoot, input.generationDir);
  yield* fs
    .symlink(linkTarget, swapLinkPath)
    .pipe(mapPlatformError("staging code skill wrapper swap link"));
  yield* fs
    .rename(swapLinkPath, skillsLinkPath)
    .pipe(mapPlatformError("swapping code skill wrapper"));
});

const RETAINED_GENERATIONS = 8;
const STALE_TEMPORARY_GENERATION_AGE_MS = 300_000;

const pruneFrameworkSkillGenerations = Effect.fn(
  "HarnessWorkspaceMaterializer.pruneFrameworkSkillGenerations"
)(function* (
  fs: FileSystem.FileSystem,
  generationsRoot: string,
  currentGeneration: string
) {
  const entries = yield* fs
    .readDirectory(generationsRoot)
    .pipe(Effect.orElseSucceed(() => []));
  const generations: { readonly mtime: Date; readonly name: string }[] = [];
  for (const name of entries) {
    if (name.includes(".tmp-") || name === currentGeneration) {
      continue;
    }
    const stat = yield* fs
      .stat(joinPath(generationsRoot, name))
      .pipe(Effect.option);
    if (Option.isSome(stat) && Option.isSome(stat.value.mtime)) {
      generations.push({
        mtime: stat.value.mtime.value,
        name,
      });
    }
  }
  generations.sort(
    (left, right) => right.mtime.getTime() - left.mtime.getTime()
  );
  for (const generation of generations.slice(RETAINED_GENERATIONS - 1)) {
    yield* fs
      .remove(joinPath(generationsRoot, generation.name), {
        force: true,
        recursive: true,
      })
      .pipe(Effect.ignore);
  }
  for (const temporaryName of entries.filter((entry) =>
    entry.includes(".tmp-")
  )) {
    const temporaryPath = joinPath(generationsRoot, temporaryName);
    const stat = yield* fs.stat(temporaryPath).pipe(Effect.option);
    const now = yield* Clock.currentTimeMillis;
    if (
      Option.isNone(stat) ||
      Option.isNone(stat.value.mtime) ||
      now - stat.value.mtime.value.getTime() < STALE_TEMPORARY_GENERATION_AGE_MS
    ) {
      continue;
    }
    yield* fs
      .remove(temporaryPath, {
        force: true,
        recursive: true,
      })
      .pipe(Effect.ignore);
  }
});

const ensureFrameworkSkillLink = Effect.fn(
  "HarnessWorkspaceMaterializer.ensureFrameworkSkillLink"
)(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  input: {
    readonly codeSkillsRoot: string;
    readonly crypto: Crypto.Crypto;
    readonly generationDir: string;
    readonly generationsRoot: string;
    readonly fingerprint: string;
  }
): Effect.fn.Return<void, RuntimeServerError> {
  yield* fs
    .makeDirectory(input.codeSkillsRoot, { recursive: true })
    .pipe(mapPlatformError("creating framework skill wrapper directory"));
  const skillsLinkPath = path.join(input.codeSkillsRoot, "skills");
  const target = path.relative(input.codeSkillsRoot, input.generationDir);
  const currentTarget = yield* fs.readLink(skillsLinkPath).pipe(Effect.option);
  if (Option.isSome(currentTarget) && currentTarget.value === target) {
    yield* pruneFrameworkSkillGenerations(
      fs,
      input.generationsRoot,
      input.fingerprint
    );
    return;
  }
  const swapLinkPath = path.join(
    input.codeSkillsRoot,
    `skills.swap-${yield* input.crypto.randomUUIDv4.pipe(Effect.orDie)}`
  );
  yield* fs
    .symlink(target, swapLinkPath)
    .pipe(mapPlatformError("staging framework skill wrapper link"));
  yield* fs
    .rename(swapLinkPath, skillsLinkPath)
    .pipe(mapPlatformError("swapping framework skill wrapper link"));
  yield* pruneFrameworkSkillGenerations(
    fs,
    input.generationsRoot,
    input.fingerprint
  );
});

export const ensureFrameworkSkillWrapper = Effect.fn(
  "HarnessWorkspaceMaterializer.ensureFrameworkSkillWrapper"
)(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  input: {
    readonly codeSkillsRoot: string;
    readonly crypto: Crypto.Crypto;
    readonly fingerprint: string;
    readonly materializations: readonly SkillMaterialization[];
  }
): Effect.fn.Return<void, RuntimeServerError> {
  const generationsRoot = path.join(input.codeSkillsRoot, "generations");
  const generationDir = path.join(generationsRoot, input.fingerprint);
  if (
    !(yield* fs.exists(generationDir).pipe(Effect.orElseSucceed(() => false)))
  ) {
    const temporaryDir = path.join(
      generationsRoot,
      `${input.fingerprint}.tmp-${yield* input.crypto.randomUUIDv4.pipe(Effect.orDie)}`
    );
    yield* fs
      .makeDirectory(temporaryDir, { recursive: true })
      .pipe(mapPlatformError("creating framework skill wrapper generation"));
    for (const materialization of input.materializations) {
      yield* fs
        .copy(
          materialization.sourceDir,
          path.join(temporaryDir, materialization.name)
        )
        .pipe(mapPlatformError("copying framework skill wrapper entry"));
    }
    yield* fs.rename(temporaryDir, generationDir).pipe(
      mapPlatformError("publishing framework skill wrapper generation"),
      Effect.catch((error) =>
        fs.exists(generationDir).pipe(
          Effect.orElseSucceed(() => false),
          Effect.flatMap((exists) =>
            exists ? Effect.void : Effect.fail(error)
          )
        )
      )
    );
  }
  yield* ensureFrameworkSkillLink(fs, path, {
    codeSkillsRoot: input.codeSkillsRoot,
    crypto: input.crypto,
    fingerprint: input.fingerprint,
    generationDir,
    generationsRoot,
  });
});
