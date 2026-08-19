import { commandChildren } from "@velum-labs/routekit-cli-core";
import type * as Command from "effect/unstable/cli/Command";

export function dottedCommandPath(path: string): string {
  return path.trim().replace(/\s+/g, ".");
}

export function flattenCommands(command: Command.Command.Any): ReadonlyArray<Command.Command.Any> {
  return commandChildren(command).flatMap((child) => [child, ...flattenCommands(child)]);
}

export function actionableCommandPaths(program: Command.Command.Any): string[] {
  const visit = (command: Command.Command.Any, prefix: readonly string[]): string[] =>
    commandChildren(command).flatMap((child) => {
      const path = [...prefix, child.name];
      const nested = visit(child, path);
      const config = (child as unknown as {
        readonly config: {
        readonly flags: ReadonlyArray<unknown>;
        readonly arguments: ReadonlyArray<unknown>;
        };
      }).config;
      const actionableParent = config.flags.length > 0 || config.arguments.length > 0;
      return [...(nested.length === 0 || actionableParent ? [path.join(" ")] : []), ...nested];
    });
  return visit(program, []).sort((left, right) => left.localeCompare(right));
}
