import { Result } from "effect";

import { CliOutputAlreadyReported } from "../../../contracts/internal/src/cli/cli-output.ts";
import { stripLeadingOutputGlobalFlags } from "../routekit-eval-report.ts";
import { telemetryCommandPath as resolveCommandPath } from "./command-path.ts";

type CommandNode = Parameters<typeof resolveCommandPath>[0];

export const telemetryCommandPath = (
  command: CommandNode,
  args: readonly string[],
  result: Result.Result<unknown, unknown>
): string => {
  const resolvedPath = resolveCommandPath(
    command,
    stripLeadingOutputGlobalFlags(args)
  );
  if (
    Result.isFailure(result) &&
    result.failure instanceof CliOutputAlreadyReported &&
    result.failure.command !== undefined
  ) {
    const label = result.failure.command;
    if (resolvedPath !== "unknown" && resolvedPath !== "root") {
      return resolvedPath;
    }
    if (label === "routekit-eval") {
      return "root";
    }
    const labelPath = resolveCommandPath(command, label.split(" "));
    return labelPath === "unknown" ? resolvedPath : labelPath;
  }
  return resolvedPath;
};
