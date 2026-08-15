// Resolves the recognized command chain from raw argv so telemetry and the
// JSON error envelope report only the subcommand path (e.g. `schedules list`),
// never positional argument values such as an unknown `ori code` argument. The
// tree is built from the real registered commands, so it cannot drift from what
// the parser accepts.

const FLAG_PREFIX = "-";

export interface CommandTreeInput {
  readonly name: string;
  readonly alias: string | undefined;
  readonly subcommands: readonly {
    readonly commands: readonly CommandTreeInput[];
  }[];
}

export interface CommandNameNode {
  readonly children: ReadonlyMap<string, CommandNameNode>;
}

export const buildCommandNameTree = (
  commands: readonly CommandTreeInput[]
): ReadonlyMap<string, CommandNameNode> => {
  const entries = new Map<string, CommandNameNode>();
  for (const command of commands) {
    const node: CommandNameNode = {
      children: buildCommandNameTree(
        command.subcommands.flatMap((group) => group.commands)
      ),
    };
    entries.set(command.name, node);
    if (command.alias !== undefined) {
      entries.set(command.alias, node);
    }
  }
  return entries;
};

/**
 * The recognized command chain from `args`, stopping at the first flag or the
 * first token that is not a subcommand of the current level. Positional
 * argument values are therefore excluded.
 */
export const resolveCommandPath = (
  args: readonly string[],
  tree: ReadonlyMap<string, CommandNameNode>
): readonly string[] => {
  const path: string[] = [];
  let level = tree;
  for (const arg of args) {
    if (arg.startsWith(FLAG_PREFIX)) {
      break;
    }
    const node = level.get(arg);
    if (node === undefined) {
      break;
    }
    path.push(arg);
    level = node.children;
  }
  return path;
};
