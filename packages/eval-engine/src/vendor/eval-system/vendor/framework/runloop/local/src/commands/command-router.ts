import type { ApiFeatureContext } from "../../../../contracts/author/src/api.ts";
import type {
  CommandContext,
  CommandContribution,
} from "../../../../contracts/author/src/command.ts";
import type {
  CommandDispatch,
  CommandEvent,
  CommandInvoker,
  CommandRouter,
} from "../../../../contracts/author/src/command-dispatch.ts";
import type { FeatureLogger } from "../../../../contracts/author/src/feature-logger.ts";
import type { NamedContributionEntry } from "../../../../engine/registries/src/capability-entries.ts";

import { parseCommandArguments } from "./command-arguments.ts";
import { runCommandExec } from "./command-exec.ts";
import {
  errorStack,
  formatUnknownError,
} from "../../../../utils/core/src/error-formatting.ts";

interface CommandRouterInput {
  readonly commands: readonly NamedContributionEntry<CommandContribution>[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /**
   * Scopes the runtime grants an invoker (RFC 0002 command.md). In v1 this is the
   * single runtime-level grant set; the router checks each command's declared
   * `scopes` against it before running.
   */
  readonly grantedScopes: readonly string[];
  readonly logger?: FeatureLogger | undefined;
  readonly useFor: (featureId: string) => ApiFeatureContext["use"];
}

const SLASH_PATTERN = /^\/([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$/u;

interface ParsedLine {
  readonly name: string;
  readonly argv: string;
}

/**
 * Match a raw input line against the `/name [remainder]` shape. Returns null for
 * anything that is not a slash command so the surface falls through to the agent
 * unchanged — the additive-dispatch guarantee (RFC 0002 command.md).
 */
const parseSlashLine = (line: string): ParsedLine | null => {
  const match = SLASH_PATTERN.exec(line.trim());
  if (match === null) {
    return null;
  }
  return {
    argv: (match[2] ?? "").trim(),
    name: match[1] ?? "",
  };
};

const missingScopes = (
  required: readonly string[] | undefined,
  held: readonly string[]
): readonly string[] => {
  if (required === undefined) {
    return [];
  }
  const grantSet = new Set(held);
  return required.filter((scope) => !grantSet.has(scope));
};

// A command author's contract requires a logger; when the host injects none (a
// bare mock), the context falls back to this no-op so `run` never dereferences
// undefined. Real runtimes always pass one.
const noop = (): void => undefined;
const NO_OP_LOGGER: FeatureLogger = {
  child: () => NO_OP_LOGGER,
  debug: noop,
  error: noop,
  info: noop,
  trace: noop,
  warn: noop,
};

/**
 * Build the `CommandContext` for one invocation: typed args, the raw remainder,
 * a subprocess-backed `exec` (see command-exec), an `emit`/`log` pair that
 * collects events for the surface to render, and the invoker. `emit` appends to
 * the passed array so the caller can render the stream after `run` resolves.
 */
const makeContext = (input: {
  readonly args: Readonly<Record<string, string | number | boolean>>;
  readonly argv: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly events: CommandEvent[];
  readonly invoker: CommandInvoker;
  readonly logger?: FeatureLogger | undefined;
  readonly use: ApiFeatureContext["use"];
}): CommandContext => {
  const emit = (event: CommandEvent): void => {
    input.events.push(event);
    if (event.kind === "log") {
      input.logger?.info(event.line);
    }
  };
  return {
    args: input.args,
    argv: input.argv,
    cwd: input.cwd,
    emit,
    env: input.env,
    exec: (bin, args) =>
      runCommandExec(bin, args ?? [], {
        cwd: input.cwd,
        env: input.env,
      }),
    invoker: input.invoker,
    log: (line: string) => {
      emit({
        kind: "log",
        line,
      });
    },
    logger: input.logger ?? NO_OP_LOGGER,
    use: input.use,
  };
};

const runContribution = async (input: {
  readonly contribution: CommandContribution;
  readonly ctx: CommandContext;
  readonly events: CommandEvent[];
  readonly featureId: string;
  readonly logger?: FeatureLogger | undefined;
  readonly name: string;
}): Promise<CommandDispatch> => {
  try {
    const result = await input.contribution.run(input.ctx);
    return {
      events: input.events,
      kind: "ran",
      name: input.name,
      result,
    };
  } catch (error) {
    const message = formatUnknownError(error);
    // The chat line stays terse (`/name failed: <message>`), but a thrown
    // command is otherwise unlocatable — an unhelpful runtime message like
    // "{} is not iterable" names neither the command nor the feature that owns
    // it. The log sink renders `record.error` through `formatUnknownError`,
    // which keeps only an Error's `.message`, so pass the owning feature id and
    // the stack as structured fields to reach `routekit-eval logs` and pin the culprit
    // source.
    const stack = errorStack(error);
    input.logger?.error(`command "${input.name}" threw`, error, {
      featureId: input.featureId,
      ...(stack === undefined ? {} : { stack }),
    });
    return {
      events: input.events,
      kind: "ran",
      name: input.name,
      result: {
        message: `/${input.name} failed: ${message}`,
        ok: false,
      },
    };
  }
};

const runCommand = async (input: {
  readonly contribution: CommandContribution;
  readonly argv: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly featureId: string;
  readonly invoker: CommandInvoker;
  readonly logger?: FeatureLogger | undefined;
  readonly use: ApiFeatureContext["use"];
  readonly name: string;
}): Promise<CommandDispatch> => {
  const { contribution, name } = input;

  const missing = missingScopes(contribution.scopes, input.invoker.scopes);
  if (missing.length > 0) {
    return {
      kind: "rejected",
      message: `/${name} requires scope(s) not granted: ${missing.join(", ")}`,
      name,
      reason: "scope",
    };
  }

  const parsed = parseCommandArguments(input.argv, contribution.arguments);
  if (!parsed.ok) {
    return {
      kind: "rejected",
      message: `/${name}: ${parsed.message}`,
      name,
      reason: "parse",
    };
  }

  const events: CommandEvent[] = [];
  const ctx = makeContext({
    args: parsed.args,
    argv: input.argv,
    cwd: input.cwd,
    env: input.env,
    events,
    invoker: input.invoker,
    logger: input.logger,
    use: input.use,
  });

  return await runContribution({
    contribution,
    ctx,
    events,
    featureId: input.featureId,
    logger: input.logger,
    name,
  });
};

/**
 * Build the pre-agent {@link CommandRouter} over a workspace's registered command
 * contributions (RFC 0002 command.md). The runtime injects the result onto the
 * `Chat` handle; a surface calls `dispatch` on inbound input and renders anything
 * that is not `not-a-command`. Unknown `/foo` returns `not-a-command`, so an
 * unregistered slash falls through to normal agent handling unchanged.
 */
export const makeCommandRouter = (input: CommandRouterInput): CommandRouter => {
  const byName = new Map(
    input.commands.map((entry) => [entry.name, entry] as const)
  );

  return {
    dispatch: (request) => {
      const parsed = parseSlashLine(request.line);
      if (parsed === null) {
        return Promise.resolve({ kind: "not-a-command" });
      }
      const entry = byName.get(parsed.name);
      if (entry === undefined) {
        return Promise.resolve({ kind: "not-a-command" });
      }
      const { featureId, value: contribution } = entry;
      return runCommand({
        argv: parsed.argv,
        contribution,
        cwd: input.cwd,
        env: input.env,
        featureId,
        invoker: {
          scopes: input.grantedScopes,
          via: request.via,
        },
        logger: input.logger,
        name: parsed.name,
        use: input.useFor(featureId),
      });
    },
    names: () => [...byName.keys()],
  };
};
