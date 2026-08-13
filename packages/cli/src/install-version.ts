import { CliError } from "@velum-labs/routekit-cli-core";
import { fetchViaHttpClient } from "@velum-labs/routekit-runtime/effect";

export const ROUTEKIT_PACKAGE_NAME = "@velum-labs/routekit";
export const ROUTEKIT_LATEST_URL = "https://registry.npmjs.org/@velum-labs%2Froutekit/latest";

const NUMERIC_IDENTIFIER = "(?:0|[1-9]\\d*)";
const PRERELEASE_IDENTIFIER = "(?:0|[1-9]\\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)";
const EXACT_VERSION_PATTERN = new RegExp(
  `^${NUMERIC_IDENTIFIER}\\.${NUMERIC_IDENTIFIER}\\.${NUMERIC_IDENTIFIER}` +
    `(?:-${PRERELEASE_IDENTIFIER}(?:\\.${PRERELEASE_IDENTIFIER})*)?$`
);

export type RegistryFetch = typeof fetch;

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

export async function fetchLatestRouteKitVersion(
  options: { fetcher?: RegistryFetch; timeoutMs?: number } = {}
): Promise<string> {
  const fetcher = options.fetcher ?? fetchViaHttpClient;
  let response: Response;
  try {
    response = await fetcher(ROUTEKIT_LATEST_URL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(options.timeoutMs ?? 5_000)
    });
  } catch {
    throw resolutionError("the npm registry request failed or timed out");
  }
  if (!response.ok) {
    throw resolutionError(`the npm registry returned HTTP ${response.status}`);
  }

  let payload: { version?: unknown };
  try {
    payload = (await response.json()) as { version?: unknown };
  } catch {
    throw resolutionError("the npm registry returned invalid JSON metadata");
  }
  if (typeof payload.version !== "string" || !isExactInstallVersion(payload.version)) {
    throw resolutionError("the npm registry metadata did not contain an exact RouteKit version");
  }
  return payload.version;
}

export async function resolveInstallVersion(
  requestedVersion: string,
  options: { fetcher?: RegistryFetch; timeoutMs?: number } = {}
): Promise<string> {
  if (isExactInstallVersion(requestedVersion)) return requestedVersion;
  if (requestedVersion === "latest") return await fetchLatestRouteKitVersion(options);
  throw new CliError({
    message: `invalid RouteKit version: ${JSON.stringify(requestedVersion)}`,
    hint: "pass an exact version such as 0.10.1, or `latest`"
  });
}
