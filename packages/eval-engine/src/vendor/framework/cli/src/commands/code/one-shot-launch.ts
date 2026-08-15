import { Effect } from "effect";

import { interactiveCommandError } from "../../../../contracts/internal/src/cli/cli-output.ts";
import { OutputMode } from "../../../../contracts/internal/src/cli/output-mode.ts";
import { CliFailureError } from "../../../../contracts/internal/src/errors.ts";

// The launch decision for `ori code` (RFC 0004 code.md): which of the three
// session kinds this invocation runs — the interactive TUI, the prose headless
// turn (`-p`), or the structured JSONL one-shot (`--output jsonl`) — resolved
// once, before the update check and credential resolution.

/** The output format flag's values (RFC 0004 code.md "Structured output"). */
export const CODE_OUTPUT_FORMATS = ["text", "jsonl"] as const;
export type CodeOutputFormat = (typeof CODE_OUTPUT_FORMATS)[number];

/**
 * The launch shape `runCodeCommand` branches on. The headless arms carry the
 * prompt so downstream code never re-derives (or re-checks) its presence.
 */
export type CodeLaunch =
  | {
      readonly kind: "jsonl";
      readonly prompt: string;
    }
  | { readonly kind: "prose"; readonly prompt: string }
  | { readonly kind: "tui" };

const NO_PROMPT_HINT =
  'Pass a prompt (`ori-eval-system code -p "<task>"` or `--prompt-file`) to run a single headless turn, or use `spawn` for the eval interview. This product has no interactive TUI.';

const EXPLICIT_JSON_HINT =
  "A headless `ori code -p` run streams prose, not an envelope. For structured machine output use `--output jsonl`, or the JSON sub-APIs (`ori sessions`, `ori logs`, `ori schedules`).";

interface ResolveCodeLaunchInput {
  readonly output: CodeOutputFormat;
  readonly prompt: string | undefined;
}

const failMissingPrompt = (flag: string): CliFailureError =>
  new CliFailureError({
    detail: `\`${flag}\` needs a prompt to run.`,
    hint: 'Pass one with `--prompt`/`-p "<task>"` or `--prompt-file <path>`.',
  });

/**
 * Resolve the launch kind from the output mode (and whether it was forced or
 * inferred), the stdout TTY flag, and the parsed flags.
 *
 * A prompt always means a headless run, on a terminal exactly as in a pipe:
 * `--output jsonl` selects the structured one-shot, an explicit
 * `--json`/`ORI_OUTPUT=json` without it keeps the interactive refusal (a piped
 * stdout and a request for a machine envelope are distinct signals — the prose
 * run emits no envelope) and hints at `--output jsonl`, and everything else
 * streams prose. The chat is never launched carrying a prompt.
 *
 * Without a prompt there is nothing to run headlessly, so every launch that
 * cannot mount a TUI fails fast — including a piped stdout with
 * `ORI_OUTPUT=human`, which previously booted the TUI and painted ANSI escapes
 * into the pipe.
 */
export const resolveCodeLaunch = Effect.fn("CodeCommand.resolveLaunch")(
  function* (input: ResolveCodeLaunchInput) {
    if (input.prompt === undefined) {
      if (input.output === "jsonl") {
        return yield* failMissingPrompt("--output jsonl");
      }
      return yield* interactiveCommandError("code", NO_PROMPT_HINT);
    }

    if (input.output === "jsonl") {
      return {
        kind: "jsonl",
        prompt: input.prompt,
      } satisfies CodeLaunch;
    }
    const { mode, source } = yield* OutputMode;
    if (mode === "json" && source === "explicit") {
      return yield* interactiveCommandError("code", EXPLICIT_JSON_HINT);
    }
    return {
      kind: "prose",
      prompt: input.prompt,
    } satisfies CodeLaunch;
  }
);
