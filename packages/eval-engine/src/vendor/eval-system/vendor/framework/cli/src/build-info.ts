import type { CliVersion } from "./cli-version.ts";

import { DEFAULT_NAME } from "./cli-version.ts";

declare const ROUTEKIT_EVAL_CLI_COMPILED: boolean | undefined;
declare const ROUTEKIT_EVAL_CLI_PACKAGE_NAME: string | undefined;
declare const ROUTEKIT_EVAL_CLI_VERSION: string | undefined;

export const readBuildTimeCliVersion = (): string | undefined => {
  if (typeof ROUTEKIT_EVAL_CLI_VERSION !== "string") {
    return;
  }

  const version = ROUTEKIT_EVAL_CLI_VERSION.trim();
  return version.length === 0 ? undefined : version;
};

export const readBuildTimeVersionInfo = (): CliVersion | undefined => {
  const version = readBuildTimeCliVersion();
  if (version === undefined) {
    return;
  }

  const name =
    typeof ROUTEKIT_EVAL_CLI_PACKAGE_NAME === "string" && ROUTEKIT_EVAL_CLI_PACKAGE_NAME.length > 0
      ? ROUTEKIT_EVAL_CLI_PACKAGE_NAME
      : DEFAULT_NAME;
  return {
    name,
    version,
  };
};

export const isCompiledCliBuild = (): boolean =>
  typeof ROUTEKIT_EVAL_CLI_COMPILED === "boolean" && ROUTEKIT_EVAL_CLI_COMPILED;
