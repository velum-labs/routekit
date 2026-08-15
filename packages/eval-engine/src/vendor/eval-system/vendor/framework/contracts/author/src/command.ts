import type { ApiFeatureContext } from "./api.ts";
import type {
  CommandEvent,
  CommandInvoker,
  CommandResult,
  JsonValue,
} from "./command-dispatch.ts";
import type { FeatureLogger } from "./feature-logger.ts";
import type { McpResolver } from "./mcp.ts";

/**
 * A single declared argument for a command (RFC 0002 command.md). The runtime
 * parses the invocation text (for `/name`) or the tool call (for the agent)
 * against the command's argument spec, validates it, and passes the typed values
 * as {@link CommandContext.args}. The spec also generates the agent tool's input
 * schema and the `/help` usage line.
 */
interface CommandArgumentSpec {
  readonly type: "string" | "boolean" | "number";
  readonly description: string;
  readonly required?: boolean | undefined;
  readonly default?: string | number | boolean | undefined;
  /**
   * When `true`, the argument is filled from a bare positional token after
   * `/name` rather than a `--flag`. Positional arguments are consumed in
   * declaration order.
   */
  readonly positional?: boolean | undefined;
}

/** The declared argument spec for a command: a map of argument name to its spec. */
type CommandArguments = Readonly<Record<string, CommandArgumentSpec>>;

/** The result of a subprocess run via {@link CommandContext.exec}. */
interface CommandExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * The runtime handles passed to a command's `run` (RFC 0002 command.md). A command
 * is plain code; the same `run` executes whether a human typed `/name` or the
 * agent called the command as a tool, distinguished only by `invoker.via`.
 */
interface CommandContext<Args = Readonly<Record<string, JsonValue>>> {
  /** Parsed, typed arguments (per the `arguments` spec); `{}` when none declared. */
  readonly args: Args;
  /** The raw text after `/name` (or the raw tool argument string), trimmed. */
  readonly argv: string;
  /** Run a subprocess; never throws on non-zero exit — inspect `exitCode`. */
  readonly exec: (
    bin: string,
    args?: readonly string[]
  ) => Promise<CommandExecResult>;
  /** Stream a typed progress event to the invoking surface. */
  readonly emit: (event: CommandEvent) => void;
  /** Sugar for `emit({ kind: "log", line })`. */
  readonly log: (line: string) => void;
  /** The workspace root the command runs against. */
  readonly cwd: string;
  /** The resolved runtime environment (read-only). */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** How the command was triggered. */
  readonly invoker: CommandInvoker;
  /** Diagnostic logger for this invocation, pre-scoped to the owning feature (RFC 0011). */
  readonly logger: FeatureLogger;
  /**
   * Reach an MCP server declared in the workspace `mcp.json`. Optional: present
   * only when the host wired MCP for this invocation, so a handler guards before use.
   */
  readonly mcp?: McpResolver | undefined;
  /** Call another feature's `api.exports`; dependency edges are enforced. */
  readonly use: ApiFeatureContext["use"];
}

/**
 * A `command` contribution: a deterministic action invocable as `/name` by a human
 * (before any agent turn) and as a tool by the agent, running the same fixed `run`
 * either way (RFC 0002 command.md). Authored as the `feature.ts` `command`/`commands`
 * export or a standalone `features/<id>/command.ts` / `commands/<name>/command.ts`
 * file. A command is the deterministic counterpart to `skill`, which is prose the
 * agent interprets.
 */
interface CommandContribution<Args = Readonly<Record<string, JsonValue>>> {
  /**
   * The `/name` the command registers under. Defaults to the nested-path name
   * (`commands/<name>/`) or the feature id (feature-root `command.ts`), and is
   * required when several commands come from one `feature.ts` `commands` array.
   * Must match `[a-z][a-z0-9-]*`.
   */
  readonly name?: string | undefined;
  /**
   * One line shown in `/help` and in the tool description the agent sees. Unlike a
   * `skill` description it does not gate human `/name` invocation, but it is the
   * description the agent matches when deciding to call the command as a tool.
   */
  readonly description: string;
  /** Declared argument spec; omitted when the command takes no arguments. */
  readonly arguments?: CommandArguments | undefined;
  /**
   * Capability scopes the command requires (e.g. `service:restart`, `repo:write`).
   * The runtime checks the invoker holds them before running; a missing scope fails
   * the invocation without running `run`.
   */
  readonly scopes?: readonly string[] | undefined;
  /** The command's fixed code. Its executed steps do not depend on how it was triggered. */
  readonly run: (
    ctx: CommandContext<Args>
  ) => CommandResult | Promise<CommandResult>;
}

/**
 * Type pass-through that types a `command` named export (`feature.ts` or a
 * standalone `command.ts`) (RFC 0002 command.md). Preserves the `Args` type so a
 * command's `run` sees its declared arguments typed.
 */
export const defineCommand = <Args = Readonly<Record<string, JsonValue>>>(
  contribution: CommandContribution<Args>
): CommandContribution<Args> => contribution;

export type {
  CommandArgumentSpec,
  CommandArguments,
  CommandContext,
  CommandContribution,
  CommandExecResult,
};
