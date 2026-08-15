import { createHash } from "node:crypto";

import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import type { RemoteFeatureSource } from "./remote-feature-source.ts";

import { CliIo } from "../../../../contracts/internal/src/cli/cli-io.ts";
import { formatWarning } from "../../../../contracts/internal/src/cli/cli-messages.ts";
import { CliFailureError } from "../../../../contracts/internal/src/errors.ts";
import { isOkStatus } from "../../../../contracts/internal/src/http-client.ts";
import { encodeJsonString } from "../../../../contracts/internal/src/json.ts";
import { resolveGithubAuthToken } from "./github-app-token.ts";
import { formatRemoteFeatureSource } from "./remote-feature-source.ts";

export const REMOTE_FEATURES_META_DIR = ".meta";
export const PACKAGE_JSON_FILE = "package.json";
export const NODE_MODULES_DIRECTORY = "node_modules";
const GITHUB_API_VERSION = "2022-11-28";
const GITHUB_USER_AGENT = "routekit-eval";

export type MaterializedMetadataOutcome =
  | {
      readonly kind: "cache-hit" | "refreshed";
      readonly sha: string;
      readonly manifestFingerprint: Option.Option<string>;
    }
  | {
      readonly kind: "refreshed-without-sha" | "refresh-failed";
    };

export const metadataForDependencyInstall = (
  metadata: Option.Option<RemoteFeatureCacheMetadata>,
  refreshed: boolean,
  sha: Option.Option<string>
): Option.Option<RemoteFeatureCacheMetadata> =>
  refreshed && Option.isNone(sha) ? Option.none() : metadata;

export const metadataOutcomeFor = (input: {
  readonly cacheHit: boolean;
  readonly refreshed: boolean;
  readonly probedSha: Option.Option<string>;
  readonly manifestFingerprint: Option.Option<string>;
}): MaterializedMetadataOutcome => {
  if (input.cacheHit && Option.isSome(input.probedSha)) {
    return {
      kind: "cache-hit",
      sha: input.probedSha.value,
      manifestFingerprint: input.manifestFingerprint,
    };
  }
  if (input.refreshed && Option.isSome(input.probedSha)) {
    return {
      kind: "refreshed",
      sha: input.probedSha.value,
      manifestFingerprint: input.manifestFingerprint,
    };
  }
  if (input.refreshed) {
    return { kind: "refreshed-without-sha" };
  }
  return { kind: "refresh-failed" };
};

export const encodeGithubRef = (ref: string): string =>
  ref
    .split("/")
    .map((segment) =>
      segment === "." || segment === ".."
        ? encodeURIComponent(segment).replaceAll(".", "%2E")
        : encodeURIComponent(segment)
    )
    .join("/");
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const LOCK_FILES = [
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
] as const;
const PROCESS_SUCCESS_EXIT_CODE = 0;
const textEncoder = new TextEncoder();

export const RemoteFeatureCacheMetadataSchema = Schema.Struct({
  sha: Schema.String.pipe(Schema.check(Schema.isPattern(SHA_PATTERN))),
  manifestFingerprint: Schema.optionalKey(Schema.String),
});
const decodeRemoteFeatureCacheMetadata = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RemoteFeatureCacheMetadataSchema)
);
export type RemoteFeatureCacheMetadata =
  typeof RemoteFeatureCacheMetadataSchema.Type;

export const isImmutableRef = (ref: string): boolean => SHA_PATTERN.test(ref);

export const cacheMetadataPath = (cacheDir: string, path: Path.Path): string =>
  path.join(
    path.dirname(cacheDir),
    REMOTE_FEATURES_META_DIR,
    `${path.basename(cacheDir)}.json`
  );

export const readCacheMetadata = Effect.fn("RemoteFeatures.readCacheMetadata")(
  function* (metadataPath: string) {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs
      .readFileString(metadataPath)
      .pipe(Effect.flatMap(decodeRemoteFeatureCacheMetadata), Effect.option);
  }
);

export const writeCacheMetadata = Effect.fn(
  "RemoteFeatures.writeCacheMetadata"
)(function* (metadataPath: string, metadata: RemoteFeatureCacheMetadata) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serialized = yield* encodeJsonString(
    RemoteFeatureCacheMetadataSchema,
    2
  )(metadata);
  yield* fs.makeDirectory(path.dirname(metadataPath), { recursive: true });
  yield* fs.writeFileString(metadataPath, `${serialized}\n`);
});

export const persistMaterializedMetadata = Effect.fn(
  "RemoteFeatures.persistMaterializedMetadata"
)(function* (input: {
  readonly metadataPath: string;
  readonly outcome: MaterializedMetadataOutcome;
}) {
  const fs = yield* FileSystem.FileSystem;
  switch (input.outcome.kind) {
    case "cache-hit":
    case "refreshed": {
      const manifestFingerprint = Option.isSome(
        input.outcome.manifestFingerprint
      )
        ? { manifestFingerprint: input.outcome.manifestFingerprint.value }
        : {};
      yield* writeCacheMetadata(input.metadataPath, {
        sha: input.outcome.sha,
        ...manifestFingerprint,
      }).pipe(Effect.ignore);
      break;
    }
    case "refreshed-without-sha": {
      yield* fs.remove(input.metadataPath, { force: true }).pipe(Effect.ignore);
      break;
    }
    case "refresh-failed": {
      break;
    }
    default: {
      break;
    }
  }
});

export const manifestFingerprintFor = Effect.fn(
  "RemoteFeatures.manifestFingerprint"
)(function* (cacheDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const chunks: Uint8Array[] = [];
  for (const filename of [PACKAGE_JSON_FILE, ...LOCK_FILES]) {
    const contents = yield* fs
      .readFile(path.join(cacheDir, filename))
      .pipe(Effect.option);
    chunks.push(textEncoder.encode(filename), new Uint8Array([0]));
    if (Option.isSome(contents)) {
      chunks.push(contents.value);
    }
    chunks.push(new Uint8Array([0]));
  }
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const bytes = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return createHash("sha256").update(bytes).digest("hex");
});

export const resolveRemoteFeatureSha = Effect.fn("RemoteFeatures.resolveSha")(
  function* (source: RemoteFeatureSource) {
    const client = yield* HttpClient.HttpClient;
    const token = yield* resolveGithubAuthToken({
      owner: source.owner,
      repo: source.repo,
    });
    const url = `https://api.github.com/repos/${source.owner}/${source.repo}/commits/${encodeGithubRef(source.ref)}`;
    const request = Option.match(token, {
      onNone: () =>
        client.get(url, {
          headers: {
            accept: "application/vnd.github.sha",
            "user-agent": GITHUB_USER_AGENT,
            "x-github-api-version": GITHUB_API_VERSION,
          },
        }),
      onSome: (value) =>
        client.get(url, {
          headers: {
            accept: "application/vnd.github.sha",
            authorization: `token ${value}`,
            "user-agent": GITHUB_USER_AGENT,
            "x-github-api-version": GITHUB_API_VERSION,
          },
        }),
    });
    const response = yield* request;
    if (!isOkStatus(response.status)) {
      return yield* new CliFailureError({
        detail: `GitHub returned ${response.status} while resolving the ref.`,
      });
    }
    const sha = yield* response.text;
    return yield* Schema.decodeUnknownEffect(
      Schema.String.pipe(Schema.check(Schema.isPattern(SHA_PATTERN)))
    )(sha.trim());
  }
);

const runNpmInstall = Effect.fn("RemoteFeatures.runNpmInstall")(function* (
  cacheDir: string
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* spawner
    .exitCode(
      ChildProcess.make("npm", ["install", "--ignore-scripts", "--no-fund", "--no-audit"], {
        cwd: cacheDir,
        stderr: "ignore",
        stdout: "ignore",
      })
    )
    .pipe(
      Effect.map(Number),
      Effect.orElseSucceed(() => Number.NaN)
    );
});

/**
 * Provision a materialized root's declared dependencies with `npm install` in
 * the cache entry. The tarball ships only source, so without an install a
 * remote feature's imports could only resolve against the consuming
 * workspace's top-level `node_modules`. A failed install degrades to a stderr
 * warning: the workspace's own dependencies may still satisfy the imports.
 */
export const installRemoteFeatureDeps = Effect.fn("RemoteFeatures.installDeps")(
  function* (input: {
    readonly source: RemoteFeatureSource;
    readonly cacheDir: string;
    readonly metadata: Option.Option<RemoteFeatureCacheMetadata>;
  }) {
    const { source, cacheDir, metadata } = input;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cliIo = yield* CliIo;
    const hasManifest = yield* fs
      .exists(path.join(cacheDir, PACKAGE_JSON_FILE))
      .pipe(Effect.orElseSucceed(() => false));
    if (!hasManifest) {
      return Option.some(yield* manifestFingerprintFor(cacheDir));
    }
    const manifestFingerprint = yield* manifestFingerprintFor(cacheDir);
    const hasNodeModules = yield* fs
      .exists(path.join(cacheDir, NODE_MODULES_DIRECTORY))
      .pipe(Effect.orElseSucceed(() => false));
    if (
      hasNodeModules &&
      Option.isSome(metadata) &&
      metadata.value.manifestFingerprint === manifestFingerprint
    ) {
      return Option.some(manifestFingerprint);
    }
    const exitCode = yield* runNpmInstall(cacheDir);
    if (exitCode !== PROCESS_SUCCESS_EXIT_CODE) {
      yield* cliIo
        .writeStderr(
          `${formatWarning(`Could not install dependencies for ${formatRemoteFeatureSource(source)} (npm install failed); its imports may not resolve.`)}\n`
        )
        .pipe(Effect.ignore);
      return Option.none<string>();
    }
    return Option.some(yield* manifestFingerprintFor(cacheDir));
  }
);
