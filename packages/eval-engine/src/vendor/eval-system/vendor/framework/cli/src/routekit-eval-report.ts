import { layer as nodeServicesLayer } from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";

import type { OutputModeValue } from "../../contracts/internal/src/cli/output-mode.ts";

import { CliIo } from "../../contracts/internal/src/cli/cli-io.ts";
import { formatCliFailure } from "../../contracts/internal/src/cli/cli-messages.ts";
import {
  renderErrorEnvelope,
  toEnvelopeError,
} from "../../contracts/internal/src/cli/cli-output.ts";
import { HostProcess } from "../../contracts/internal/src/cli/host-process.ts";
import {
  ROUTEKIT_EVAL_OUTPUT_ENV,
  resolveOutputMode,
} from "../../contracts/internal/src/cli/output-mode.ts";
import { CliIoLive } from "../../engine/runtime-io/src/cli-io.ts";
import { HostProcessLive } from "../../engine/runtime-io/src/host-process.ts";

const FAILURE_EXIT_CODE = 1;

const OUTPUT_GLOBAL_FLAG_NAMES = new Set([
  "--json",
  "--agent",
  "--human",
  "--tty",
]);

/** Drops the leading `--json`/`--agent`/`--human`/`--tty` tokens so callers see
 * the real command that follows them. */
export const stripLeadingOutputGlobalFlags = (
  argv: readonly string[]
): readonly string[] => {
  const booleanLiterals = new Set([
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

  let start = 0;
  while (
    start < argv.length &&
    OUTPUT_GLOBAL_FLAG_NAMES.has(argv[start] ?? "")
  ) {
    start += 1;
    const next = argv[start];
    if (next !== undefined && booleanLiterals.has(next)) {
      start += 1;
    }
  }
  return argv.slice(start);
};

// The `--json`/`--human` global flags may themselves fail to parse (a bad flag
// is exactly what this reporter handles), so the flag-settings layer that the
// per-command OutputMode consumes is unavailable here. Re-derive the override
// from the raw argv instead: `--json`/`--agent` force machine output and win
// over `--human`/`--tty` (RFC 0004). Stop at `--`: anything past the passthrough
// cut belongs to a launched tool, not RouteKitEval's own output mode.
export const outputOverrideFromArgv = (
  argv: readonly string[]
): OutputModeValue | undefined => {
  let override: OutputModeValue | undefined;
  for (const token of argv) {
    if (token === "--") {
      break;
    }
    if (token === "--json" || token === "--agent") {
      return "json";
    }
    if (token === "--human" || token === "--tty") {
      override = "human";
    }
  }
  return override;
};

export const resolveBootstrapOutputMode = Effect.fn(
  "RouteKitEvalCli.bootstrapOutputMode"
)(function* (argv: readonly string[]) {
  const cliIo = yield* CliIo;
  const hostProcess = yield* HostProcess;
  const env = yield* hostProcess.env;
  return resolveOutputMode({
    env: env[ROUTEKIT_EVAL_OUTPUT_ENV],
    isStdoutTty: yield* cliIo.isStdoutTty,
    override: outputOverrideFromArgv(argv),
  }).mode;
});

// Reports a failure that escaped before (or instead of) a command handler's own
// reporting: bad global flags, layer construction, defects. Mirrors the
// handler-level `reportCommandFailure` output-mode contract — a JSON envelope on
// stdout for machine callers, a human line on stderr otherwise — so a
// piped/non-TTY or `--json` caller still receives the promised error envelope.
// `command` is the envelope label. Every caller resolves it against the
// registered subcommand tree, so positional prompt words never reach the
// envelope; argv is only read here to pick the output mode.
export const reportRouteKitEvalCliBootstrapFailure = Effect.fn(
  "RouteKitEvalCli.reportBootstrapFailure"
)(function* (error: unknown, argv: readonly string[], command: string) {
  const cliIo = yield* CliIo;
  const mode = yield* resolveBootstrapOutputMode(argv);
  yield* (
    mode === "json"
      ? cliIo.writeStdout(renderErrorEnvelope(command, toEnvelopeError(error)))
      : cliIo.writeStderr(`${formatCliFailure(error)}\n`)
  ).pipe(Effect.ignore);
  return FAILURE_EXIT_CODE;
});

// `CliIo`/`HostProcess` back the mode-aware bootstrap reporter; both live layers
// read process globals and cannot fail to build, so they are a safe last resort
// at the outer `runMain` edge, outside the command's `routeKitEvalCliLayer` scope.
export const bootstrapReportingLayer = Layer.mergeAll(
  nodeServicesLayer,
  HostProcessLive,
  CliIoLive.pipe(Layer.provide(nodeServicesLayer))
);
