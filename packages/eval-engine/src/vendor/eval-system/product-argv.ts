const ROOT_OUTPUT_FLAGS = new Set(["--json", "--agent", "--human", "--tty"]);

export interface ProductArgv {
  readonly command: string | undefined;
  readonly commandArgs: readonly string[];
  readonly outputFlags: readonly string[];
}

/**
 * Split leading RouteKitEval output-mode flags from the product command.
 *
 * Spawn is a first-class command with its own JSON protocol, so it must be
 * reachable as `routekit-eval-engine --json spawn …` the same way `eval` is.
 */
export const parseProductArgv = (
  argv: readonly string[] = process.argv.slice(2),
): ProductArgv => {
  const outputFlags: string[] = [];
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];
    if (arg === undefined || !ROOT_OUTPUT_FLAGS.has(arg)) break;
    outputFlags.push(arg);
    index += 1;
  }
  const commandArgs = argv.slice(index);
  return {
    command: commandArgs[0],
    commandArgs,
    outputFlags,
  };
};
