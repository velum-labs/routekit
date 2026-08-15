import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import type { RemoteFeatureSource } from "./remote-feature-source.ts";

import { CliIo } from "../../../../contracts/internal/src/cli/cli-io.ts";
import { formatWarning } from "../../../../contracts/internal/src/cli/cli-messages.ts";
import { HostProcess } from "../../../../contracts/internal/src/cli/host-process.ts";
import { CliFailureError } from "../../../../contracts/internal/src/errors.ts";
import { isOkStatus } from "../../../../contracts/internal/src/http-client.ts";
import { resolveGithubAuthToken } from "./github-app-token.ts";
import {
  cacheMetadataPath,
  encodeGithubRef,
  isImmutableRef,
  installRemoteFeatureDeps,
  metadataForDependencyInstall,
  metadataOutcomeFor,
  NODE_MODULES_DIRECTORY,
  persistMaterializedMetadata,
  readCacheMetadata,
  resolveRemoteFeatureSha,
} from "./remote-feature-cache.ts";
import {
  decodeRemoteFeatureSource,
  decodeRemoteFeatureSourceSync,
  formatRemoteFeatureSource,
  GITHUB_HOST,
} from "./remote-feature-source.ts";
import { retryFetchOverSsh } from "./remote-feature-ssh-fallback-live.ts";
import {
  RouteKitEvalDirectory,
  ROUTEKIT_EVAL_DIRECTORY_NAME,
} from "../../routekit-eval-directory.ts";
import { formatUnknownError } from "../../../../utils/core/src/error-formatting.ts";

/**
 * Remote feature roots: `--features` accepts a repo path like
 * `github.com/GatewayInterns/features[/sub/dir][@ref]` anywhere it accepts
 * a local directory. Downloaded as a tarball (HTTPS + `tar`) into the
 * `.routekit-eval/remote-features` cache, with a `git`-over-SSH backup on HTTPS failure
 * (see `remote-feature-ssh-fallback.ts`). Spec: docs/rfcs/0004-cli/features.md.
 */

/** Subdirectory of `.routekit-eval/` holding materialized remote feature roots. */
const REMOTE_FEATURES_CACHE_DIR = "remote-features";

const ARCHIVE_TEMP_PREFIX = "routekit-eval-remote-features-";
const ARCHIVE_FILE_NAME = "repo.tar.gz";
const PROCESS_SUCCESS_EXIT_CODE = 0;

/** True when the `--features` value names a remote repo path. */
const isRemoteFeaturesInput = (value: string): boolean =>
  value.startsWith(`${GITHUB_HOST}/`) ||
  value.startsWith(`https://${GITHUB_HOST}/`);

/**
 * Parse a `--features` value as a remote repo path. Returns `undefined` for
 * anything that does not carry the `github.com/` prefix (a local directory),
 * and throws a `SchemaError` only when the value clearly targets GitHub but is
 * malformed — a plain local path must never produce a remote-parse error. The
 * synchronous decode mirrors the boundary grammar; the Effect variant below is
 * what production code uses.
 */
const parseRemoteFeatureSource = (
  value: string
): RemoteFeatureSource | undefined =>
  isRemoteFeaturesInput(value)
    ? decodeRemoteFeatureSourceSync(value)
    : undefined;

/**
 * {@link parseRemoteFeatureSource} in the Effect channel: a malformed remote
 * value fails as a CliFailureError (carrying the underlying `SchemaError` as
 * its cause) so every `--features` consumer surfaces the same error shape. A
 * local path resolves to `undefined` without touching the decoder.
 */
const parseRemoteFeatureSourceEffect = (
  value: string
): Effect.Effect<RemoteFeatureSource | undefined, CliFailureError> => {
  if (!isRemoteFeaturesInput(value)) {
    return Effect.sync((): RemoteFeatureSource | undefined => undefined);
  }
  return decodeRemoteFeatureSource(value).pipe(
    Effect.mapError(
      (cause) =>
        new CliFailureError({
          cause,
          detail: formatUnknownError(cause),
        })
    )
  );
};

// Refs may contain `/` (e.g. `feature/x`); percent-encode to one directory
// name so distinct refs never share a cache entry.
const refDirectoryName = (ref: string): string => encodeURIComponent(ref);

const cacheDirFor = Effect.fn("RemoteFeatures.cacheDir")(function* (
  source: RemoteFeatureSource
) {
  const path = yield* Path.Path;
  const hostProcess = yield* HostProcess;
  const routeKitEvalDirectory = yield* RouteKitEvalDirectory;
  const cwd = yield* hostProcess.currentWorkingDirectory;
  const workspaceRoot = yield* routeKitEvalDirectory.workspaceRootFrom(cwd);
  // Inside a workspace the cache lives in the workspace's own `.routekit-eval/` (the
  // node_modules-shaped spot, already gitignored). Outside one it falls back
  // to `~/.routekit-eval` so `routekit-eval features list --features=github.com/...` works anywhere.
  const base = Option.isSome(workspaceRoot)
    ? path.join(workspaceRoot.value, ROUTEKIT_EVAL_DIRECTORY_NAME)
    : path.join(yield* hostProcess.homeDirectory, ROUTEKIT_EVAL_DIRECTORY_NAME);
  return path.join(
    base,
    REMOTE_FEATURES_CACHE_DIR,
    source.host,
    source.owner,
    source.repo,
    refDirectoryName(source.ref)
  );
});

const downloadFailure = (
  source: RemoteFeatureSource,
  detail: string
): CliFailureError =>
  new CliFailureError({
    detail: `Could not download features from ${formatRemoteFeatureSource(source)}: ${detail}. Ensure the repository is public and the ref exists.`,
  });

const downloadArchive = Effect.fn("RemoteFeatures.downloadArchive")(
  function* (input: {
    readonly archivePath: string;
    readonly archiveRef: string;
    readonly source: RemoteFeatureSource;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const client = yield* HttpClient.HttpClient;
    const { owner, repo } = input.source;
    // Private repos: codeload accepts the token the user already carries for
    // `gh`/CI, or — when only the `intern-worker` App creds are present — a
    // freshly minted repo-scoped installation token. Absent both, the request
    // goes out unauthenticated and public repos work as before.
    const token = yield* resolveGithubAuthToken({
      owner,
      repo,
    });
    const archiveUrl = `https://codeload.github.com/${owner}/${repo}/tar.gz/${encodeGithubRef(input.archiveRef)}`;
    const request = Option.match(token, {
      onNone: () => client.get(archiveUrl),
      onSome: (value) =>
        client.get(archiveUrl, {
          headers: { authorization: `token ${value}` },
        }),
    });
    const response = yield* request.pipe(
      Effect.mapError((cause) =>
        downloadFailure(input.source, formatUnknownError(cause))
      )
    );
    if (!isOkStatus(response.status)) {
      return yield* downloadFailure(
        input.source,
        `GitHub returned ${response.status}`
      );
    }
    const bytes = yield* response.arrayBuffer.pipe(
      Effect.map((buffer) => new Uint8Array(buffer)),
      Effect.mapError((cause) =>
        downloadFailure(input.source, formatUnknownError(cause))
      )
    );
    yield* fs.writeFile(input.archivePath, bytes);
  }
);

const extractArchive = Effect.fn("RemoteFeatures.extractArchive")(
  function* (input: {
    readonly archivePath: string;
    readonly extractDir: string;
  }) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const exitCode = yield* spawner.exitCode(
      ChildProcess.make(
        "tar",
        [
          "--extract",
          "--gzip",
          "--strip-components=1",
          "--file",
          input.archivePath,
          "--directory",
          input.extractDir,
        ],
        {
          stderr: "inherit",
          stdout: "ignore",
        }
      )
    );
    if (Number(exitCode) !== PROCESS_SUCCESS_EXIT_CODE) {
      return yield* new CliFailureError({
        detail: `Could not extract the remote features archive (tar exit code ${exitCode}). Ensure tar is installed and the download was not corrupted.`,
      });
    }
  }
);

// Fetch and extract into a temp dir, then swap it into the cache path so a
// failed download never clobbers a good cached copy.
const refreshCache = Effect.fn("RemoteFeatures.refreshCache")(function* (
  source: RemoteFeatureSource,
  cacheDir: string,
  resolvedSha: Option.Option<string>
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* Effect.scoped(
    Effect.gen(function* () {
      // Stage next to the destination: the final rename must not cross a
      // filesystem boundary (the system temp dir often lives on tmpfs).
      const cacheParent = path.dirname(cacheDir);
      yield* fs.makeDirectory(cacheParent, { recursive: true });
      const workDir = yield* fs.makeTempDirectoryScoped({
        directory: cacheParent,
        prefix: ARCHIVE_TEMP_PREFIX,
      });
      const archivePath = path.join(workDir, ARCHIVE_FILE_NAME);
      const extractDir = path.join(workDir, "repo");
      yield* fs.makeDirectory(extractDir, { recursive: true });
      yield* downloadArchive({
        archivePath,
        archiveRef: Option.getOrElse(resolvedSha, () => source.ref),
        source,
      }).pipe(
        Effect.andThen(
          extractArchive({
            archivePath,
            extractDir,
          })
        ),
        // HTTPS is primary; retry the same ref over `git clone` via SSH when
        // it fails. If the SSH retry also fails, re-raise the HTTPS error: it
        // names the transport the caller actually configured (a token, App
        // creds, or neither), not the backup.
        Effect.catch((httpsError) =>
          retryFetchOverSsh({
            extractDir,
            source: Option.isSome(resolvedSha)
              ? {
                  ...source,
                  ref: resolvedSha.value,
                }
              : source,
          }).pipe(Effect.mapError(() => httpsError))
        )
      );
      const nodeModules = path.join(cacheDir, NODE_MODULES_DIRECTORY);
      const hasNodeModules = yield* fs
        .exists(nodeModules)
        .pipe(Effect.orElseSucceed(() => false));
      if (hasNodeModules) {
        yield* fs.rename(
          nodeModules,
          path.join(extractDir, NODE_MODULES_DIRECTORY)
        );
      }
      yield* fs.makeDirectory(path.dirname(cacheDir), { recursive: true });
      yield* fs.remove(cacheDir, {
        force: true,
        recursive: true,
      });
      yield* fs.rename(extractDir, cacheDir);
    })
  );
});

const refreshRemoteFeatures = Effect.fn("RemoteFeatures.refreshMaterialized")(
  function* (input: {
    readonly source: RemoteFeatureSource;
    readonly cacheDir: string;
    readonly cached: boolean;
    readonly cacheHit: boolean;
    readonly resolvedSha: Option.Option<string>;
  }) {
    const cliIo = yield* CliIo;
    const refresh = input.cacheHit
      ? Effect.succeed(false)
      : refreshCache(input.source, input.cacheDir, input.resolvedSha).pipe(
          Effect.as(true)
        );
    // Only swallow a failed refresh when a cached copy can stand in for it.
    return input.cached
      ? yield* refresh.pipe(
          Effect.catch((error) =>
            cliIo
              .writeStderr(
                `${formatWarning(`Could not refresh ${formatRemoteFeatureSource(input.source)} (${formatUnknownError(error)}); using the cached copy.`)}\n`
              )
              .pipe(Effect.ignore, Effect.as(false))
          )
        )
      : yield* refresh;
  }
);

/**
 * Materialize a remote source into the `.routekit-eval/remote-features` cache and return
 * the local directory that stands in as the features root. Branch refs are
 * probed cheaply before refresh; when the network is down but a previous copy
 * exists, that copy is used with a warning instead of failing.
 */
const materializeRemoteFeaturesRoot = Effect.fn("RemoteFeatures.materialize")(
  function* (source: RemoteFeatureSource) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cliIo = yield* CliIo;
    const cacheDir = yield* cacheDirFor(source);
    const metadataPath = cacheMetadataPath(cacheDir, path);
    const cached = yield* fs
      .exists(cacheDir)
      .pipe(Effect.orElseSucceed(() => false));
    const metadata = yield* readCacheMetadata(metadataPath);
    const probedSha = isImmutableRef(source.ref)
      ? Option.some(source.ref)
      : yield* resolveRemoteFeatureSha(source).pipe(
          Effect.map(Option.some),
          Effect.catch(() => Effect.succeed(Option.none<string>()))
        );
    const cacheHit =
      cached &&
      Option.isSome(metadata) &&
      Option.isSome(probedSha) &&
      metadata.value.sha === probedSha.value;
    // Progress and warnings are advisory; a broken stderr must not fail resolution.
    yield* cliIo
      .writeStderr(
        `${cacheHit ? "Using cached" : "Fetching"} features from ${formatRemoteFeatureSource(source)}${cacheHit ? "" : "..."}\n`
      )
      .pipe(Effect.ignore);
    const refreshed = yield* refreshRemoteFeatures({
      source,
      cacheDir,
      cached,
      cacheHit,
      resolvedSha: probedSha,
    });
    const metadataForDeps = metadataForDependencyInstall(
      metadata,
      refreshed,
      probedSha
    );
    const manifestFingerprint = yield* installRemoteFeatureDeps({
      source,
      cacheDir,
      metadata: metadataForDeps,
    });
    const metadataOutcome = metadataOutcomeFor({
      cacheHit,
      refreshed,
      probedSha,
      manifestFingerprint,
    });
    yield* persistMaterializedMetadata({
      metadataPath,
      outcome: metadataOutcome,
    });
    const root = path.join(cacheDir, ...source.path);
    const exists = yield* fs
      .exists(root)
      .pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return yield* new CliFailureError({
        detail: `Remote features source ${formatRemoteFeatureSource(source)} has no directory "${source.path.join("/")}"${refreshed ? "" : " in the cached copy"}.`,
      });
    }
    return root;
  }
);

/**
 * Resolve a raw `--features` value to a local directory: remote repo paths are
 * materialized through the cache, everything else passes through unchanged.
 */
const resolveFeaturesRootInput = Effect.fn("RemoteFeatures.resolveInput")(
  function* (value: string) {
    if (!isRemoteFeaturesInput(value)) {
      return value;
    }
    const source = yield* parseRemoteFeatureSourceEffect(value);
    if (source === undefined) {
      return value;
    }
    // Cache filesystem failures surface as CLI failures so callers keep the
    // same error surface they had for local roots.
    return yield* materializeRemoteFeaturesRoot(source).pipe(
      Effect.mapError((error) =>
        Schema.is(CliFailureError)(error)
          ? error
          : new CliFailureError({ detail: formatUnknownError(error) })
      )
    );
  }
);

export {
  formatRemoteFeatureSource,
  isRemoteFeaturesInput,
  materializeRemoteFeaturesRoot,
  parseRemoteFeatureSource,
  parseRemoteFeatureSourceEffect,
  resolveFeaturesRootInput,
};
