import type { PlatformError } from "effect";

import { Config, Effect, FileSystem, Option, Path, Schedule } from "effect";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { writeProgressNotice } from "../dev/progress-notice.ts";
import { ProjectInitError } from "./author-contracts.ts";
import { formatUnknownError } from "../../../../utils/core/src/error-formatting.ts";

/** Override the templates source repository (a public `owner/repo` slug). */
const TEMPLATES_REPO_ENV = "ROUTEKIT_EVAL_TEMPLATES_REPO";
/** Override the branch, tag, or commit fetched from the templates repository. */
const TEMPLATES_REF_ENV = "ROUTEKIT_EVAL_TEMPLATES_REF";

// The templates live in a public GitHub repository, so they are pulled as a
// downloaded archive over HTTPS — no `git` executable and no credentials. The
// download uses the built-in `fetch`; only extraction shells out, to the
// ubiquitous `tar`. The default ref is pinned to a specific commit rather than
// a moving branch, so a plain `routekit-eval init` scaffolds the same content until the
// pin is bumped; `ROUTEKIT_EVAL_TEMPLATES_REF` overrides it for callers who want `main`
// or another ref.
const DEFAULT_TEMPLATES_REPO = "GatewayIncubator/templates";
const DEFAULT_TEMPLATES_REF = "883549a326aa93a5da3acfa4b3a2b379ed563fb1";

// An `owner/repo` slug of GitHub-legal name characters, validated before it is
// interpolated into the archive URL.
const REPO_SLUG_PATTERN = /^[\w.-]+\/[\w.-]+$/u;
const ARCHIVE_TEMP_PREFIX = "routekit-eval-template-";
const ARCHIVE_FILE_NAME = "templates.tar.gz";
const PROCESS_SUCCESS_EXIT_CODE = 0;

export const TEMPLATE_RESOLVE_EXIT_CODE = 1;

// Read an optional environment variable through the Effect config provider
// (the repo bans direct `process.env`), treating blank values as unset.
export const readOptionalEnv = (
  name: string
): Effect.Effect<string | undefined, Config.ConfigError> =>
  Config.string(name).pipe(
    Config.option,
    Effect.map((value) =>
      Option.isSome(value) && value.value.trim() !== ""
        ? value.value
        : undefined
    )
  );

const HTTP_OK_MIN = 200;
const HTTP_OK_MAX = 300;

// Standard reason phrases for the HTTP statuses GitHub's codeload returns for a
// bad repo/ref. `HttpClientResponse` does not surface the raw `statusText`, so
// the phrase is reconstructed here to keep the download-failure message stable.
const STATUS_REASON: Readonly<Record<number, string>> = {
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  429: "Too Many Requests",
  500: "Internal Server Error",
};

const describeStatus = (status: number): string => {
  const reason = STATUS_REASON[status];
  return reason === undefined ? `${status}` : `${status} ${reason}`;
};

const makeDownloadError = (input: {
  readonly ref: string;
  readonly repo: string;
  readonly detail: string;
}): ProjectInitError =>
  new ProjectInitError({
    detail: `Could not download templates from ${input.repo}@${input.ref}: ${input.detail}. Ensure the repository is public and the ref exists.`,
    exitCode: TEMPLATE_RESOLVE_EXIT_CODE,
    operation: "fetching templates",
  });

const downloadArchive = Effect.fn("ProjectInit.downloadArchive")(
  function* (input: {
    readonly archivePath: string;
    readonly archiveUrl: string;
    readonly ref: string;
    readonly repo: string;
  }) {
    const fs = yield* FileSystem.FileSystem;
    // Retry only transient download failures (transport/timeout errors and
    // 408/429/5xx responses) with exponential backoff; terminal statuses like
    // 404 or a malformed slug are not transient, so they short-circuit to the
    // manual status check below and its stable error message.
    const client = (yield* HttpClient.HttpClient).pipe(
      HttpClient.retryTransient({
        schedule: Schedule.exponential("200 millis", 2),
        times: 3,
      })
    );
    // Match the prior `fetch` rejection path: a transport failure carries the
    // underlying message.
    const response = yield* client.get(input.archiveUrl).pipe(
      Effect.mapError((cause) =>
        makeDownloadError({
          detail: formatUnknownError(cause),
          ref: input.ref,
          repo: input.repo,
        })
      )
    );

    if (response.status < HTTP_OK_MIN || response.status >= HTTP_OK_MAX) {
      return yield* makeDownloadError({
        detail: `GitHub returned ${describeStatus(response.status)}`,
        ref: input.ref,
        repo: input.repo,
      });
    }

    const bytes = yield* response.arrayBuffer.pipe(
      Effect.map((buffer) => new Uint8Array(buffer)),
      Effect.mapError((cause) =>
        makeDownloadError({
          detail: formatUnknownError(cause),
          ref: input.ref,
          repo: input.repo,
        })
      )
    );
    yield* fs.writeFile(input.archivePath, bytes);
  }
);

// stderr is inherited so the tool's own diagnostics reach the user.
const runProcess = Effect.fn("ProjectInit.runProcess")(function* (input: {
  readonly args: readonly string[];
  readonly command: string;
  readonly failure: string;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const exitCode = yield* spawner.exitCode(
    ChildProcess.make(input.command, input.args, {
      stderr: "inherit",
      stdout: "ignore",
    })
  );
  if (Number(exitCode) !== PROCESS_SUCCESS_EXIT_CODE) {
    return yield* new ProjectInitError({
      detail: `${input.failure} (${input.command} exit code ${exitCode})`,
      exitCode: Number(exitCode),
      operation: "fetching templates",
    });
  }
});

const extractArchive = (input: {
  readonly archivePath: string;
  readonly extractDir: string;
}): Effect.Effect<
  undefined,
  PlatformError.PlatformError | ProjectInitError,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  runProcess({
    args: [
      "--extract",
      "--gzip",
      "--strip-components=1",
      "--file",
      input.archivePath,
      "--directory",
      input.extractDir,
    ],
    command: "tar",
    failure:
      "Could not extract the templates archive. Ensure tar is installed and the download was not corrupted.",
  });

export const downloadTemplatesArchive = Effect.fn(
  "ProjectInit.downloadTemplatesArchive"
)(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repo =
    (yield* readOptionalEnv(TEMPLATES_REPO_ENV)) ?? DEFAULT_TEMPLATES_REPO;
  const ref =
    (yield* readOptionalEnv(TEMPLATES_REF_ENV)) ?? DEFAULT_TEMPLATES_REF;

  if (!REPO_SLUG_PATTERN.test(repo)) {
    return yield* new ProjectInitError({
      detail: `Invalid templates repository "${repo}". Use a public "owner/repo" slug, e.g. "GatewayIncubator/templates".`,
      exitCode: TEMPLATE_RESOLVE_EXIT_CODE,
      operation: "fetching templates",
    });
  }

  // GitHub serves a public repo's tree as a gzipped tarball over plain HTTPS,
  // with everything under a single "<repo>-<ref>/" directory that
  // `--strip-components=1` removes during extraction.
  const archiveUrl = `https://codeload.github.com/${repo}/tar.gz/${ref}`;
  const workDir = yield* fs.makeTempDirectoryScoped({
    prefix: ARCHIVE_TEMP_PREFIX,
  });
  const archivePath = path.join(workDir, ARCHIVE_FILE_NAME);
  const extractDir = path.join(workDir, "repo");
  yield* fs.makeDirectory(extractDir, { recursive: true });

  yield* writeProgressNotice(`\nFetching templates from ${repo}@${ref}...\n`);
  yield* downloadArchive({
    archivePath,
    archiveUrl,
    ref,
    repo,
  });
  yield* extractArchive({
    archivePath,
    extractDir,
  });
  return extractDir;
});
