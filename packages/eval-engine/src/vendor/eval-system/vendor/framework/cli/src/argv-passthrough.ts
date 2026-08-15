import { Context } from "effect";
import { Param } from "effect/unstable/cli";

/**
 * The extra arguments meant for a launched tool, like `routekit-eval claude` or
 * `routekit-eval codex`. Commands like these need to forward whatever the user typed
 * straight through to the underlying tool. Defaults to empty everywhere else.
 *
 * TEMPORARY: Effect's CLI parser rejects flags it doesn't recognize,
 * so today we pull these arguments out of argv ourselves before the parser
 * ever sees them. When Effect's CLI adds a proper way to say "forward the rest
 * to this command untouched", we can delete this module and let the parser do
 * it.
 */
export const PassthroughArgs = Context.Reference<readonly string[]>(
  "routekit-eval/cli/PassthroughArgs",
  { defaultValue: (): readonly string[] => [] }
);

export interface ArgvSplit {
  /** The matched passthrough command, or undefined when argv was not split. */
  readonly command: string | undefined;
  readonly cliArgv: readonly string[];
  readonly passthrough: readonly string[];
}

/** A flat flag config, the same shape `Command.make` accepts for flags. */
export type PassthroughFlagConfig = Record<
  string,
  Param.Param<typeof Param.flagKind, unknown>
>;

/**
 * The `flag` shape shared by `GlobalFlag` Actions and Settings; the splitter
 * only needs the underlying param to derive token rules.
 */
export interface PassthroughGlobalFlag {
  readonly flag: Param.Param<typeof Param.flagKind, unknown>;
}

/**
 * Every non-Single param variant (Map, Transform, Optional, Variadic) publicly
 * wraps another param; this names that shape so the walk below stays typed.
 */
type WrappedFlagParam = Param.Param<typeof Param.flagKind, unknown> & {
  readonly param: Param.Param<typeof Param.flagKind, unknown>;
};

const isWrappedFlagParam = (
  param: Param.Param<typeof Param.flagKind, unknown>
): param is WrappedFlagParam => "param" in param;

const underlyingSingle = (
  flag: Param.Param<typeof Param.flagKind, unknown>
): Param.Single<typeof Param.flagKind, unknown> => {
  let current = flag;
  while (!Param.isSingle(current)) {
    if (!isWrappedFlagParam(current)) {
      throw new Error(
        `Cannot derive passthrough splitting for flag param variant "${current._tag}": it neither is a Single nor wraps one.`
      );
    }
    current = current.param;
  }
  return current;
};

interface FlagSpec {
  readonly isBoolean: boolean;
}

type FlagIndex = ReadonlyMap<string, FlagSpec>;

const buildFlagIndex = (
  flags: Iterable<Param.Param<typeof Param.flagKind, unknown>>
): FlagIndex =>
  new Map(
    [...flags].flatMap((flag) => {
      const single = underlyingSingle(flag);
      // "Boolean" is the public `_tag` that `Flag.boolean` constructs with;
      // boolean flags follow different value-consumption rules below.
      const spec = { isBoolean: single.primitiveType._tag === "Boolean" };
      return [single.name, ...single.aliases].map(
        (name) => [name, spec] as const
      );
    })
  );

// Mirrors effect's `Config.TrueValues`/`FalseValues`: the CLI parser lets a
// boolean flag consume an adjacent literal (`--verbose false`), so the
// splitter must keep such literals on the CLI side of the cut. The contract
// tests in argv-passthrough.test.ts pin this against the real parser.
const BOOLEAN_FLAG_LITERALS = new Set([
  "true",
  "yes",
  "on",
  "1",
  "y",
  "false",
  "no",
  "off",
  "0",
  "n",
]);

// Effect's lexer treats a lone "-" as a value, not an option.
const isValueToken = (raw: string): boolean =>
  !raw.startsWith("-") || raw === "-";

interface FlagUse {
  readonly isBoolean: boolean;
  readonly hasInlineValue: boolean;
}

const resolveFlagToken = (
  index: FlagIndex,
  token: string
): FlagUse | undefined => {
  if (isValueToken(token) || token === "--") {
    return undefined;
  }
  const isLong = token.startsWith("--");
  const body = isLong ? token.slice(2) : token.slice(1);
  const equalsIndex = body.indexOf("=");
  const name = equalsIndex === -1 ? body : body.slice(0, equalsIndex);
  const hasInlineValue = equalsIndex !== -1;
  if (!isLong && !hasInlineValue && body.length > 1) {
    // Effect lexes `-abc` as the short flags a, b, c, and only the trailing
    // one can consume a following value. A cluster with any unknown char is
    // not ours and passes through whole.
    let last: FlagUse | undefined;
    for (const short of body) {
      const spec = index.get(short);
      if (spec === undefined) {
        return undefined;
      }
      last = {
        isBoolean: spec.isBoolean,
        hasInlineValue: false,
      };
    }
    return last;
  }
  const direct = index.get(name);
  if (direct !== undefined) {
    return {
      isBoolean: direct.isBoolean,
      hasInlineValue,
    };
  }
  // Effect resolves `--no-<flag>` as the negated form of a boolean flag. Keep
  // it (and any adjacent literal, which effect rejects with a proper error) on
  // the CLI side.
  if (isLong && name.startsWith("no-")) {
    const target = index.get(name.slice("no-".length));
    if (target?.isBoolean) {
      return {
        isBoolean: true,
        hasInlineValue,
      };
    }
  }
  return undefined;
};

const consumesNextToken = (flag: FlagUse, next: string): boolean => {
  if (flag.hasInlineValue || !isValueToken(next)) {
    return false;
  }
  return flag.isBoolean ? BOOLEAN_FLAG_LITERALS.has(next) : true;
};

/**
 * Scans past recognised leading global flags (`routekit-eval --json codex ...`) and
 * returns the index of the first non-global token — the command-name slot.
 */
const scanLeadingGlobals = (
  argv: readonly string[],
  leadingIndex: FlagIndex
): number => {
  let index = 0;
  while (index < argv.length) {
    const flag = resolveFlagToken(leadingIndex, argv[index]);
    if (flag === undefined) {
      break;
    }
    index += 1;
    const next = argv[index];
    if (next !== undefined && consumesNextToken(flag, next)) {
      index += 1;
    }
  }
  return index;
};

/**
 * Builds a splitter that cuts a passthrough command's argv into the prefix
 * Effect CLI should parse and the passthrough tail for the wrapped tool. The
 * cut happens at `--` or at the first token neither the command's flags nor
 * the global flags own; the tail reaches the command handlers via
 * {@link PassthroughArgs}. Argv that does not lead with one of `commands`
 * (allowing recognised global flags before it, e.g. `routekit-eval --json codex`) is
 * returned untouched.
 *
 * Pass the exact flag config the commands hand to `Command.make` and the
 * exact global flags the root command registers: the token rules (names,
 * aliases, boolean-ness) are derived from them, so the splitter cannot drift
 * from the command tree.
 *
 * Effect CLI cannot do this itself: its parser hard-errors on unknown flags
 * and strands post-`--` operands at the parent command (`processFlag` and
 * `parseArgs` in effect's `unstable/cli/internal/parser.ts`), so passthrough
 * flags would never reach the handlers.
 */
export const makePassthroughSplitter = (options: {
  /** Top-level subcommand names whose trailing argv is passthrough. */
  readonly commands: readonly string[];
  /** The exact flag config the passthrough commands hand to `Command.make`. */
  readonly flags: PassthroughFlagConfig;
  /** The global flags of the command tree (settings, actions, built-ins). */
  readonly globalFlags: readonly PassthroughGlobalFlag[];
}): ((argv: readonly string[]) => ArgvSplit) => {
  const globalParams = options.globalFlags.map((global) => global.flag);
  // Before the command name only global flags may appear; after it the
  // command's own flags are owned too.
  const leadingIndex = buildFlagIndex(globalParams);
  const flagIndex = buildFlagIndex([
    ...Object.values(options.flags),
    ...globalParams,
  ]);
  const commands = new Set(options.commands);
  return (argv) => {
    // A leading token that is not a recognised global flag means this argv is
    // not a passthrough launch and Effect CLI parses it whole.
    const commandIndex = scanLeadingGlobals(argv, leadingIndex);
    const command = argv[commandIndex];
    if (command === undefined || !commands.has(command)) {
      return {
        command: undefined,
        cliArgv: argv,
        passthrough: [],
      };
    }
    const cliArgv = argv.slice(0, commandIndex + 1);
    for (let index = commandIndex + 1; index < argv.length; index += 1) {
      const token = argv[index];
      if (token === "--") {
        return {
          command,
          cliArgv,
          passthrough: argv.slice(index + 1),
        };
      }
      const flag = resolveFlagToken(flagIndex, token);
      if (flag === undefined) {
        return {
          command,
          cliArgv,
          passthrough: argv.slice(index),
        };
      }
      cliArgv.push(token);
      const next = argv[index + 1];
      if (next !== undefined && consumesNextToken(flag, next)) {
        cliArgv.push(next);
        index += 1;
      }
    }
    return {
      command,
      cliArgv,
      passthrough: [],
    };
  };
};
