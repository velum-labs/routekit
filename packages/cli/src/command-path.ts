import type { Command } from "commander";

type ActionableCommand = Command & { _actionHandler?: unknown };

export function commandPath(command: Command): string {
  const names: string[] = [];
  for (
    let current: Command | null | undefined = command;
    current?.parent;
    current = current.parent
  ) {
    names.unshift(current.name());
  }
  return names.join(" ");
}

export function dottedCommandPath(path: string): string {
  return path.trim().replace(/\s+/g, ".");
}

export function flattenCommands(command: Command): Command[] {
  return command.commands.flatMap((child) => [child, ...flattenCommands(child)]);
}

export function isActionableCommand(command: Command): boolean {
  return typeof (command as ActionableCommand)._actionHandler === "function";
}

export function actionableCommandPaths(program: Command): string[] {
  return flattenCommands(program)
    .filter(isActionableCommand)
    .map(commandPath)
    .sort((left, right) => left.localeCompare(right));
}
