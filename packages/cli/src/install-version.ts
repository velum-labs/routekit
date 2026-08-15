import { CliError } from "@velum-labs/routekit-cli-core";
import { executeWebRequest } from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";
import { HttpClient } from "effect/unstable/http";

export const ROUTEKIT_PACKAGE_NAME = "@velum-labs/routekit";
export const ROUTEKIT_LATEST_URL = "https://registry.npmjs.org/@velum-labs%2Froutekit/latest";

const NUMERIC_IDENTIFIER = "(?:0|[1-9]\\d*)";
const PRERELEASE_IDENTIFIER = "(?:0|[1-9]\\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)";
const EXACT_VERSION_PATTERN = new RegExp(
  `^${NUMERIC_IDENTIFIER}\\.${NUMERIC_IDENTIFIER}\\.${NUMERIC_IDENTIFIER}` +
    `(?:-${PRERELEASE_IDENTIFIER}(?:\\.${PRERELEASE_IDENTIFIER})*)?$`
);

export type InstallVersionResolver = (requestedVersion: string) => Promise<string>;

export function isExactInstallVersion(version: string): boolean {
  return EXACT_VERSION_PATTERN.test(version);
}

function resolutionError(detail: string): CliError {
  return new CliError({
    message: `could not resolve ${ROUTEKIT_PACKAGE_NAME}@latest`,
    details: [detail],
    hint: "retry the command, or pass --version <exact-version>"
  });
}

export function fetchLatestRouteKitVersion(
  options: { timeoutMs?: number } = {}
): Effect.Effect<string, CliError, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    const response = yield* executeWebRequest(ROUTEKIT_LATEST_URL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(options.timeoutMs ?? 5_000)
    }).pipe(
      Effect.catchCause(() =>
        Effect.fail(resolutionError("the npm registry request failed or timed out"))
      )
    );
    if (!response.ok) {
      return yield* Effect.fail(
        resolutionError(`the npm registry returned HTTP ${response.status}`)
      );
    }
    const payload = yield* Effect.tryPromise({
      try: () => response.json() as Promise<{ version?: unknown }>,
      catch: () => resolutionError("the npm registry returned invalid JSON metadata")
    });
    if (typeof payload.version !== "string" || !isExactInstallVersion(payload.version)) {
      return yield* Effect.fail(
        resolutionError("the npm registry metadata did not contain an exact RouteKit version")
      );
    }
    return payload.version;
  });
}

export function resolveInstallVersion(
  requestedVersion: string,
  options: { timeoutMs?: number } = {}
): Effect.Effect<string, CliError, HttpClient.HttpClient> {
  if (isExactInstallVersion(requestedVersion)) return Effect.succeed(requestedVersion);
  if (requestedVersion === "latest") return fetchLatestRouteKitVersion(options);
  return Effect.fail(
    new CliError({
      message: `invalid RouteKit version: ${JSON.stringify(requestedVersion)}`,
      hint: "pass an exact version such as 0.10.1, or `latest`"
    })
  );
}
