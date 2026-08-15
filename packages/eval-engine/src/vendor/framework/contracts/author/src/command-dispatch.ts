// RFC 0002 type-tiers.md (Author Contract Type Tiers): the primitives-tier dispatch
// vocabulary shared by the command contract and every surface that routes
// `/name` input (RFC 0002 command.md). Imports nothing from other author
// modules so `chat` (and any future surface contract) can type its router
// handle without chaining through the full command contract.

/**
 * A JSON-serializable value. A command's structured `data` output and its `data`
 * events cross the surface/tool boundary as JSON, so the type is constrained to
 * what survives that round-trip rather than an open `unknown`.
 */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * A typed progress event a command streams to the invoking surface while it runs,
 * so a long command reports before it finishes (RFC 0002 command.md). `log` is the
 * common case; `progress` carries a fraction and `data` a structured payload.
 */
type CommandEvent =
  | { readonly kind: "log"; readonly line: string }
  | {
      readonly kind: "progress";
      readonly message: string;
      readonly fraction?: number | undefined;
    }
  | { readonly kind: "data"; readonly data: JsonValue };

/**
 * The human-facing line of a {@link CommandEvent}, or null for a `data` event
 * (a structured payload, not a display line). Every surface that renders a
 * command's streamed events (transcript, thread note) projects them this way.
 */
export const commandEventLine = (event: CommandEvent): string | null => {
  if (event.kind === "log") {
    return event.line;
  }
  if (event.kind === "progress") {
    return event.message;
  }
  return null;
};

/**
 * How a command was triggered (RFC 0002 command.md). `slash` is a human typing
 * `/name` on a chat surface (no agent in the loop); `tool` is the agent calling
 * the command as a tool during a run. `scopes` are the capability scopes the
 * invoker holds, checked against the command's declared `scopes` before `run`.
 */
interface CommandInvoker {
  readonly via: "slash" | "tool";
  readonly scopes: readonly string[];
}

/**
 * A command's outcome (RFC 0002 command.md). `ok: false` surfaces as a failure to
 * the invoker; `message` is the human-facing summary line; `data` is optional
 * structured output — rendered compactly for a human and returned as the tool
 * result to the agent. A thrown error is caught and reported as `ok: false`.
 */
interface CommandResult {
  readonly ok: boolean;
  readonly message?: string | undefined;
  readonly data?: JsonValue | undefined;
}

/**
 * The outcome of routing a `/name` line through the {@link CommandRouter}
 * (RFC 0002 command.md). `not-a-command` means the input did not begin with a
 * registered command name, so the surface MUST fall through to normal agent
 * handling unchanged — the additive-dispatch guarantee. The other variants each
 * carry a human-facing `message` the surface renders, plus the events streamed
 * during the run.
 */
type CommandDispatch =
  | { readonly kind: "not-a-command" }
  | {
      readonly kind: "ran";
      readonly name: string;
      readonly result: CommandResult;
      readonly events: readonly CommandEvent[];
    }
  | {
      readonly kind: "rejected";
      readonly name: string;
      readonly reason: "parse" | "scope";
      readonly message: string;
    };

/**
 * The runtime handle a chat surface uses to intercept `/name` input before an
 * agent turn (RFC 0002 command.md). Injected onto {@link Chat} alongside `stores`
 * and `logger`; the surface calls `dispatch` with the raw input line and renders
 * the returned {@link CommandDispatch}. Optional on `Chat` so lightweight mocks
 * and command-free workspaces need not supply one.
 */
interface CommandRouter {
  /**
   * Route a raw surface input line. Returns `not-a-command` for anything that is
   * not a registered `/name` (the surface then handles it as a normal prompt).
   * The surface supplies only `via` (a human `slash` or an agent `tool`); the
   * router attaches the runtime-granted scopes, so a surface never fabricates a
   * scope set.
   */
  readonly dispatch: (input: {
    readonly line: string;
    readonly via: CommandInvoker["via"];
  }) => Promise<CommandDispatch>;
  /** The registered command names, for `/help` and autocomplete. */
  readonly names: () => readonly string[];
}

export type {
  CommandDispatch,
  CommandEvent,
  CommandInvoker,
  CommandResult,
  CommandRouter,
};
