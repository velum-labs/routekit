import { Effect, FileSystem, Option } from "effect";
import { Argument, Flag } from "effect/unstable/cli";

import { CliFailureError } from "../../../contracts/internal/src/errors.ts";

// `routekit-eval code` and `routekit-eval tui` share these definitions so their help text and
// parsing stay identical.

export const promptFlag = Flag.string("prompt").pipe(
  Flag.withAlias("p"),
  Flag.withDescription("Initial prompt to run automatically as the first turn"),
  Flag.optional
);

export const promptFileFlag = Flag.string("prompt-file").pipe(
  Flag.withDescription("Read the initial prompt from a file"),
  Flag.optional
);

// Effect CLI does not reject undeclared positional tokens, so capture them
// only to reject them explicitly. They are never interpreted as prompt text.
export const unexpectedArguments = (): Argument.Argument<readonly string[]> =>
  Argument.string("argument").pipe(
    Argument.withDescription(
      "Unexpected positional argument; use --prompt/-p or --prompt-file (see `routekit-eval --help`)"
    ),
    Argument.variadic()
  );

/** The parsed initial-prompt flags shared by `routekit-eval code` and `routekit-eval tui`. */
export interface InitialPromptConfig {
  readonly unexpectedArguments: readonly string[];
  readonly prompt: Option.Option<string>;
  readonly promptFile: Option.Option<string>;
}

// Whitespace-only input is treated as no prompt so a stray `-p ""` opens the
// idle composer rather than dispatching a blank turn. Non-empty text is
// returned unchanged so interior spacing the user typed is preserved.
const normalizePromptText = (raw: string): string | undefined =>
  raw.trim().length === 0 ? undefined : raw;

/**
 * Resolve the single initial prompt from either `--prompt` or `--prompt-file`.
 * Supplying both is ambiguous, so it fails fast rather than silently
 * preferring one.
 */
export const resolveInitialPrompt = Effect.fn("Cli.resolveInitialPrompt")(
  function* (config: InitialPromptConfig, commandName: string) {
    if (config.unexpectedArguments.length > 0) {
      return yield* new CliFailureError({
        detail: `Unexpected positional argument. Use --prompt/-p or --prompt-file with \`${commandName}\` for initial prompt text, or \`routekit-eval --help\` for the command list.`,
        hint: `For example: \`${commandName} -p "add a test"\` or \`${commandName} --prompt-file prompt.txt\`.`,
      });
    }
    if (Option.isSome(config.prompt) && Option.isSome(config.promptFile)) {
      return yield* new CliFailureError({
        detail: "Pass either --prompt/-p or --prompt-file, not both.",
        hint: `For example: \`${commandName} -p "add a test"\` or \`${commandName} --prompt-file prompt.txt\`.`,
      });
    }
    if (Option.isSome(config.prompt)) {
      return normalizePromptText(config.prompt.value);
    }
    if (Option.isSome(config.promptFile)) {
      const filePath = config.promptFile.value;
      const fs = yield* FileSystem.FileSystem;
      const contents = yield* fs.readFileString(filePath).pipe(
        Effect.mapError(
          () =>
            new CliFailureError({
              detail: `Could not read prompt file "${filePath}".`,
              hint: "Check that the path exists and is readable.",
            })
        )
      );
      return normalizePromptText(contents);
    }
  }
);
