// The label telemetry and the JSON error envelope report for an invocation.
// Both are derived from the recognized subcommand chain rather than raw argv
// tokens, so positional argument values — including an unknown `routekit-eval code`
// argument — never reach either sink (RFC 0004).

import type {
  CommandNameNode,
  CommandTreeInput,
} from "./command-path.ts";

import {
  buildCommandNameTree,
  resolveCommandPath,
} from "./command-path.ts";
import { splitAgentLaunchArgv } from "./commands/agent-launch.ts";
import { applyDefaultCommand } from "./default-command.ts";
import { stripLeadingOutputGlobalFlags } from "./routekit-eval-report.ts";

/** Label for an invocation with no recognized subcommand. */
export const ROOT_COMMAND_LABEL = "routekit-eval";

export const describeCommandLabel = (
  args: readonly string[],
  tree: ReadonlyMap<string, CommandNameNode>
): string => {
  const path = resolveCommandPath(stripLeadingOutputGlobalFlags(args), tree);
  return path.length > 0 ? path.join(" ") : ROOT_COMMAND_LABEL;
};

/**
 * The label for a failure reported at the outer `runMain` edge, where no
 * command was ever resolved. Mirrors the run path — drop the passthrough tail,
 * apply the default command, then keep only recognized subcommand tokens — so
 * a bare `routekit-eval "fix the auth bug"` reports `code`, not the prompt.
 */
export const resolveFailureCommandLabel = (
  argv: readonly string[],
  subcommands: readonly CommandTreeInput[]
): string => {
  const { cliArgv } = splitAgentLaunchArgv(argv);
  const tree = buildCommandNameTree(subcommands);
  const routedArgs = applyDefaultCommand(cliArgv, new Set(tree.keys()));
  return describeCommandLabel(routedArgs, tree);
};
