import type { Crypto, FileSystem, Path, Stdio, Terminal } from "effect";
import type { Environment } from "effect/unstable/cli/Prompt";
import type { HttpClient } from "effect/unstable/http";

import { Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcessSpawner } from "effect/unstable/process";

import type { CliIo } from "../../../../contracts/internal/src/cli/cli-io.ts";
import type { CliOutputAlreadyReported } from "../../../../contracts/internal/src/cli/cli-output.ts";
import type { OutputMode } from "../../../../contracts/internal/src/cli/output-mode.ts";
import type { RuntimeSecretStore } from "../../../../contracts/internal/src/runtime/runtime-secret-store.ts";
import type { FeatureRuntime } from "../../../../runloop/local/src/feature-runtime/service.ts";
import type { RouteKitEvalCliExit } from "../../cli-exit.ts";
import type {
  CodeLaunch,
  CodeOutputFormat,
} from "./one-shot-launch.ts";
import type {
  CodeCommandConfig,
  CodeSessionInputs,
} from "./session-config.ts";
import type {
  DevCommandRuntimeOptions,
  HeadlessRuntimeSessionConfig,
} from "../dev/session-support.ts";
import type { RouteKitEvalDirectory } from "../../routekit-eval-directory.ts";

import { HostProcess } from "../../../../contracts/internal/src/cli/host-process.ts";
import { ROUTEKIT_EVAL_PERSONA_ENV } from "../../../../contracts/internal/src/cli/intern-launcher-env.ts";
import { CliFailureError } from "../../../../contracts/internal/src/errors.ts";
import { reportCommandFailure } from "../../command-failure.ts";
import {
  CODE_OUTPUT_FORMATS,
  resolveCodeLaunch,
} from "./one-shot-launch.ts";
import {
  bootCodeSession,
  runCodeHeadlessSession,
} from "./session-boot.ts";
import {
  codeCredentialMode,
  codeHeadlessConfig,
  codeTuiChildArgs,
  resolveResumeSessionId,
} from "./session-config.ts";
import { DEFAULT_DAEMON_HOST } from "../dev/session-support.ts";
import { routeKitEvalChildArgv } from "../dev/split/child-argv.ts";
import { ensureGlobalWorkspaceForCode } from "../init/global-workspace.ts";
import {
  promptFlag,
  promptFileFlag,
  resolveInitialPrompt,
  unexpectedArguments,
} from "../initial-prompt.ts";
import { ensureGatewayCredential } from "../login/login.ts";
import { runCodeUpdateLaunch } from "../update/code-update-launch.ts";
import { makeInteractiveChildCommand } from "../../interactive-child.ts";

const hostFlag = Flag.string("host").pipe(
  Flag.withDescription("Host to bind the coding runtime to"),
  Flag.withDefault(DEFAULT_DAEMON_HOST)
);

const portFlag = Flag.integer("port").pipe(
  Flag.withDescription(
    "Port to bind the coding runtime to (default: random open port)"
  ),
  Flag.optional
);

// `routekit-eval code` has no model registry of its own, so `--model` is forwarded to the
// child `routekit-eval tui`, which threads it into each turn's invoke. Without it the
// runtime's built-in default model is used.
const modelFlag = Flag.string("model").pipe(
  Flag.withDescription(
    "Model ID to use for turns (Gateway slug, e.g. anthropic/claude-sonnet-4.6)"
  ),
  Flag.optional
);

// `routekit-eval code` has no harness registry of its own, so `--harness` is forwarded to
// the child `routekit-eval tui`, which threads it into each turn's invoke (same as the
// in-TUI `/harness` picker). Without it the runtime's default harness is used.
const harnessFlag = Flag.string("harness").pipe(
  Flag.withDescription("Harness to run turns with (e.g. pi, claude)"),
  Flag.optional
);

// `routekit-eval code` is meant to "just work" in any local repo, so it allows global auth
// by DEFAULT — the inverse of `routekit-eval dev`, which defaults to workspace-only auth.
// A plain repo has no repo-local `.routekit-eval/credentials.json`, so workspace-only auth
// would fail there. `Flag.withDefault(true)` exposes `--no-global-auth` to opt
// back into strict workspace auth for users who keep a repo-local key. The
// flag→mode mapping (and its rationale) lives in `codeCredentialMode`.
const globalAuthFlag = Flag.boolean("global-auth").pipe(
  Flag.withDefault(true),
  Flag.withDescription(
    "Allow ROUTEKIT_EVAL_BEARER_TOKEN and global ~/.routekit-eval/credentials.json (default: on; use --no-global-auth for workspace-only auth)"
  )
);

// `routekit-eval code` writes durable per-session metadata sidecars under the launch
// cwd's `.routekit-eval/logs/sessions/`, so the latest one is resolvable from disk before
// the daemon boots. The chat layer's missing-session fallback transparently
// starts fresh if the harness can no longer honor it.
const resumeFlag = Flag.boolean("resume").pipe(
  Flag.withDefault(false),
  Flag.withDescription(
    "Resume the most recent chat session started in this directory"
  )
);

const sessionFlag = Flag.string("session").pipe(
  Flag.withDescription(
    "Resume a specific chat session by id (see `routekit-eval sessions`)"
  ),
  Flag.optional
);

// `text` prints the assistant's answer in one write (the default); `jsonl` streams
// every runtime event as NDJSON with a terminal result line carrying the
// session id, for machine callers (RFC 0004 code.md "Structured output").
const outputFlag = Flag.choice("output", CODE_OUTPUT_FORMATS).pipe(
  Flag.withDefault("text" as CodeOutputFormat),
  Flag.withDescription(
    "Headless output format: text (assistant prose) or jsonl (runtime events + terminal result line)"
  )
);

// Exported so a focused test can assert the TUI is spawned attached to the
// terminal's foreground process group (`detached: false`) — the property
// SIGWINCH delivery, and thus live resize reflow, depends on.
const attachCodeTui = Effect.fn("CodeCommand.attachTui")(function* (input: {
  readonly daemon: { readonly host: string; readonly port: number };
  readonly harness?: string | undefined;
  readonly launchCwd: string;
  readonly model?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly workspaceRoot: string;
}) {
  const hostProcess = yield* HostProcess;
  const childEnv = yield* hostProcess.env;
  const argv = routeKitEvalChildArgv(
    codeTuiChildArgs({
      cwd: input.launchCwd,
      harness: input.harness,
      host: input.daemon.host,
      port: input.daemon.port,
      model: input.model,
      sessionId: input.sessionId,
    })
  );
  if (argv.length === 0) {
    return yield* new CliFailureError({
      detail:
        "Could not launch `routekit-eval tui`: no executable command was available.",
    });
  }
  const [command, ...args] = argv;

  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  // `routekit-eval tui` is the interactive foreground UI — it must stay in this terminal's
  // foreground process group (`detached: false`) so the kernel delivers SIGWINCH
  // to it and the chat layout reflows live on resize. See makeInteractiveChildCommand.
  const exitCode = yield* spawner.exitCode(
    makeInteractiveChildCommand(command, args, {
      cwd: input.workspaceRoot,
      env: {
        ...childEnv,
        ROUTEKIT_EVAL_TELEMETRY_SURFACE: "code",
      },
    })
  );
  if (Number(exitCode) !== 0) {
    return yield* new CliFailureError({
      detail: `\`routekit-eval tui\` exited with code ${Number(exitCode)}.`,
      hint: "Run `routekit-eval code` again to restart the daemon and UI.",
    });
  }
});

const runCodeScopedSession = Effect.fn("CodeCommand.scopedSession")(function* (
  options: DevCommandRuntimeOptions,
  inputs: CodeSessionInputs,
  session: HeadlessRuntimeSessionConfig
) {
  const boot = yield* bootCodeSession(options, session, { attachedTui: true });

  return yield* attachCodeTui({
    daemon: boot.daemon,
    harness: inputs.harness,
    launchCwd: inputs.launchCwd,
    model: inputs.model,
    sessionId: inputs.sessionId,
    workspaceRoot: boot.workspaceRoot,
  });
});

const runCodeSingleTuiSession = Effect.fn("CodeCommand.singleTuiSession")(
  function* (
    options: DevCommandRuntimeOptions,
    inputs: CodeSessionInputs,
    launch: Exclude<CodeLaunch, { readonly kind: "tui" }>
  ) {
    const session = codeHeadlessConfig(inputs);
    return yield* Effect.scoped(
      runCodeHeadlessSession({
        harness: inputs.harness,
        launchCwd: inputs.launchCwd,
        model: inputs.model,
        options,
        output: launch.kind,
        prompt: launch.prompt,
        session,
        sessionId: inputs.sessionId,
      })
    );
  }
);

const runCodeCommand = Effect.fn("CodeCommand.run")(function* (
  options: DevCommandRuntimeOptions,
  config: CodeCommandConfig
) {
  const hostProcess = yield* HostProcess;
  const launchCwd = yield* hostProcess.currentWorkingDirectory;

  // Prompt validation and file reads run before the update check and credential
  // resolver, so malformed input does not drag the user through an update or
  // interactive login first.
  const initialPrompt = yield* resolveInitialPrompt(config, "routekit-eval code");

  // Also the prompt-less fail-fast gate for machine-mode and piped launches
  // (RFC 0004 code.md), so nothing below runs for a doomed launch.
  const launch = yield* resolveCodeLaunch({
    output: config.output,
    prompt: initialPrompt,
  });

  // Headless-only product: there is no TUI update prompt.

  // On a TTY with nothing found, this runs the same interactive login `routekit-eval
  // login` would, so a single `routekit-eval login` lets `routekit-eval code` run anywhere.
  const authSource = yield* ensureGatewayCredential({
    commandName: "code",
    mode: codeCredentialMode(config.globalAuth),
    onNonInteractiveMissing: "fail",
    startDir: launchCwd,
  });

  // `routekit-eval code` boots against the global workspace (`~/.routekit-eval/global/features`), so
  // the user's own global features (and their dependencies) stay live — scaffold
  // it on first run if it does not exist yet. The coding persona is NOT written
  // into that workspace; it is loaded as a built-in contribution overlaid at boot
  // (see `BuiltInPromptCatalog`), gated on `ROUTEKIT_EVAL_PERSONA=code`. Each chat turn runs
  // in `launchCwd`, so the agent still acts on the user's actual project.
  const sessionId = yield* resolveResumeSessionId(config, launchCwd);

  const featuresRoot = yield* ensureGlobalWorkspaceForCode();
  yield* hostProcess.setEnv(ROUTEKIT_EVAL_PERSONA_ENV, "code");
  const inputs: CodeSessionInputs = {
    authSource,
    featuresRoot,
    ...(Option.isSome(config.harness) ? { harness: config.harness.value } : {}),
    host: config.host,
    launchCwd,
    ...(Option.isSome(config.model) ? { model: config.model.value } : {}),
    port: config.port,
    ...(sessionId === undefined ? {} : { sessionId }),
  };
  return yield* runCodeSingleTuiSession(options, inputs, launch);
});

const makeCodeCommand = (
  options: DevCommandRuntimeOptions
): Command.Command<
  "code",
  {
    readonly globalAuth: boolean;
    readonly harness: Option.Option<string>;
    readonly host: string;
    readonly model: Option.Option<string>;
    readonly output: CodeOutputFormat;
    readonly port: Option.Option<number>;
    readonly prompt: Option.Option<string>;
    readonly promptFile: Option.Option<string>;
    readonly unexpectedArguments: readonly string[];
    readonly resume: boolean;
    readonly session: Option.Option<string>;
  },
  Record<string, never>,
  CliOutputAlreadyReported | RouteKitEvalCliExit | Terminal.QuitError,
  | ChildProcessSpawner.ChildProcessSpawner
  | CliIo
  | Crypto.Crypto
  | Environment
  | FeatureRuntime
  | FileSystem.FileSystem
  | HostProcess
  | HttpClient.HttpClient
  | RouteKitEvalDirectory
  | OutputMode
  | Path.Path
  | RuntimeSecretStore
  | Stdio.Stdio
> =>
  Command.make(
    "code",
    {
      globalAuth: globalAuthFlag,
      harness: harnessFlag,
      host: hostFlag,
      model: modelFlag,
      output: outputFlag,
      port: portFlag,
      prompt: promptFlag,
      promptFile: promptFileFlag,
      unexpectedArguments: unexpectedArguments(),
      resume: resumeFlag,
      session: sessionFlag,
    },
    (config) =>
      runCodeCommand(options, config).pipe(reportCommandFailure("code"))
  ).pipe(
    Command.withDescription(
      "Run RouteKitEval as a local coding agent in the current directory"
    )
  );

export { attachCodeTui, makeCodeCommand };
