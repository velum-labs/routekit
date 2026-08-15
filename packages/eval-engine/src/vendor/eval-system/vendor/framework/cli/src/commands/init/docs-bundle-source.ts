import { Effect, FileSystem, Option, Path, Schedule, Schema } from "effect";
import { HttpClient } from "effect/unstable/http";

import { HostProcess } from "../../../../contracts/internal/src/cli/host-process.ts";
import { ProjectInitError } from "./author-contracts.ts";
import { ROUTEKIT_EVAL_UPDATE_BASE_URL } from "../update/release-channel.ts";
import { readVersionInfo } from "../version/version-info.ts";
import { RouteKitEvalDirectory } from "../../routekit-eval-directory.ts";
import { formatUnknownError } from "../../../../utils/core/src/error-formatting.ts";

import {
  readOptionalEnv,
  TEMPLATE_RESOLVE_EXIT_CODE,
} from "./template-archive.ts";

/** Release asset published per release. No source produces one today. */
const DOCS_BUNDLE_ASSET = "docs-bundle.json";
/** Public mirror that hosts the CLI release assets (RFC 0010). */
const ROUTEKIT_EVAL_RELEASES_REPO = "GatewayLabs/routekit-eval-releases";
/**
 * Point at a local `docs-bundle.json` instead of downloading one. This is the
 * escape hatch for a network-restricted host and the init contract tests.
 */
const DOCS_BUNDLE_ENV = "ROUTEKIT_EVAL_DOCS_BUNDLE";
/**
 * Latest stable asset, resolved through the `routekit.dev/eval/*` proxy →
 * `releases/latest/download/*`. Prereleases are excluded from `latest`, so an
 * alpha build reaches its own bundle through {@link pinnedBundleUrl} instead.
 */
const DOCS_BUNDLE_LATEST_URL = `${ROUTEKIT_EVAL_UPDATE_BASE_URL}/${DOCS_BUNDLE_ASSET}`;
/**
 * A release version carries build metadata (`<base>+<sha>`, or
 * `<base>-alpha+<sha>` on the alpha channel); a development run reports the bare
 * manifest version. Only the former has a published release to download from.
 */
const RELEASE_VERSION_MARKER = "+";

const DocsBundleSchema = Schema.Struct({
  files: Schema.Record(Schema.String, Schema.String),
  llms: Schema.String,
});
const decodeDocsBundleJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(DocsBundleSchema)
);

type DocsBundle = typeof DocsBundleSchema.Type;

const docsBundleError = (detail: string, cause?: unknown): ProjectInitError =>
  new ProjectInitError({
    cause,
    detail,
    exitCode: TEMPLATE_RESOLVE_EXIT_CODE,
    operation: "reading the docs bundle",
  });

/**
 * The immutable per-release asset URL. Release tags are `cli-<version>` with
 * `+` replaced by `-` (SemVer build metadata is not a legal git ref), matching
 * the tag `.github/workflows/release-cli.yml` publishes.
 */
const pinnedBundleUrl = (version: string): string =>
  `https://github.com/${ROUTEKIT_EVAL_RELEASES_REPO}/releases/download/cli-${version.replaceAll(RELEASE_VERSION_MARKER, "-")}/${DOCS_BUNDLE_ASSET}`;

/**
 * Candidate URLs in priority order: the bundle published alongside this exact
 * binary first, so the mirrored docs match the installed CLI rather than
 * whatever is newest.
 */
const bundleUrls = (version: string): readonly string[] =>
  version.includes(RELEASE_VERSION_MARKER)
    ? [pinnedBundleUrl(version), DOCS_BUNDLE_LATEST_URL]
    : [DOCS_BUNDLE_LATEST_URL];

const fetchDocsBundleText = Effect.fn("DocsBundleSource.fetch")(function* (
  version: string
) {
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.filterStatusOk,
    HttpClient.retryTransient({
      schedule: Schedule.exponential("200 millis", 2),
      times: 3,
    })
  );
  return yield* Effect.firstSuccessOf(
    bundleUrls(version).map((url) =>
      client.get(url).pipe(Effect.flatMap((response) => response.text))
    )
  );
});

const cachePathFor = Effect.fn("DocsBundleSource.cachePath")(function* (
  version: string
) {
  const hostProcess = yield* HostProcess;
  const routeKitEvalDirectory = yield* RouteKitEvalDirectory;
  const homeDir = yield* hostProcess.homeDirectory;
  return routeKitEvalDirectory.docsBundleCachePath(homeDir, version);
});

const readBundleFile = Effect.fn("DocsBundleSource.readFile")(function* (
  filePath: string
) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs
    .readFileString(filePath)
    .pipe(Effect.flatMap(decodeDocsBundleJson), Effect.option);
});

const writeCachedBundle = Effect.fn("DocsBundleSource.writeCache")(function* (
  cachePath: string,
  serialized: string
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(cachePath), { recursive: true });
  yield* fs.writeFileString(cachePath, serialized);
});

/**
 * Resolve the docs bundle for the running CLI version.
 *
 * The bundle is a release artifact rather than a file compiled into the binary,
 * so it is downloaded once per version and cached under
 * `~/.routekit-eval/cache/docs/<version>/docs-bundle.json`; later runs (including offline
 * ones) read the cache. `ROUTEKIT_EVAL_DOCS_BUNDLE` short-circuits both steps with a local
 * file. Callers treat a failure as "no docs mirror this run".
 */
export const loadDocsBundle: Effect.Effect<
  DocsBundle,
  ProjectInitError,
  | FileSystem.FileSystem
  | HostProcess
  | HttpClient.HttpClient
  | RouteKitEvalDirectory
  | Path.Path
> = Effect.gen(function* () {
  const overridePath = yield* readOptionalEnv(DOCS_BUNDLE_ENV);
  if (overridePath !== undefined) {
    const override = yield* readBundleFile(overridePath);
    return yield* Option.match(override, {
      onNone: () =>
        Effect.fail(
          docsBundleError(
            `${DOCS_BUNDLE_ENV} is set to ${overridePath}, which is missing or is not a docs bundle`
          )
        ),
      onSome: Effect.succeed,
    });
  }

  const { version } = yield* readVersionInfo;
  const cachePath = yield* cachePathFor(version);
  const cached = yield* readBundleFile(cachePath);
  if (Option.isSome(cached)) {
    return cached.value;
  }

  const serialized = yield* fetchDocsBundleText(version);
  const bundle = yield* decodeDocsBundleJson(serialized);
  // A cache write failure (read-only home, full disk) must not discard docs we
  // already hold; the next run just downloads again.
  yield* writeCachedBundle(cachePath, serialized).pipe(Effect.ignore);
  return bundle;
}).pipe(
  Effect.mapError((cause) =>
    Schema.is(ProjectInitError)(cause)
      ? cause
      : docsBundleError(
          `Could not resolve ${DOCS_BUNDLE_ASSET} for this CLI version: ${formatUnknownError(cause)}`,
          cause
        )
  )
);

export {
  DOCS_BUNDLE_ASSET,
  DOCS_BUNDLE_ENV,
  DOCS_BUNDLE_LATEST_URL,
  bundleUrls,
};
export type { DocsBundle };
