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
  readonly typeName?: string;
};

type WrappedParam = Param.Any & {
  readonly param: Param.Any;
};

type VariadicParam = WrappedParam & {
  readonly _tag: "Variadic";
  readonly min: Option.Option<number>;
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
  readonly negated: boolean;
  readonly valueName?: string;
  readonly valueOptional: boolean;
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

function paramMetadata(param: Param.Any): {
  readonly optional: boolean;
  readonly variadic: boolean;
} {
  switch (param._tag) {
    case "Single":
      return { optional: false, variadic: false };
    case "Map":
    case "Transform":
      return paramMetadata((param as WrappedParam).param);
    case "Optional":
      return { ...paramMetadata((param as WrappedParam).param), optional: true };
    case "Variadic": {
      const variadic = param as VariadicParam;
      const metadata = paramMetadata(variadic.param);
      const minimum = "value" in variadic.min ? variadic.min.value : undefined;
      return {
        optional: metadata.optional || minimum === undefined || minimum === 0,
        variadic: true
      };
    }
  }
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
    const boolean = single.primitiveType._tag === "Boolean";
    const optionalValue =
      !boolean &&
      single.typeName?.startsWith("[") === true &&
      single.typeName.endsWith("]");
    return {
      name: single.name,
      aliases: single.aliases,
      hidden: single.hidden,
      ...(descriptionOf(single) !== undefined
        ? { description: descriptionOf(single) }
        : {}),
      boolean,
      negated: boolean && single.name.startsWith("no-"),
      ...(!boolean
        ? {
            valueName: optionalValue
              ? single.typeName!.slice(1, -1)
              : (single.typeName ?? "value")
          }
        : {}),
      valueOptional: optionalValue
    };
  });
}

export function commandArguments(
  command: Command.Command.Any
): ReadonlyArray<EffectCommandArgument> {
  return (command as CommandInternals).config.arguments.map((param) => {
    const single = unwrapParam(param);
    const metadata = paramMetadata(param);
    return {
      name: single.name,
      ...(descriptionOf(single) !== undefined
        ? { description: descriptionOf(single) }
        : {}),
      optional: metadata.optional,
      variadic: metadata.variadic
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
