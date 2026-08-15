interface CommandNode {
  readonly alias: string | undefined;
  readonly name: string;
  readonly subcommands: readonly {
    readonly commands: readonly CommandNode[];
  }[];
}

const findSubcommand = (
  command: CommandNode,
  name: string
): CommandNode | undefined => {
  for (const group of command.subcommands) {
    const subcommand = group.commands.find(
      (candidate) => candidate.name === name || candidate.alias === name
    );
    if (subcommand !== undefined) {
      return subcommand;
    }
  }
  return undefined;
};

export const telemetryCommandPath = (
  command: CommandNode,
  args: readonly string[]
): string => {
  const path: string[] = [];
  let current = command;

  for (const arg of args) {
    if (arg.startsWith("-")) {
      break;
    }

    const subcommand = findSubcommand(current, arg);
    if (subcommand === undefined) {
      break;
    }

    path.push(subcommand.name);
    current = subcommand;
  }

  if (path.length > 0) {
    return path.join(".");
  }

  return args.some((arg) => !arg.startsWith("-")) ? "unknown" : "root";
};
