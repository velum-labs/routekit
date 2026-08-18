import { Effect, FileSystem, Path } from "effect";

import type { CliVersion } from "../../cli-version.ts";
import type { UpdateCheckStatus } from "../update/update-notice.ts";

import { CliFailureError } from "../../../../contracts/internal/src/errors.ts";
import { decodeJsonString } from "../../../../contracts/internal/src/json.ts";
import { readBuildTimeVersionInfo } from "../../build-info.ts";
import { CliVersionSchema } from "../../cli-version.ts";
import { isTruthyEnvValue } from "../update/env-values.ts";
import { formatUnknownError } from "../../../../utils/core/src/error-formatting.ts";

/**
 * Source of truth for the reported CLI version.
 *
 * Release binaries receive the exact immutable release version through Bun's
 * build-time define. Development runs keep reading this package's `package.json`
 * so a locally linked `ori --version` still tracks the workspace manifest.
 */
const PACKAGE_JSON = "package.json";

/** Directory of this module, used to resolve the CLI `package.json` regardless of CWD. */
const MODULE_DIR = import.meta.dirname;

/** `framework/cli/package.json` lives three directories above `src/commands/version/`. */
const PACKAGE_JSON_SEGMENTS = ["..", "..", "..", PACKAGE_JSON] as const;

const readBundledVersionInfo = (): CliVersion | undefined =>
  readBuildTimeVersionInfo();

/**
 * Resolve the CLI version from `framework/cli/package.json`.
 *
 * Reading goes through the Effect `FileSystem` service so the behavior is
 * testable and consistent with the rest of the CLI's filesystem access.
 */
export const readVersionInfo: Effect.Effect<
  CliVersion,
  CliFailureError,
  FileSystem.FileSystem | Path.Path
> = Effect.gen(function* () {
  const bundled = readBundledVersionInfo();
  if (bundled !== undefined) {
    return bundled;
  }

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const packagePath = path.join(MODULE_DIR, ...PACKAGE_JSON_SEGMENTS);

  const decoded = yield* fs.readFileString(packagePath).pipe(
    Effect.flatMap(decodeJsonString(CliVersionSchema)),
    Effect.mapError(
      (cause) =>
        new CliFailureError({
          detail: `Failed to read CLI version from package.json: ${formatUnknownError(cause)}`,
          cause,
        })
    )
  );

  return decoded;
});

/** Human-readable single-line rendering: `ori 0.0.0`. */
export const formatVersionText = (info: CliVersion): string =>
  `${info.name} ${info.version}`;

export const formatVersionUpdateText = (
  status: UpdateCheckStatus | null
): string => {
  if (status === null) {
    return "";
  }
  if (status.severity === "none") {
    return `Already on the latest version: ${status.latestVersion}\n`;
  }
  const updateCommand =
    status.channel === "alpha" ? "ori update --alpha" : "ori update";
  return `Update available: ${status.latestVersion} — run \`${updateCommand}\`\n`;
};

export const shouldCheckVersionUpdate = (
  env: Readonly<Record<string, string | undefined>>
): boolean => !isTruthyEnvValue(env.CI);

/** Machine-readable rendering: `{"name":"@ori-runtime/cli","version":"0.0.0"}`. */
export const formatVersionJson = (info: CliVersion): string =>
  globalThis.JSON.stringify(info);

export type { CliVersion };
