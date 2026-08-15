import { Schema } from "effect";

import { CliFailureError } from "../errors.ts";
import { formatUnknownError } from "../../../../utils/core/src/error-formatting.ts";

/**
 * One glyph convention for every line the CLI prints, so a user sees the same
 * vocabulary in `routekit-eval dev` panes and in plain command output. Keep these in sync
 * with the CLI event theme's role glyphs
 * (`framework/cli/src/commands/event-theme.ts`).
 */
export const CliGlyph = {
  Error: "✗",
  Hint: "↳",
  Info: "◇",
  Success: "✔",
  Warning: "⚠",
} as const;

export const formatError = (message: string): string =>
  `${CliGlyph.Error} ${message}`;
export const formatWarning = (message: string): string =>
  `${CliGlyph.Warning} ${message}`;
export const formatInfo = (message: string): string =>
  `${CliGlyph.Info} ${message}`;
export const formatSuccess = (message: string): string =>
  `${CliGlyph.Success} ${message}`;
export const formatHint = (message: string): string =>
  `${CliGlyph.Hint} ${message}`;

/**
 * Render a top-level command failure: the error line, plus — when the failure is
 * a {@link CliFailureError} carrying a `hint` — the concrete next step on its
 * own line. Used by the CLI's outermost handler so every fatal error reads the
 * same and always points the user at what to do next.
 */
export const formatCliFailure = (error: unknown): string => {
  const errorLine = formatError(formatUnknownError(error));
  if (
    Schema.is(CliFailureError)(error) &&
    error.hint !== undefined &&
    error.hint.length > 0
  ) {
    return `${errorLine}\n${formatHint(error.hint)}`;
  }
  return errorLine;
};
