import { Context, Effect, Layer, Logger } from "effect";

/** Resolved CLI output mode: human-friendly tables/prose vs. machine JSON. */
type OutputModeValue = "human" | "json";

/**
 * Route Effect's built-in loggers (`Effect.log*`) to stderr in every output
 * mode. Stdout is the command's result channel; diagnostics never belong there.
 *
 * This is a `Context.Reference`, so it travels with whatever context provides
 * it: every handler that receives {@link OutputMode} gets the matching stream
 * for free, rather than each command suppressing its own notices.
 */
const logToStderrLayer = (): Layer.Layer<never> =>
  Layer.succeed(Logger.LogToStderr)(true);

/** Whether the mode was forced by a flag/env, or inferred from the TTY. */
type OutputModeSource = "explicit" | "inferred";

interface ResolvedOutputMode {
  readonly mode: OutputModeValue;
  readonly source: OutputModeSource;
}

interface OutputModeShape {
  readonly mode: OutputModeValue;
  /**
   * Whether {@link OutputModeShape.mode} was forced by `--json`/`--human`/
   * `ORI_OUTPUT` or merely inferred from a non-TTY stdout. A piped caller and a
   * caller that asked for a machine envelope are NOT the same thing: `ori code`
   * runs a headless turn for the former and still refuses the latter.
   */
  readonly source: OutputModeSource;
}

/**
 * Carries the once-resolved output mode for an entire command run. The CLI entry
 * point resolves it from flags/env/TTY (see {@link resolveOutputMode}) and
 * provides it as a layer so any command handler can branch on the mode without
 * re-deriving it. Defaults to `human` for tests and non-CLI callers via
 * {@link OutputMode.human}.
 *
 * The layer also pins the diagnostic stream (see {@link logToStderrLayer}) so
 * stdout remains reserved for command results in both modes.
 */
class OutputMode extends Context.Service<OutputMode, OutputModeShape>()(
  "ori/runtime/OutputMode"
) {
  /**
   * `source` defaults to `"explicit"` so a test (or any caller) that names a
   * mode outright is treated as having forced it; only the CLI entry point,
   * which knows whether it read a flag or a TTY, passes the resolved source.
   */
  static readonly layerOf = (
    mode: OutputModeValue,
    source: OutputModeSource = "explicit"
  ): Layer.Layer<OutputMode> =>
    Layer.succeed(OutputMode)(
      OutputMode.of({
        mode,
        source,
      })
    ).pipe(Layer.merge(logToStderrLayer()));

  static readonly human: Layer.Layer<OutputMode> = OutputMode.layerOf("human");
}

/** Read the resolved mode value from the {@link OutputMode} service. */
const currentOutputMode = Effect.fn("OutputMode.current")(function* () {
  const service = yield* OutputMode;
  return service.mode;
});

/** Environment variable that overrides auto-detection (`json` | `text`). */
const ORI_OUTPUT_ENV = "ORI_OUTPUT";

const ENV_OUTPUT_VALUES: Readonly<Record<string, OutputModeValue>> = {
  human: "human",
  json: "json",
  text: "human",
};

interface ResolveOutputModeInput {
  /** Forced mode from the `--json`/`--human` global flags, highest precedence. */
  readonly override: OutputModeValue | undefined;
  /** Raw `ORI_OUTPUT` env value, second precedence. */
  readonly env: string | undefined;
  /** Whether stdout is a TTY, used for auto-detection when nothing is forced. */
  readonly isStdoutTty: boolean;
}

const parseOutputEnv = (
  value: string | undefined
): OutputModeValue | undefined => {
  if (value === undefined) {
    return undefined;
  }
  return ENV_OUTPUT_VALUES[value.trim().toLowerCase()];
};

/**
 * Resolve the output mode. Precedence (highest first): explicit flag, then
 * `ORI_OUTPUT` env, then auto-detection (human on a TTY, machine when piped).
 */
export const resolveOutputMode = ({
  override,
  env,
  isStdoutTty,
}: ResolveOutputModeInput): ResolvedOutputMode => {
  if (override !== undefined) {
    return {
      mode: override,
      source: "explicit",
    };
  }
  const fromEnv = parseOutputEnv(env);
  if (fromEnv !== undefined) {
    return {
      mode: fromEnv,
      source: "explicit",
    };
  }
  return {
    mode: isStdoutTty ? "human" : "json",
    source: "inferred",
  };
};

export { OutputMode, currentOutputMode, logToStderrLayer, ORI_OUTPUT_ENV };
export type {
  OutputModeValue,
  OutputModeShape,
  OutputModeSource,
  ResolvedOutputMode,
  ResolveOutputModeInput,
};
