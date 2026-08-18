import type { Option } from "effect";
import type * as Command from "effect/unstable/cli/Command";
import type * as Param from "effect/unstable/cli/Param";

type SingleParam = Param.Any & {
  readonly _tag: "Single";
  readonly name: string;
  readonly aliases: ReadonlyArray<string>;
  readonly hidden: boolean;
  readonly description: Option.Option<string>;
  readonly primitiveType: { readonly _tag: string };
};

type WrappedParam = Param.Any & {
  readonly param: Param.Any;
};

type CommandInternals = Command.Command.Any & {
  readonly config: {
    readonly flags: ReadonlyArray<Param.Any>;
    readonly arguments: ReadonlyArray<Param.Any>;
  };
};

export type EffectCommandOption = {
  readonly name: string;
  readonly aliases: ReadonlyArray<string>;
  readonly hidden: boolean;
  readonly description?: string;
  readonly boolean: boolean;
};

export type EffectCommandArgument = {
  readonly name: string;
  readonly description?: string;
  readonly optional: boolean;
  readonly variadic: boolean;
};

function unwrapParam(param: Param.Any): SingleParam {
  let current = param;
  while (current._tag !== "Single") current = (current as WrappedParam).param;
  return current as SingleParam;
}

function descriptionOf(param: SingleParam): string | undefined {
  return "value" in param.description ? param.description.value : undefined;
}

export function commandChildren(
  command: Command.Command.Any
): ReadonlyArray<Command.Command.Any> {
  return command.subcommands.flatMap((group) => group.commands);
}

export function visibleCommandChildren(
  command: Command.Command.Any
): ReadonlyArray<Command.Command.Any> {
  return commandChildren(command).filter(
    (child) => child.name !== "help" && !child.name.startsWith("__") && !child.unlisted
  );
}

export function commandNames(command: Command.Command.Any): ReadonlyArray<string> {
  return command.alias === undefined ? [command.name] : [command.name, command.alias];
}

export function commandOptions(
  command: Command.Command.Any
): ReadonlyArray<EffectCommandOption> {
  return (command as CommandInternals).config.flags.map((param) => {
    const single = unwrapParam(param);
    return {
      name: single.name,
      aliases: single.aliases,
      hidden: single.hidden,
      ...(descriptionOf(single) !== undefined
        ? { description: descriptionOf(single) }
        : {}),
      boolean: single.primitiveType._tag === "Boolean"
    };
  });
}

export function commandArguments(
  command: Command.Command.Any
): ReadonlyArray<EffectCommandArgument> {
  return (command as CommandInternals).config.arguments.map((param) => {
    const single = unwrapParam(param);
    return {
      name: single.name,
      ...(descriptionOf(single) !== undefined
        ? { description: descriptionOf(single) }
        : {}),
      optional: param._tag === "Optional",
      variadic: param._tag === "Variadic"
    };
  });
}

export function flattenEffectCommands(
  command: Command.Command.Any
): ReadonlyArray<Command.Command.Any> {
  return commandChildren(command).flatMap((child) => [
    child,
    ...flattenEffectCommands(child)
  ]);
}

export function effectCommandPath(
  root: Command.Command.Any,
  target: Command.Command.Any
): string {
  const visit = (
    command: Command.Command.Any,
    path: ReadonlyArray<string>
  ): string | undefined => {
    for (const child of commandChildren(command)) {
      const next = [...path, child.name];
      if (child === target) return next.join(" ");
      const nested = visit(child, next);
      if (nested !== undefined) return nested;
    }
    return undefined;
  };
  return visit(root, []) ?? "";
}
