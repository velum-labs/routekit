import { createHash } from "node:crypto";

import {
  Clock,
  DateTime,
  Effect,
  FileSystem,
  Option,
  Path,
  Result,
  Schema,
} from "effect";

import type { ManagedSkillPointer } from "../../../../contracts/internal/src/author-schemas/skill.ts";
import type { ManagedSkillFetcherShape } from "./managed-skill-fetcher.ts";

import { encodeJsonString } from "../../../../contracts/internal/src/json.ts";
import {
  cachedSkillDir,
  defaultSkillsCacheRoot,
  readCachedSkillDocument,
  SKILL_FILE_NAME,
  skillsLockKey,
} from "./managed-skill-cache.ts";
import {
  ManagedSkillFetcher,
  ManagedSkillFetchError,
} from "./managed-skill-fetcher.ts";
import { extractSkillBundleZip } from "./skill-bundle-zip.ts";
import { formatUnknownError } from "../../../../utils/core/src/error-formatting.ts";

/**
 * Managed skill resolution (RFC 0002 skill.md). A `SKILL.md` whose frontmatter
 * carries an `openrouter-skill-id` or `openrouter-skill-slug` pointer resolves
 * its body and support files from the OpenRouter managed skills API at the run
 * boundary, cache-first:
 *
 * 1. A warm cache generation is used directly (fast, offline); unpinned skills
 *    refresh in the background.
 * 2. A cold cache triggers a foreground fetch of the version bundle.
 * 3. On any failure the committed local body is the fallback; a skill with no
 *    local body surfaces a boot diagnostic instead of hard-failing boot.
 *
 * The resolved version is recorded in `.ori/skills-lock.json` so unpinned
 * skills stay reproducible between boots without committing churn-y fetch
 * metadata into `SKILL.md`. The cache and lock-key layout (namespaced by
 * pointer kind, with slugs additionally scoped per workspace) lives in
 * `managed-skill-cache.ts`.
 */

const SKILLS_LOCK_PATH_SEGMENTS = [".ori", "skills-lock.json"] as const;
const JSON_INDENT = 2;

const SkillsLockEntrySchema = Schema.Struct({
  contentHash: Schema.String,
  fetchedAt: Schema.String,
  version: Schema.Int,
});
export const SkillsLockSchema = Schema.Struct({
  skills: Schema.Record(Schema.String, SkillsLockEntrySchema),
});
type SkillsLock = typeof SkillsLockSchema.Type;
const decodeSkillsLockJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(SkillsLockSchema)
);

const emptySkillsLock: SkillsLock = { skills: {} };

const skillsLockPath = (path: Path.Path, workspaceRoot: string): string =>
  path.join(workspaceRoot, ...SKILLS_LOCK_PATH_SEGMENTS);

const readSkillsLock = Effect.fn("ManagedSkill.readLock")(function* (
  workspaceRoot: string
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const raw = yield* fs
    .readFileString(skillsLockPath(path, workspaceRoot))
    .pipe(Effect.option);
  if (Option.isNone(raw)) {
    return emptySkillsLock;
  }
  const decoded = yield* decodeSkillsLockJson(raw.value).pipe(Effect.result);
  return Result.isFailure(decoded) ? emptySkillsLock : decoded.success;
});

const writeSkillsLockEntry = Effect.fn("ManagedSkill.writeLockEntry")(
  function* (input: {
    readonly contentHash: string;
    readonly pointer: ManagedSkillPointer;
    readonly version: number;
    readonly workspaceRoot: string;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const lock = yield* readSkillsLock(input.workspaceRoot);
    const now = yield* DateTime.now;
    const updated: SkillsLock = {
      skills: {
        ...lock.skills,
        [skillsLockKey(input.pointer)]: {
          contentHash: input.contentHash,
          fetchedAt: DateTime.formatIso(now),
          version: input.version,
        },
      },
    };
    const lockPath = skillsLockPath(path, input.workspaceRoot);
    yield* fs.makeDirectory(path.dirname(lockPath), { recursive: true });
    const tmpPath = `${lockPath}.tmp`;
    const serialized = yield* encodeJsonString(
      SkillsLockSchema,
      JSON_INDENT
    )(updated);
    yield* fs.writeFileString(tmpPath, `${serialized}\n`);
    yield* fs.rename(tmpPath, lockPath);
  }
);

// Write into a sibling temp directory, then rename it into place. A concurrent
// resolver that won the race leaves an identical directory, so a failed rename
// with an existing target is adopted as-is.
const writeSkillCacheGeneration = Effect.fn("ManagedSkill.writeCache")(
  function* (input: {
    readonly bundle: Uint8Array;
    readonly cacheDir: string;
    readonly pointer: ManagedSkillPointer;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const files = yield* Effect.try({
      catch: (cause) =>
        new ManagedSkillFetchError({
          detail: formatUnknownError(cause),
        }),
      try: () => extractSkillBundleZip(input.bundle),
    });
    if (!files.some((file) => file.path === SKILL_FILE_NAME)) {
      return yield* new ManagedSkillFetchError({
        detail: `the bundle for managed skill "${input.pointer.value}" does not contain a root ${SKILL_FILE_NAME}`,
      });
    }
    const nowMillis = yield* Clock.currentTimeMillis;
    const tmpDir = `${input.cacheDir}.tmp-${process.pid}-${nowMillis}`;
    for (const file of files) {
      const target = path.join(tmpDir, file.path);
      yield* fs
        .makeDirectory(path.dirname(target), { recursive: true })
        .pipe(
          Effect.mapError(
            (cause) => new ManagedSkillFetchError({ detail: String(cause) })
          )
        );
      yield* fs
        .writeFile(target, file.data)
        .pipe(
          Effect.mapError(
            (cause) => new ManagedSkillFetchError({ detail: String(cause) })
          )
        );
    }
    const alreadyCached = yield* fs
      .exists(path.join(input.cacheDir, SKILL_FILE_NAME))
      .pipe(Effect.orElseSucceed(() => false));
    if (alreadyCached) {
      yield* fs.remove(tmpDir, { recursive: true }).pipe(Effect.ignore);
      return;
    }
    yield* fs
      .makeDirectory(path.dirname(input.cacheDir), { recursive: true })
      .pipe(Effect.ignore);
    yield* fs
      .rename(tmpDir, input.cacheDir)
      .pipe(
        Effect.catchCause(() =>
          fs.remove(tmpDir, { recursive: true }).pipe(Effect.ignore)
        )
      );
  }
);

const sha256Hex = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const fetchIntoCache = Effect.fn("ManagedSkill.fetchIntoCache")(
  function* (input: {
    readonly cacheRoot: string;
    readonly fetcher: ManagedSkillFetcherShape;
    readonly pointer: ManagedSkillPointer;
    readonly version: number;
    readonly workspaceRoot: string;
  }) {
    const path = yield* Path.Path;
    const bundle = yield* input.fetcher.fetchBundle(
      input.pointer.value,
      input.version
    );
    const cacheDir = cachedSkillDir({
      cacheRoot: input.cacheRoot,
      path,
      pointer: input.pointer,
      version: input.version,
      workspaceRoot: input.workspaceRoot,
    });
    yield* writeSkillCacheGeneration({
      bundle,
      cacheDir,
      pointer: input.pointer,
    });
    yield* writeSkillsLockEntry({
      contentHash: sha256Hex(bundle),
      pointer: input.pointer,
      version: input.version,
      workspaceRoot: input.workspaceRoot,
    }).pipe(Effect.ignore);
    return cacheDir;
  }
);

// A newer version lands only at the next run boundary (RFC 0002 per-run
// immutability), so this refresh is stale-while-revalidate; failures are ignored.
const refreshManagedSkill = Effect.fn("ManagedSkill.refresh")(
  function* (input: {
    readonly cacheRoot: string;
    readonly fetcher: ManagedSkillFetcherShape;
    readonly pointer: ManagedSkillPointer;
    readonly workspaceRoot: string;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const latest = yield* input.fetcher.fetchLatestVersion(input.pointer.value);
    const cacheDir = cachedSkillDir({
      cacheRoot: input.cacheRoot,
      path,
      pointer: input.pointer,
      version: latest,
      workspaceRoot: input.workspaceRoot,
    });
    const cached = yield* fs
      .exists(path.join(cacheDir, SKILL_FILE_NAME))
      .pipe(Effect.orElseSucceed(() => false));
    if (cached) {
      return;
    }
    yield* fetchIntoCache({
      cacheRoot: input.cacheRoot,
      fetcher: input.fetcher,
      pointer: input.pointer,
      version: latest,
      workspaceRoot: input.workspaceRoot,
    });
  }
);

interface ManagedSkillResolution {
  readonly body: string | undefined;
  // Error-level problems; a working fallback surfaces under `warnings` instead.
  readonly diagnostics: readonly string[];
  readonly remoteFrontmatter: Readonly<Record<string, unknown>> | undefined;
  readonly sourceDir: string | undefined;
  readonly warnings: readonly string[];
}

interface ResolveManagedSkillInput {
  readonly cacheRoot?: string | undefined;
  readonly localBody: string;
  readonly pinnedVersion: number | undefined;
  readonly pointer: ManagedSkillPointer;
  readonly workspaceRoot: string;
}

const fallbackResolution = (
  input: ResolveManagedSkillInput,
  detail: string
): ManagedSkillResolution => {
  // The committed body keeps the skill working, so this is a warning: the
  // feature stays valid and `ori features validate` passes (RFC 0002 skill.md).
  if (input.localBody.trim() !== "") {
    return {
      body: input.localBody,
      diagnostics: [],
      remoteFrontmatter: undefined,
      sourceDir: undefined,
      warnings: [
        `managed skill "${input.pointer.value}" could not be resolved (${detail}); using the committed fallback body`,
      ],
    };
  }
  return {
    body: undefined,
    diagnostics: [
      `managed skill "${input.pointer.value}" could not be resolved and has no committed fallback body (${detail})`,
    ],
    remoteFrontmatter: undefined,
    sourceDir: undefined,
    warnings: [],
  };
};

const resolveFromWarmCache = Effect.fn("ManagedSkill.resolveWarm")(function* (
  input: ResolveManagedSkillInput,
  cacheRoot: string,
  fetcher: ManagedSkillFetcherShape
) {
  const path = yield* Path.Path;
  const lock = yield* readSkillsLock(input.workspaceRoot);
  const knownVersion =
    input.pinnedVersion ?? lock.skills[skillsLockKey(input.pointer)]?.version;
  if (knownVersion === undefined) {
    return;
  }
  const cacheDir = cachedSkillDir({
    cacheRoot,
    path,
    pointer: input.pointer,
    version: knownVersion,
    workspaceRoot: input.workspaceRoot,
  });
  const cached = yield* readCachedSkillDocument(cacheDir);
  if (cached === undefined) {
    return;
  }
  if (input.pinnedVersion === undefined) {
    yield* refreshManagedSkill({
      cacheRoot,
      fetcher,
      pointer: input.pointer,
      workspaceRoot: input.workspaceRoot,
    }).pipe(Effect.ignore, Effect.forkDetach);
  }
  return {
    body: cached.body,
    diagnostics: [],
    remoteFrontmatter: cached.frontmatter,
    sourceDir: cacheDir,
    warnings: [],
  } satisfies ManagedSkillResolution;
});

export const resolveManagedSkill = Effect.fn("ManagedSkill.resolve")(function* (
  input: ResolveManagedSkillInput
) {
  const path = yield* Path.Path;
  const cacheRoot = input.cacheRoot ?? defaultSkillsCacheRoot(path);
  const fetcher = yield* ManagedSkillFetcher;

  const warm = yield* resolveFromWarmCache(input, cacheRoot, fetcher);
  if (warm !== undefined) {
    return warm;
  }

  const resolvedVersion =
    input.pinnedVersion === undefined
      ? yield* fetcher
          .fetchLatestVersion(input.pointer.value)
          .pipe(Effect.result)
      : Result.succeed(input.pinnedVersion);
  if (Result.isFailure(resolvedVersion)) {
    return fallbackResolution(input, resolvedVersion.failure.detail);
  }

  const cacheDir = cachedSkillDir({
    cacheRoot,
    path,
    pointer: input.pointer,
    version: resolvedVersion.success,
    workspaceRoot: input.workspaceRoot,
  });
  const cached = yield* readCachedSkillDocument(cacheDir);
  if (cached !== undefined) {
    return {
      body: cached.body,
      diagnostics: [],
      remoteFrontmatter: cached.frontmatter,
      sourceDir: cacheDir,
      warnings: [],
    } satisfies ManagedSkillResolution;
  }

  const fetched = yield* fetchIntoCache({
    cacheRoot,
    fetcher,
    pointer: input.pointer,
    version: resolvedVersion.success,
    workspaceRoot: input.workspaceRoot,
  }).pipe(Effect.result);
  if (Result.isFailure(fetched)) {
    return fallbackResolution(input, fetched.failure.detail);
  }

  const fetchedDocument = yield* readCachedSkillDocument(fetched.success);
  if (fetchedDocument === undefined) {
    return fallbackResolution(
      input,
      "the fetched bundle could not be materialized into the cache"
    );
  }
  return {
    body: fetchedDocument.body,
    diagnostics: [],
    remoteFrontmatter: fetchedDocument.frontmatter,
    sourceDir: fetched.success,
    warnings: [],
  } satisfies ManagedSkillResolution;
});

export type { ManagedSkillResolution, ResolveManagedSkillInput };
