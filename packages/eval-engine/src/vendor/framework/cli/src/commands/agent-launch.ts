import { Effect, Option, pipe, Record } from "effect";
import { Flag, GlobalFlag } from "effect/unstable/cli";

import type { HostProcessExecFailed } from "../../../contracts/internal/src/cli/host-process.ts";
import type { OpenRouterAuthSource } from "../../../contracts/internal/src/openrouter-auth.ts";
import type { AgentHarnessTelemetryId } from "../../../contracts/internal/src/runtime/telemetry-harness.ts";
import type { HarnessInstallKind } from "../harness-install.ts";

import { CliIo } from "../../../contracts/internal/src/cli/cli-io.ts";
import {
  HostProcess,
  HostProcessCommandNotFound,
} from "../../../contracts/internal/src/cli/host-process.ts";
import { CliFailureError } from "../../../contracts/internal/src/errors.ts";
import { RuntimeSecretStore } from "../../../contracts/internal/src/runtime/runtime-secret-store.ts";
import { RuntimeSecretName } from "../../../contracts/internal/src/runtime/services.ts";
import { TelemetryObserver } from "../../../contracts/internal/src/runtime/telemetry-observer.ts";
import { telemetrySurfaceId } from "../../../contracts/internal/src/runtime/telemetry-surface.ts";
import { makePassthroughSplitter } from "../argv-passthrough.ts";
import { ensureOpenRouterCredential } from "./login/login.ts";
import {
  HARNESS_INSTALL_RECIPES,
  harnessInstallHint,
  LAUNCHABLE_HARNESSES,
  offerHarnessInstall,
} from "../harness-install.ts";
import { outputGlobalFlags } from "../output-global-flags.ts";
import { Telemetry } from "../telemetry/telemetry.ts";

export type AgentLaunchKind = HarnessInstallKind;

export interface AgentLaunchConfig {
  readonly kind: AgentLaunchKind;
  readonly globalAuth: boolean;
  readonly model: Option.Option<string>;
  readonly args: readonly string[];
}

/**
 * The flag config shared by `ori claude`, `ori codex`, `ori opencode`, and
 * `ori hermes`. Both `Command.make` calls and {@link splitAgentLaunchArgv}
 * derive from this one object, so adding a flag here automatically teaches the
 * argv splitter about it.
 */
export const agentLaunchFlags = {
  globalAuth: Flag.boolean("global-auth").pipe(
    Flag.withDefault(true),
    Flag.withDescription(
      "Allow inherited and global OpenRouter auth (default: on; use --no-global-auth for workspace-only auth)"
    )
  ),
  model: Flag.string("model").pipe(
    Flag.withDescription("Model to use (any OpenRouter model id)"),
    Flag.optional
  ),
};

/**
 * Cuts `ori claude` / `ori codex` / `ori opencode` / `ori hermes` argv into the
 * prefix Effect CLI parses and the passthrough tail for the launched agent,
 * delivered via {@link PassthroughArgs}. Other argv is returned untouched.
 */
export const splitAgentLaunchArgv = makePassthroughSplitter({
  commands: LAUNCHABLE_HARNESSES,
  flags: agentLaunchFlags,
  globalFlags: [...GlobalFlag.BuiltIns, ...outputGlobalFlags],
});

export const normalizeEnv = (env: NodeJS.ProcessEnv): Record<string, string> =>
  pipe(
    env,
    Record.filter((value): value is string => value !== undefined)
  );

export const formatAuthSource = (source: OpenRouterAuthSource): string => {
  switch (source.kind) {
    case "project": {
      return `project dotenv (${source.location})`;
    }
    case "environment": {
      return "exported environment (OPENROUTER_API_KEY)";
    }
    case "global":
    case "workspace": {
      return source.location;
    }
    default: {
      return source.location;
    }
  }
};

export const resolveOpenRouterKey = Effect.fn(
  "AgentLaunch.resolveOpenRouterKey"
)(function* (input: {
  readonly kind: AgentLaunchKind;
  readonly globalAuth: boolean;
}) {
  const hostProcess = yield* HostProcess;
  const startDir = yield* hostProcess.currentWorkingDirectory;
  const authSource = yield* ensureOpenRouterCredential({
    allowProjectCredentialChoice: true,
    commandName: input.kind,
    mode: input.globalAuth ? "resolvable" : "workspace",
    onNonInteractiveMissing: "fail",
    startDir,
  });
  const cliIo = yield* CliIo;
  if (Option.isSome(authSource) && (yield* cliIo.isStdinTty)) {
    yield* cliIo.writeStderr(
      `Using OpenRouter credential from ${formatAuthSource(authSource.value)}\n`
    );
  }
  const secrets = yield* RuntimeSecretStore;
  const secret = yield* secrets.get(RuntimeSecretName.OpenRouterApiKey);
  if (Option.isNone(secret)) {
    return yield* new CliFailureError({
      detail: `No OpenRouter API key is available for \`ori ${input.kind}\`.`,
    });
  }
  return secret.value;
});

interface ExecAgentInput {
  readonly kind: AgentLaunchKind;
  readonly telemetryId?: AgentHarnessTelemetryId | undefined;
  readonly args: readonly string[];
  readonly env: Record<string, string>;
}

const observeDirectLaunch = Effect.fn("AgentLaunch.observeDirectLaunch")(
  function* (input: {
    readonly telemetryId?: AgentHarnessTelemetryId | undefined;
    readonly observer: TelemetryObserver["Service"];
  }) {
    yield* input.observer.observe("agent_run", {
      harness: input.telemetryId ?? "harness-unknown",
      surface: telemetrySurfaceId("direct"),
    });
    const telemetry = yield* Effect.serviceOption(Telemetry);
    if (Option.isSome(telemetry)) {
      yield* telemetry.value.flush.pipe(
        Effect.timeout("500 millis"),
        Effect.ignore
      );
    }
  }
);

const execOnce = Effect.fn("AgentLaunch.execOnce")(function* (
  input: ExecAgentInput
) {
  const hostProcess = yield* HostProcess;
  // `execve` inherits nothing from the parent, so PATH must carry any bin
  // directory a just-run installer added (see offerHarnessInstall).
  const { PATH = "" } = yield* hostProcess.env;
  const executable = yield* hostProcess.resolveExecutablePath(input.kind);
  if (Option.isNone(executable)) {
    return yield* new HostProcessCommandNotFound({ command: input.kind });
  }
  const observer = yield* Effect.serviceOption(TelemetryObserver);
  if (Option.isSome(observer)) {
    yield* observeDirectLaunch({
      telemetryId: input.telemetryId,
      observer: observer.value,
    });
  }
  return yield* hostProcess.execDestructivelyReplacingCurrentProcess({
    command: input.kind,
    args: input.args,
    env: {
      ...input.env,
      PATH,
    },
  });
});

const launchFailed =
  (
    kind: AgentLaunchKind
  ): ((
    failure: HostProcessExecFailed
  ) => Effect.Effect<never, CliFailureError>) =>
  ({ detail }) =>
    Effect.fail(
      new CliFailureError({
        detail: `Could not launch \`ori ${kind}\`: ${detail}`,
      })
    );

/**
 * The second launch attempt, after an installer reported success. Still missing
 * means the installer put the binary somewhere the recipe's `binDirs` do not
 * name, so PATH never picked it up.
 */
const execAfterInstall = Effect.fn("AgentLaunch.execAfterInstall")(
  function* (input: ExecAgentInput) {
    return yield* execOnce(input);
  },
  (effect, input) =>
    effect.pipe(
      Effect.catchTags({
        HostProcessCommandNotFound: ({ command }) =>
          Effect.fail(
            new CliFailureError({
              detail: `${HARNESS_INSTALL_RECIPES[input.kind].displayName} installed, but \`${command}\` is still not on PATH.`,
              hint: `Open a new shell so it picks up the installer's PATH change, then run \`ori ${input.kind}\` again.`,
            })
          ),
        HostProcessExecFailed: launchFailed(input.kind),
      })
    )
);

/**
 * Replace this process with the launched agent. A missing binary prints the
 * agent's install methods and, on an interactive terminal, offers to run the
 * recommended installer and retry the launch once.
 */
export const execAgent = Effect.fn("AgentLaunch.execAgent")(
  function* (input: ExecAgentInput) {
    return yield* execOnce(input);
  },
  (effect, input) =>
    effect.pipe(
      Effect.catchTags({
        HostProcessCommandNotFound: Effect.fnUntraced(function* ({ command }) {
          const recipe = HARNESS_INSTALL_RECIPES[input.kind];
          const installed = yield* offerHarnessInstall(recipe);
          if (!installed) {
            return yield* new CliFailureError({
              detail: `Could not find \`${command}\` on PATH.`,
              hint: harnessInstallHint(recipe),
            });
          }
          return yield* execAfterInstall(input);
        }),
        HostProcessExecFailed: launchFailed(input.kind),
      })
    )
);
