import { Clock, Effect, Option } from "effect";
import { Prompt } from "effect/unstable/cli";
import { ChildProcessSpawner } from "effect/unstable/process";

import type { OutputModeValue } from "../../../../contracts/internal/src/cli/output-mode.ts";
import type { UpdateChannel } from "./release-channel.ts";

import { CliIo } from "../../../../contracts/internal/src/cli/cli-io.ts";
import { HostProcess } from "../../../../contracts/internal/src/cli/host-process.ts";
import { currentOutputMode } from "../../../../contracts/internal/src/cli/output-mode.ts";
import { CliFailureError } from "../../../../contracts/internal/src/errors.ts";
import { RouteKitEvalCliExit } from "../../cli-exit.ts";
import { routeKitEvalChildArgv } from "../dev/split/child-argv.ts";
import {
  resolveEffectiveUpdateChannel,
  resolveEffectiveUpdateChannelForExecutable,
} from "./effective-channel.ts";
import {
  readEarlyAccessPreference,
  recordEarlyAccessPreference,
} from "./routekit-eval-early-access.ts";
import { fetchReleaseVersionForChannel } from "./release-channel.ts";
import { classifyUpdateSeverity } from "./release-version.ts";
import {
  readUpdateCheckState,
  writeUpdateCheckState,
} from "./update-check-state.ts";
import {
  isUpdateCheckOptedOut,
  TUI_UPDATE_CHECK_TIMEOUT,
} from "./update-notice.ts";
import {
  readCurrentExecutablePath,
  readCurrentReleaseVersion,
  resolveUpdateInstallDir,
  runUpdateFromExecutablePath,
} from "./update-runner.ts";
import { makeInteractiveChildCommand } from "../../interactive-child.ts";

/**
 * Set on a child (the relaunched `routekit-eval code` and the spawned `routekit-eval tui`) so it
 * never re-runs the launch-time update check that its parent already ran.
 */
const ROUTEKIT_EVAL_CODE_UPDATE_RELAUNCHED_ENV = "ROUTEKIT_EVAL_CODE_UPDATE_RELAUNCHED";

// `routekit-eval code` is always argv[2]+ (node, the CLI entry, then the command); `routeKitEvalChildArgv` rebuilds the executable
// prefix, so we forward only the passthrough tail to relaunch the same command.
const RELAUNCH_PASSTHROUGH_ARGV_START = 2;

type CodeUpdateSelection = "always" | "not-now" | "update-now";

interface CodeUpdateDecision {
  readonly autoUpdateOnCodeLaunch: boolean;
  readonly updateNow: boolean;
}

/**
 * Map the launch-time preference (and the interactive selection, when present)
 * to what the launcher should do: whether to apply the update now and whether
 * to persist the always-auto-update preference. A recorded `autoUpdateOnCodeLaunch`
 * preference applies without a selection; otherwise the three-way choice decides.
 */
export const codeUpdateDecision = (
  autoUpdateOnCodeLaunch: boolean,
  selection?: CodeUpdateSelection
): CodeUpdateDecision => {
  if (autoUpdateOnCodeLaunch || selection === "always") {
    return {
      autoUpdateOnCodeLaunch: true,
      updateNow: true,
    };
  }
  return {
    autoUpdateOnCodeLaunch: false,
    updateNow: selection === "update-now",
  };
};

interface ShouldCheckForCodeUpdateInput {
  readonly commandArgs: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly isStdinTty: boolean;
  readonly isStdoutTty: boolean;
  readonly mode: OutputModeValue;
}

/**
 * Whether an `routekit-eval code` launch should run the interactive update check: only
 * for the `code` command itself, on an interactive human terminal, when the
 * user has not opted out and this process is not a guarded relaunch/child.
 */
export const shouldCheckForCodeUpdate = (
  input: ShouldCheckForCodeUpdateInput
): boolean =>
  input.commandArgs[0] === "code" &&
  input.mode === "human" &&
  input.isStdinTty &&
  input.isStdoutTty &&
  !isUpdateCheckOptedOut(input.env) &&
  input.env[ROUTEKIT_EVAL_CODE_UPDATE_RELAUNCHED_ENV] !== "1";

/**
 * Resolve the launch-time channel from the persisted preference and the
 * installed executable's release metadata.
 */
export const resolveEarlyAccessChannel = (
  preference: Option.Option<boolean>,
  installedVersion?: string | null
): UpdateChannel =>
  resolveEffectiveUpdateChannel({
    installedVersion,
    persistedPreference: Option.getOrUndefined(preference),
  });

const resolveEarlyAccessAndChannel = Effect.fn("CodeUpdate.earlyAccess")(
  function* (interactive: boolean, executablePath: string | undefined) {
    const preference = yield* readEarlyAccessPreference();
    if (Option.isSome(preference) || !interactive) {
      return yield* resolveEffectiveUpdateChannelForExecutable({
        executablePath,
      });
    }
    const join = yield* Prompt.confirm({
      message: "Join early access (alpha) releases?",
    });
    yield* recordEarlyAccessPreference(join).pipe(Effect.ignore);
    return yield* resolveEffectiveUpdateChannelForExecutable({
      executablePath,
    });
  }
);

const promptCodeUpdateSelection = Effect.fn("CodeUpdate.prompt")(function* (
  latestVersion: string
) {
  return yield* Prompt.select<CodeUpdateSelection>({
    choices: [
      {
        title: "Update now",
        value: "update-now",
      },
      {
        title: "Not now",
        value: "not-now",
      },
      {
        title: "Always auto-update on launch",
        value: "always",
      },
    ],
    message: `RouteKitEval ${latestVersion} is available. Update before launching?`,
  });
});

const persistObservedLatest = Effect.fn("CodeUpdate.persist")(
  function* (input: {
    readonly autoUpdateOnCodeLaunch: boolean;
    readonly channel: UpdateChannel;
    readonly latestVersion: string;
  }) {
    const now = yield* Clock.currentTimeMillis;
    yield* writeUpdateCheckState({
      autoUpdateOnCodeLaunch: input.autoUpdateOnCodeLaunch,
      channel: input.channel,
      checkedAt: new Date(now).toISOString(),
      latestVersion: input.latestVersion,
    }).pipe(Effect.ignore);
  }
);

const relaunchRouteKitEvalCode = Effect.fn("CodeUpdate.relaunch")(function* () {
  const hostProcess = yield* HostProcess;
  const env = yield* hostProcess.env;
  const argv = routeKitEvalChildArgv(
    process.argv.slice(RELAUNCH_PASSTHROUGH_ARGV_START)
  );
  if (argv.length === 0) {
    return yield* new CliFailureError({
      detail:
        "Could not relaunch `routekit-eval code` after updating: no executable command was available.",
    });
  }
  const [command, ...args] = argv;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const exitCode = yield* spawner.exitCode(
    makeInteractiveChildCommand(command, args, {
      env: {
        ...env,
        [ROUTEKIT_EVAL_CODE_UPDATE_RELAUNCHED_ENV]: "1",
      },
    })
  );
  // Mirror the dev dependency-install re-exec: carry the child's exact code out
  // through `RouteKitEvalCliExit` so runtime teardown applies it after finalizers run.
  return yield* new RouteKitEvalCliExit({ exitCode: Number(exitCode) });
});

const applyCodeUpdate = Effect.fn("CodeUpdate.apply")(function* (input: {
  readonly autoPref: boolean;
  readonly channel: UpdateChannel;
  readonly executablePath: string | undefined;
  readonly latestVersion: string;
}) {
  // The caller's gate requires an interactive terminal, so the prompt (shown
  // only when there is no recorded preference) always runs on a TTY that can
  // render it.
  const selection = input.autoPref
    ? undefined
    : yield* promptCodeUpdateSelection(input.latestVersion);
  const decision = codeUpdateDecision(input.autoPref, selection);
  if (decision.autoUpdateOnCodeLaunch !== input.autoPref) {
    yield* persistObservedLatest({
      autoUpdateOnCodeLaunch: decision.autoUpdateOnCodeLaunch,
      channel: input.channel,
      latestVersion: input.latestVersion,
    });
  }
  if (!decision.updateNow) {
    return;
  }
  const cliIo = yield* CliIo;
  yield* cliIo
    .writeStdout(`Updating RouteKitEval to ${input.latestVersion} before launch...\n`)
    .pipe(Effect.ignore);
  yield* runUpdateFromExecutablePath(input.executablePath, input.channel, {});
  return yield* relaunchRouteKitEvalCode();
});

/**
 * Best-effort launch-time update flow for `routekit-eval code`, run before booting the
 * daemon and spawning the chat TUI. It checks the effective channel once, offers
 * the interactive choice (or auto-applies a recorded preference), applies the
 * update, and relaunches the original command on the fresh binary. It continues
 * silently into the session for source checkouts, opt-outs, network failures,
 * and the non-interactive case.
 */
export const runCodeUpdateLaunch = Effect.fn("CodeUpdate.run")(function* () {
  const hostProcess = yield* HostProcess;
  const env = yield* hostProcess.env;
  if (
    isUpdateCheckOptedOut(env) ||
    env[ROUTEKIT_EVAL_CODE_UPDATE_RELAUNCHED_ENV] === "1"
  ) {
    return;
  }

  const cliIo = yield* CliIo;
  const isStdinTty = yield* cliIo.isStdinTty;
  const isStdoutTty = yield* cliIo.isStdoutTty;
  const mode = yield* currentOutputMode();
  const interactive = shouldCheckForCodeUpdate({
    commandArgs: ["code"],
    env,
    isStdinTty,
    isStdoutTty,
    mode,
  });

  if (!interactive) {
    return;
  }

  const state = yield* readUpdateCheckState();
  const autoPref = state.autoUpdateOnCodeLaunch;

  const executablePath = readCurrentExecutablePath();
  const installDir = yield* resolveUpdateInstallDir(executablePath);
  if (installDir === undefined) {
    return;
  }

  yield* hostProcess.setEnv(ROUTEKIT_EVAL_CODE_UPDATE_RELAUNCHED_ENV, "1");

  const channel = yield* resolveEarlyAccessAndChannel(
    interactive,
    executablePath
  );
  const latestVersion = yield* fetchReleaseVersionForChannel(channel).pipe(
    Effect.timeout(TUI_UPDATE_CHECK_TIMEOUT),
    Effect.orElseSucceed((): string | null => null)
  );
  if (latestVersion === null) {
    return;
  }
  yield* persistObservedLatest({
    autoUpdateOnCodeLaunch: autoPref,
    channel,
    latestVersion,
  });

  const currentVersion = yield* readCurrentReleaseVersion(executablePath);
  if (classifyUpdateSeverity(currentVersion, latestVersion) === "none") {
    return;
  }

  return yield* applyCodeUpdate({
    autoPref,
    channel,
    executablePath,
    latestVersion,
  });
});

export { ROUTEKIT_EVAL_CODE_UPDATE_RELAUNCHED_ENV };
export type { CodeUpdateDecision, CodeUpdateSelection };
