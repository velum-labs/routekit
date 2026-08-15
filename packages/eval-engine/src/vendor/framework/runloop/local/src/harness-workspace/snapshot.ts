import type { FileSystem, Path } from "effect";

import { Crypto, Effect, Encoding, Option } from "effect";

import type { RuntimeServerError } from "../../../../contracts/internal/src/errors.ts";

import { mapPlatformError } from "../runtime/server-error.ts";

const SNAPSHOT_ROOT = ".ori/snapshot";
const SNAPSHOT_CURRENT_LINK = "current";
const SNAPSHOT_SWAP_LINK = "current.swap";
const SNAPSHOT_GENERATION_PREFIX = "gen-";
const FIRST_GENERATION = 1;
const RETAINED_GENERATIONS = 2;
const SHA_256: Crypto.DigestAlgorithm = "SHA-256";
const FINGERPRINT_SEPARATOR = new Uint8Array([0]);
const textEncoder = new TextEncoder();

interface SkillMaterialization {
  readonly name: string;
  readonly preferNativeAgentsDirectory?: boolean;
  readonly sourceDir: string;
}

interface SnapshotGenerationState {
  readonly fingerprint: string;
  readonly generation: number;
}

const collectSnapshotGarbage = Effect.fn(
  "HarnessWorkspaceSnapshot.collectSnapshotGarbage"
)(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  input: {
    readonly generation: number;
    readonly snapshotRoot: string;
  }
) {
  const entries = yield* fs
    .readDirectory(input.snapshotRoot)
    .pipe(Effect.catchCause(() => Effect.succeed<readonly string[]>([])));
  const oldestRetained = input.generation - (RETAINED_GENERATIONS - 1);
  for (const entry of entries) {
    if (!entry.startsWith(SNAPSHOT_GENERATION_PREFIX)) {
      continue;
    }
    const entryGeneration = Number.parseInt(
      entry.slice(SNAPSHOT_GENERATION_PREFIX.length),
      10
    );
    if (
      !Number.isInteger(entryGeneration) ||
      entryGeneration >= oldestRetained
    ) {
      continue;
    }
    yield* fs
      .remove(path.join(input.snapshotRoot, entry), {
        force: true,
        recursive: true,
      })
      .pipe(Effect.catchCause(() => Effect.void));
  }
});

const digestFingerprint = Effect.fn(
  "HarnessWorkspaceSnapshot.digestFingerprint"
)(function* (crypto: Crypto.Crypto, chunks: readonly Uint8Array[]) {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const bytes = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }

  const digest = yield* crypto.digest(SHA_256, bytes).pipe(Effect.orDie);
  return Encoding.encodeBase64Url(digest);
});

interface SnapshotIo {
  readonly crypto: Crypto.Crypto;
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
}

const summarizeSkillTree = Effect.fn(
  "HarnessWorkspaceSnapshot.summarizeSkillTree"
)(function* (io: SnapshotIo, sourceDir: string) {
  const { crypto, fs, path } = io;
  const entries = yield* fs
    .readDirectory(sourceDir, { recursive: true })
    .pipe(Effect.catchCause(() => Effect.succeed<readonly string[]>([])));
  let fileCount = 0;
  let maxMtimeMs = 0;
  let totalSize = 0;
  const fingerprintChunks: Uint8Array[] = [];
  for (const entry of entries.toSorted((left, right) =>
    left.localeCompare(right)
  )) {
    const filePath = path.join(sourceDir, entry);
    const info = yield* fs.stat(filePath).pipe(Effect.option);
    if (Option.isNone(info) || info.value.type !== "File") {
      continue;
    }
    fileCount += 1;
    totalSize += Number(info.value.size);
    const mtimeMs = info.value.mtime.pipe(
      Option.map((mtime) => mtime.getTime()),
      Option.getOrElse(() => 0)
    );
    maxMtimeMs = Math.max(maxMtimeMs, mtimeMs);
    const content = yield* fs.readFile(filePath).pipe(Effect.option);
    if (Option.isNone(content)) {
      continue;
    }
    fingerprintChunks.push(
      textEncoder.encode(entry),
      FINGERPRINT_SEPARATOR,
      content.value,
      FINGERPRINT_SEPARATOR
    );
  }
  return {
    contentHash: yield* digestFingerprint(crypto, fingerprintChunks),
    fileCount,
    maxMtimeMs,
    totalSize,
  };
});

const makeSkillSetFingerprint = Effect.fn(
  "HarnessWorkspaceSnapshot.makeSkillSetFingerprint"
)(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  materializations: readonly SkillMaterialization[]
): Effect.fn.Return<string, RuntimeServerError, Crypto.Crypto> {
  const crypto = yield* Crypto.Crypto;
  const summaries = [];
  for (const materialization of materializations) {
    const summary = yield* summarizeSkillTree(
      {
        crypto,
        fs,
        path,
      },
      materialization.sourceDir
    );
    summaries.push({
      name: materialization.name,
      sourceDir: materialization.sourceDir,
      ...summary,
    });
  }
  // Deterministic in-memory serialization used only as the fingerprint hash
  // input below; the string is never persisted or parsed back, so there is no
  // boundary to validate with a schema.
  // @effect-diagnostics-next-line preferSchemaOverJson:off
  return JSON.stringify(summaries);
});

const ensureSnapshotDirectory = (
  fs: FileSystem.FileSystem,
  directory: string
): Effect.Effect<void, RuntimeServerError> =>
  fs
    .makeDirectory(directory, { recursive: true })
    .pipe(mapPlatformError("creating skill snapshot directory"));

/**
 * Make a snapshot generation visible for the current skill set. The generation is
 * an immutable copy of every skill directory under `.ori/snapshot/gen-<n>/`, exposed
 * through the single `.ori/snapshot/current` symlink. The swap is one atomic rename,
 * so a running harness either sees the whole previous generation or the whole new
 * one — never a partially materialized tree. Durable author edits under the feature
 * root therefore take effect at the next run boundary, not mid-run.
 */
export const ensureSnapshotGeneration = Effect.fn(
  "HarnessWorkspaceSnapshot.ensureSnapshotGeneration"
)(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  input: {
    readonly fingerprint: string;
    readonly materializations: readonly SkillMaterialization[];
    readonly previous: SnapshotGenerationState;
    readonly snapshotRoot: string;
  }
): Effect.fn.Return<number, RuntimeServerError> {
  const currentLinkPath = path.join(input.snapshotRoot, SNAPSHOT_CURRENT_LINK);
  const currentLink = yield* fs.readLink(currentLinkPath).pipe(Effect.option);
  const reusable =
    Option.isSome(currentLink) &&
    input.previous.fingerprint === input.fingerprint &&
    input.previous.generation >= FIRST_GENERATION;
  if (reusable) {
    return input.previous.generation;
  }

  const generation = input.previous.generation + 1;
  const generationDirName = `${SNAPSHOT_GENERATION_PREFIX}${generation}`;
  const generationDir = path.join(input.snapshotRoot, generationDirName);
  yield* fs
    .remove(generationDir, {
      force: true,
      recursive: true,
    })
    .pipe(mapPlatformError("clearing stale skill snapshot generation"));
  yield* ensureSnapshotDirectory(fs, generationDir);
  for (const materialization of input.materializations) {
    yield* fs
      .copy(
        materialization.sourceDir,
        path.join(generationDir, materialization.name)
      )
      .pipe(
        mapPlatformError("copying skill directory into snapshot generation")
      );
  }

  const swapLinkPath = path.join(input.snapshotRoot, SNAPSHOT_SWAP_LINK);
  yield* fs
    .remove(swapLinkPath, { force: true })
    .pipe(mapPlatformError("clearing stale skill snapshot swap link"));
  yield* fs
    .symlink(generationDirName, swapLinkPath)
    .pipe(mapPlatformError("staging skill snapshot swap link"));
  yield* fs
    .rename(swapLinkPath, currentLinkPath)
    .pipe(mapPlatformError("swapping skill snapshot generation"));
  yield* collectSnapshotGarbage(fs, path, {
    generation,
    snapshotRoot: input.snapshotRoot,
  });
  return generation;
});

export const makeSnapshotGenerationPath = (
  path: Path.Path,
  snapshotRoot: string,
  generation: number
): string =>
  path.join(snapshotRoot, `${SNAPSHOT_GENERATION_PREFIX}${generation}`);

export { SNAPSHOT_ROOT, SNAPSHOT_CURRENT_LINK, makeSkillSetFingerprint };
export type { SkillMaterialization, SnapshotGenerationState };
