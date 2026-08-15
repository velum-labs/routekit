export const DEFAULT_COMMAND_NAME = "code";

const ROOT_FLAGS = new Set(["--json", "--agent", "--human", "--tty"]);

// This focused product has no interactive TUI. Bare launches stay at root help,
// `-v`/`--version` route to the version command, and unknown argv is not
// rewritten into `code`.
export const applyDefaultCommand = (
  args: readonly string[],
  knownCommands: ReadonlySet<string>
): readonly string[] => {
  const firstOutputFlagIndex = args.findIndex((arg) => !ROOT_FLAGS.has(arg));
  const firstCommandIndex =
    firstOutputFlagIndex === -1 ? args.length : firstOutputFlagIndex;
  const firstArg = args[firstCommandIndex];
  if (firstArg === "--version" || firstArg === "-v") {
    return [
      ...args.slice(0, firstCommandIndex),
      "version",
      ...args.slice(firstCommandIndex + 1),
    ];
  }
  if (firstArg === undefined) {
    return [...args.slice(0, firstCommandIndex), "--help"];
  }
  if (firstArg === "--help" || firstArg === "-h") {
    return args;
  }
  if (!firstArg.startsWith("-") && knownCommands.has(firstArg)) {
    return args;
  }
  return args;
};
