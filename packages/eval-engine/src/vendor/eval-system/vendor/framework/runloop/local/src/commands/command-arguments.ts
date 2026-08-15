import type {
  CommandArguments,
  CommandArgumentSpec,
} from "../../../../contracts/author/src/command.ts";

/**
 * The typed value a parsed argument resolves to. A command's `run` reads these
 * off `ctx.args`; the union matches the declared `type` in {@link CommandArgumentSpec}.
 */
type CommandArgumentValue = string | number | boolean;

interface ParsedArguments {
  readonly ok: true;
  readonly args: Readonly<Record<string, CommandArgumentValue>>;
}

interface ArgumentParseFailure {
  readonly ok: false;
  readonly message: string;
}

type ArgumentParseResult = ParsedArguments | ArgumentParseFailure;

/**
 * Split a raw remainder into whitespace-separated tokens, honoring single and
 * double quotes so a value with spaces survives (`--message "hello world"`).
 * Deliberately small: commands take flags and short positionals, not shell
 * pipelines, so this is not a full shell lexer.
 */
const tokenize = (raw: string): readonly string[] => {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/gu;
  let match = pattern.exec(raw);
  while (match !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
    match = pattern.exec(raw);
  }
  return tokens;
};

const coerce = (
  spec: CommandArgumentSpec,
  raw: string,
  name: string
): CommandArgumentValue | ArgumentParseFailure => {
  if (spec.type === "string") {
    return raw;
  }
  if (spec.type === "number") {
    const value = Number(raw);
    return Number.isFinite(value)
      ? value
      : {
          message: `argument "${name}" expects a number, got "${raw}"`,
          ok: false,
        };
  }
  if (raw === "true" || raw === "false") {
    return raw === "true";
  }
  return {
    message: `argument "${name}" expects true or false, got "${raw}"`,
    ok: false,
  };
};

const isFailure = (
  value: CommandArgumentValue | ArgumentParseFailure
): value is ArgumentParseFailure => typeof value === "object" && !value.ok;

interface FlagScan {
  readonly values: Map<string, CommandArgumentValue>;
  readonly positionals: string[];
  readonly failure?: ArgumentParseFailure;
}

/**
 * First pass: walk the tokens, pulling `--flag value` (and `--flag` for a
 * boolean) into `values` and everything else into `positionals`. A `--flag`
 * naming an unknown or non-boolean argument without a following value fails.
 */
const scanTokens = (
  tokens: readonly string[],
  spec: CommandArguments
): FlagScan => {
  const values = new Map<string, CommandArgumentValue>();
  const positionals: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const name = token.slice(2);
    const argSpec = spec[name];
    if (argSpec === undefined) {
      return {
        failure: {
          message: `unknown flag "--${name}"`,
          ok: false,
        },
        positionals,
        values,
      };
    }
    if (argSpec.type === "boolean") {
      values.set(name, true);
      continue;
    }
    const next = tokens[index + 1];
    if (next === undefined) {
      return {
        failure: {
          message: `flag "--${name}" expects a value`,
          ok: false,
        },
        positionals,
        values,
      };
    }
    const coerced = coerce(argSpec, next, name);
    if (isFailure(coerced)) {
      return {
        failure: coerced,
        positionals,
        values,
      };
    }
    values.set(name, coerced);
    index += 1;
  }
  return {
    positionals,
    values,
  };
};

/**
 * Assign leftover positional tokens to the arguments declared `positional: true`,
 * in declaration order, coercing each to its type. Extra positionals beyond the
 * declared set are ignored (a command reads the raw remainder via `ctx.argv` if
 * it wants them).
 */
const assignPositionals = (
  positionals: readonly string[],
  spec: CommandArguments,
  values: Map<string, CommandArgumentValue>
): ArgumentParseFailure | undefined => {
  const positionalNames = Object.keys(spec).filter(
    (name) => spec[name]?.positional === true
  );
  for (const [slot, name] of positionalNames.entries()) {
    const raw = positionals[slot];
    if (raw === undefined || values.has(name)) {
      continue;
    }
    const argSpec = spec[name];
    if (argSpec === undefined) {
      continue;
    }
    const coerced = coerce(argSpec, raw, name);
    if (isFailure(coerced)) {
      return coerced;
    }
    values.set(name, coerced);
  }
  return undefined;
};

/**
 * Apply declared defaults and enforce `required`, producing the final typed
 * argument map (or a failure naming the first missing required argument).
 */
const finalizeArguments = (
  spec: CommandArguments,
  values: Map<string, CommandArgumentValue>
): ArgumentParseResult => {
  const args: Record<string, CommandArgumentValue> = {};
  for (const [name, argSpec] of Object.entries(spec)) {
    const resolved = values.get(name) ?? argSpec.default;
    if (resolved === undefined) {
      if (argSpec.required === true) {
        return {
          message: `missing required argument "${name}"`,
          ok: false,
        };
      }
      continue;
    }
    args[name] = resolved;
  }
  return {
    args,
    ok: true,
  };
};

/**
 * Parse the raw text after `/name` against a command's declared `arguments`
 * spec into typed values (RFC 0002 command.md). Supports `--flag value`,
 * boolean `--flag`, and declared positionals; applies defaults and enforces
 * `required`. A command with no declared spec always parses to `{}`.
 */
export const parseCommandArguments = (
  argv: string,
  spec?: CommandArguments
): ArgumentParseResult => {
  if (spec === undefined) {
    return {
      args: {},
      ok: true,
    };
  }
  const scan = scanTokens(tokenize(argv), spec);
  if (scan.failure !== undefined) {
    return scan.failure;
  }
  const positionalFailure = assignPositionals(
    scan.positionals,
    spec,
    scan.values
  );
  if (positionalFailure !== undefined) {
    return positionalFailure;
  }
  return finalizeArguments(spec, scan.values);
};

export type { CommandArgumentValue, ArgumentParseResult };
