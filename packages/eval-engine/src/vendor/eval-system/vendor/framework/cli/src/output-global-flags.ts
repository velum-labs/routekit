import { Effect, Layer } from "effect";
import { Flag, GlobalFlag } from "effect/unstable/cli";

import type {
  OutputModeValue,
  ResolvedOutputMode,
} from "../../contracts/internal/src/cli/output-mode.ts";

import { CliIo } from "../../contracts/internal/src/cli/cli-io.ts";
import { HostProcess } from "../../contracts/internal/src/cli/host-process.ts";
import {
  ROUTEKIT_EVAL_OUTPUT_ENV,
  OutputMode,
  resolveOutputMode,
} from "../../contracts/internal/src/cli/output-mode.ts";

/**
 * Global `--json` (alias `--agent`) flag: force machine JSON output. A native
 * CLI global flag (RFC 0004), so it is accepted anywhere on the command line
 * and listed under GLOBAL FLAGS in `--help`.
 */
export const JsonOutputFlag = GlobalFlag.setting("output-json")({
  flag: Flag.boolean("json").pipe(
    Flag.withAlias("agent"),
    Flag.withDescription(
      "Force machine JSON output: stdout carries exactly one JSON document, and every notice, log, and diagnostic goes to stderr"
    )
  ),
});

/**
 * Global `--human` (alias `--tty`) flag: force human-readable output. When
 * combined with `--json`, `--json` wins (RFC 0004).
 */
export const HumanOutputFlag = GlobalFlag.setting("output-human")({
  flag: Flag.boolean("human").pipe(
    Flag.withAlias("tty"),
    Flag.withDescription(
      "Force human-readable output. Redirects and pipes are JSON by default, so `routekit-eval eval skill --human > skill.md` is how you capture the text"
    )
  ),
});

export const outputGlobalFlags = [JsonOutputFlag, HumanOutputFlag] as const;

/** The run's output mode, from the parsed global flags, `ROUTEKIT_EVAL_OUTPUT`, and the TTY. */
const resolveCommandOutputMode: Effect.Effect<
  ResolvedOutputMode,
  never,
  | CliIo
  | HostProcess
  | GlobalFlag.Setting.Identifier<"output-json">
  | GlobalFlag.Setting.Identifier<"output-human">
> = Effect.gen(function* () {
  const json = yield* JsonOutputFlag;
  const human = yield* HumanOutputFlag;
  const hostProcess = yield* HostProcess;
  const env = yield* hostProcess.env;
  const cliIo = yield* CliIo;
  // `--json` beats `--human` when both are set (RFC 0004): a deterministic
  // rule instead of positional last-flag-wins semantics.
  let override: OutputModeValue | undefined;
  if (json) {
    override = "json";
  } else if (human) {
    override = "human";
  }
  return resolveOutputMode({
    env: env[ROUTEKIT_EVAL_OUTPUT_ENV],
    isStdoutTty: yield* cliIo.isStdoutTty,
    override,
  });
});

/**
 * Builds the {@link OutputMode} layer for command handlers. The layer also pins
 * the diagnostic stream, so a handler that logs while stdout carries the JSON
 * envelope writes to stderr instead.
 */
export const makeOutputModeLayer = (): Layer.Layer<
  OutputMode,
  never,
  | CliIo
  | HostProcess
  | GlobalFlag.Setting.Identifier<"output-json">
  | GlobalFlag.Setting.Identifier<"output-human">
> =>
  Layer.unwrap(
    resolveCommandOutputMode.pipe(
      Effect.map(({ mode, source }) => OutputMode.layerOf(mode, source))
    )
  );
