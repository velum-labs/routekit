import type { CliVersion } from "./cli-version.ts";

import { DEFAULT_NAME } from "./cli-version.ts";

declare const ORI_CLI_COMPILED: boolean | undefined;
declare const ORI_CLI_PACKAGE_NAME: string | undefined;
declare const ORI_CLI_VERSION: string | undefined;

export const readBuildTimeCliVersion = (): string | undefined => {
  if (typeof ORI_CLI_VERSION !== "string") {
    return;
  }

  const version = ORI_CLI_VERSION.trim();
  return version.length === 0 ? undefined : version;
};

export const readBuildTimeVersionInfo = (): CliVersion | undefined => {
  const version = readBuildTimeCliVersion();
  if (version === undefined) {
    return;
  }

  const name =
    typeof ORI_CLI_PACKAGE_NAME === "string" && ORI_CLI_PACKAGE_NAME.length > 0
      ? ORI_CLI_PACKAGE_NAME
      : DEFAULT_NAME;
  return {
    name,
    version,
  };
};

export const isCompiledCliBuild = (): boolean =>
  typeof ORI_CLI_COMPILED === "boolean" && ORI_CLI_COMPILED;
