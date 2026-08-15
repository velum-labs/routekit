import { Data, Effect, FileSystem, Option, Path } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import type { UpdateChannel } from "./release-channel.ts";

import { CliIo } from "../../../../contracts/internal/src/cli/cli-io.ts";
import { CliFailureError } from "../../../../contracts/internal/src/errors.ts";
import { isCompiledCliBuild } from "../../build-info.ts";
import {
  ALPHA_CHANNEL,
  fetchReleaseVersionForChannel,
  makeUpdateFailure,
  ROUTEKIT_EVAL_UPDATE_BASE_URL,
} from "./release-channel.ts";
import { isSameRelease } from "./release-version.ts";

const ROUTEKIT_EVAL_UPDATE_INSTALL_URL = `${ROUTEKIT_EVAL_UPDATE_BASE_URL}/install.sh`;
const ROUTEKIT_EVAL_INSTALL_DIR_ENV = "ROUTEKIT_EVAL_INSTALL_DIR";
/** Env var the installer reads to select a release channel; see `install.sh`. */
const ROUTEKIT_EVAL_CHANNEL_ENV = "ROUTEKIT_EVAL_CHANNEL";
const VERSION_SIDECAR_SUFFIX = ".version";

const BIN_NAME = "routekit-eval";
const SUCCESS_EXIT_CODE = 0;

export interface UpdateInstallResult {
  readonly fromVersion: string | null;
  readonly outcome: "up-to-date" | "applied";
  readonly toVersion: string | undefined;
}

interface RuntimeGlobals {
  readonly process?: {
    readonly argv: readonly string[];
    readonly execPath?: string;
  };
}

/**
 * curl retry options for the installer fetch. `--retry` rides out transient
 * failures (timeouts and HTTP 408/429/500/502/503/504) instead of aborting on
 * the first hiccup, so a flaky CDN 502 no longer hard-fails `routekit-eval update`.
 * `--retry-connrefused` also retries a refused connection, and `--retry-delay`
 * spaces the attempts out.
 */
const INSTALLER_CURL_RETRY_OPTS =
  "--retry 5 --retry-delay 1 --retry-connrefused";

const makeInstallerShellCommand = (): string =>
  `curl -fsSL --proto '=https' ${INSTALLER_CURL_RETRY_OPTS} ${ROUTEKIT_EVAL_UPDATE_INSTALL_URL} | bash`;

const makeInstallerShellArgs = (): readonly string[] => [
  "-o",
  "pipefail",
  "-c",
  makeInstallerShellCommand(),
];

const makeInstallerEnv = (
  installDir?: string,
  channel: UpdateChannel = "stable"
): Record<string, string> | undefined => {
  const channelEnv =
    channel === ALPHA_CHANNEL ? { [ROUTEKIT_EVAL_CHANNEL_ENV]: ALPHA_CHANNEL } : {};
  if (!installDir) {
    // Stable + no install dir: preserve the prior `undefined` contract.
    return channel === ALPHA_CHANNEL ? channelEnv : undefined;
  }
  return {
    [ROUTEKIT_EVAL_INSTALL_DIR_ENV]: installDir,
    ...channelEnv,
  };
};

const versionSidecarPath = (executablePath: string): string =>
  `${executablePath}${VERSION_SIDECAR_SUFFIX}`;

export type UpdateInstallResolution = Data.TaggedEnum<{
  Installed: { readonly installDir: string };
  Repairable: { readonly installDir: string };
  Unmanaged: Record<never, never>;
}>;

export const UpdateInstallResolution =
  Data.taggedEnum<UpdateInstallResolution>();

export const resolveUpdateInstall = Effect.fn(
  "UpdateCommand.resolveUpdateInstall"
)(function* (executablePath: string | undefined) {
  const path = yield* Path.Path;
  if (
    executablePath === undefined ||
    path.basename(executablePath) !== BIN_NAME
  ) {
    return UpdateInstallResolution.Unmanaged();
  }

  const fs = yield* FileSystem.FileSystem;
  const hasVersionSidecar = yield* fs
    .exists(versionSidecarPath(executablePath))
    .pipe(Effect.orElseSucceed(() => false));
  const installDir = path.dirname(executablePath);
  return hasVersionSidecar
    ? UpdateInstallResolution.Installed({ installDir })
    : UpdateInstallResolution.Repairable({ installDir });
});

const resolveUpdateInstallDir = Effect.fn("UpdateCommand.resolveInstallDir")(
  function* (executablePath: string | undefined) {
    const resolution = yield* resolveUpdateInstall(executablePath);
    return UpdateInstallResolution.$is("Installed")(resolution)
      ? resolution.installDir
      : undefined;
  }
);

const readSidecarVersion = Effect.fn("UpdateCommand.readSidecarVersion")(
  function* (executablePath: string | undefined) {
    if (executablePath === undefined) {
      return Option.none<string>();
    }

    const fs = yield* FileSystem.FileSystem;
    const raw = yield* fs
      .readFileString(versionSidecarPath(executablePath))
      .pipe(Effect.option);
    const version = Option.getOrUndefined(raw)?.trim();
    return version === undefined || version.length === 0
      ? Option.none<string>()
      : Option.some(version);
  }
);

const readCurrentReleaseVersion = Effect.fn(
  "UpdateCommand.readCurrentReleaseVersion"
)(function* (executablePath: string | undefined) {
  const sidecarVersion = yield* readSidecarVersion(executablePath);
  if (Option.isSome(sidecarVersion)) {
    return sidecarVersion.value;
  }

  return null;
});

const resolveCurrentExecutablePath = (input: {
  readonly isCompiled: boolean;
  readonly processArgv1: string | undefined;
  readonly processExecPath: string | undefined;
}): string | undefined =>
  input.isCompiled ? input.processExecPath : input.processArgv1;

const readCurrentExecutablePath = (): string | undefined => {
  const globals = globalThis as RuntimeGlobals;
  return resolveCurrentExecutablePath({
    isCompiled: isCompiledCliBuild(),
    processArgv1: globals.process?.argv[1],
    processExecPath: globals.process?.execPath,
  });
};

const runInstaller = Effect.fn("UpdateCommand.runInstaller")(function* (
  installDir: string | undefined,
  channel: UpdateChannel = "stable"
) {
  const installerEnv = makeInstallerEnv(installDir, channel);
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const exitCode = yield* spawner
    .exitCode(
      ChildProcess.make("bash", makeInstallerShellArgs(), {
        extendEnv: true,
        ...(installerEnv ? { env: installerEnv } : {}),
        stderr: "inherit",
        stdin: "inherit",
        stdout: "inherit",
      })
    )
    .pipe(
      Effect.mapError((cause) =>
        makeUpdateFailure("Failed to start RouteKitEval installer", cause)
      )
    );
  if (exitCode !== SUCCESS_EXIT_CODE) {
    return yield* new CliFailureError({
      detail: `RouteKitEval installer exited with code ${exitCode}.`,
      hint: `Re-run \`routekit-eval update\`, or reinstall from ${ROUTEKIT_EVAL_UPDATE_BASE_URL}.`,
    });
  }
});

interface UpdateRunOptions {
  readonly force?: boolean;
  readonly isCompiled?: boolean;
}

const runManagedUpdate = Effect.fn("UpdateCommand.runManagedUpdate")(
  function* (input: {
    readonly channel: UpdateChannel;
    readonly force: boolean;
    readonly fromVersion: string | null;
    readonly installDir: string;
    readonly repairable: boolean;
  }) {
    const { channel, force, fromVersion, installDir, repairable } = input;
    const cliIo = yield* CliIo;
    if (repairable) {
      yield* cliIo.writeStdout(
        "RouteKitEval release metadata is missing. Reinstalling the release to restore it.\n"
      );
    }
    // Best-effort latest-version lookup, fetched once and shared by the
    // up-to-date short-circuit and the applied result's `toVersion` so a single
    // `routekit-eval update` never does the network round-trip twice. Skipped entirely on
    // the force path: a forced reinstall never short-circuits, and neither of its
    // callers needs `toVersion` (a manual `routekit-eval update --force` reports without
    // it; the auto-updater already fetched `latest` before applying, so re-fetching
    // here would regress the ROUTEKIT_EVAL-370 skip documented in
    // `makeProductionAutoUpdateActions`). On any network/parse failure it resolves
    // to `None`, and we fall through to the installer so `routekit-eval update` still repairs
    // a broken install offline-of-the-pointer.
    const latestVersion = yield* force
      ? Effect.succeed(Option.none<string>())
      : fetchReleaseVersionForChannel(channel).pipe(Effect.option);
    // Skip the ~30s full-binary download when the installed release already
    // matches the channel's latest build (ROUTEKIT_EVAL-370). Only an exact match
    // short-circuits; `--force` never short-circuits (its `latestVersion` is
    // always `None`).
    if (
      Option.isSome(latestVersion) &&
      isSameRelease(fromVersion, latestVersion.value)
    ) {
      yield* cliIo.writeStdout(
        channel === ALPHA_CHANNEL
          ? `RouteKitEval is already on the latest alpha release (${latestVersion.value}); skipping download.\n`
          : `RouteKitEval is already on the latest release (${latestVersion.value}); skipping download.\n`
      );
      return {
        fromVersion,
        outcome: "up-to-date",
        toVersion: latestVersion.value,
      } satisfies UpdateInstallResult;
    }
    yield* cliIo.writeStdout(
      channel === ALPHA_CHANNEL
        ? `Updating RouteKitEval from ${ROUTEKIT_EVAL_UPDATE_INSTALL_URL} (alpha channel)...\n`
        : `Updating RouteKitEval from ${ROUTEKIT_EVAL_UPDATE_INSTALL_URL}...\n`
    );
    yield* runInstaller(installDir, channel);
    yield* cliIo.writeStdout(
      channel === ALPHA_CHANNEL
        ? "RouteKitEval is up to date (alpha channel). Run `routekit-eval update --stable` to return to stable.\n"
        : "RouteKitEval is up to date.\n"
    );
    return {
      fromVersion,
      outcome: "applied",
      toVersion: Option.isSome(latestVersion) ? latestVersion.value : undefined,
    } satisfies UpdateInstallResult;
  }
);

export const runUpdateFromExecutablePath = Effect.fn(
  "UpdateCommand.runFromExecutable"
)(function* (
  executablePath: string | undefined,
  channel: UpdateChannel = "stable",
  options: UpdateRunOptions = {}
) {
  const { force = false, isCompiled = isCompiledCliBuild() } = options;
  const fromVersion = yield* readCurrentReleaseVersion(executablePath);
  if (!isCompiled) {
    return yield* new CliFailureError({
      detail:
        "RouteKitEval is running from a source checkout rather than an installed release, so there is nothing for `routekit-eval update` to update. Update the checkout itself instead.",
      hint: "Update the RouteKitEval checkout itself, or install a release build.",
    });
  }
  const resolution = yield* resolveUpdateInstall(executablePath);
  return yield* UpdateInstallResolution.$match(resolution, {
    Unmanaged: () =>
      new CliFailureError({
        detail:
          "Cannot update this RouteKitEval executable because it is not an installer-managed release install. Install from the release channel first.",
        hint: `Install a release build from ${ROUTEKIT_EVAL_UPDATE_BASE_URL}.`,
      }),
    Installed: ({ installDir }) =>
      runManagedUpdate({
        channel,
        force,
        fromVersion,
        installDir,
        repairable: false,
      }),
    Repairable: ({ installDir }) =>
      force
        ? runManagedUpdate({
            channel,
            force,
            fromVersion,
            installDir,
            repairable: true,
          })
        : new CliFailureError({
            detail: `RouteKitEval release metadata is missing in ${installDir}. Run \`routekit-eval update --force\` to reinstall it and restore the metadata.`,
            hint: "Use `routekit-eval update --force` to repair this installation.",
          }),
  });
});

export {
  ROUTEKIT_EVAL_UPDATE_INSTALL_URL,
  ROUTEKIT_EVAL_INSTALL_DIR_ENV,
  ROUTEKIT_EVAL_CHANNEL_ENV,
  VERSION_SIDECAR_SUFFIX,
  makeInstallerShellCommand,
  makeInstallerShellArgs,
  makeInstallerEnv,
  resolveUpdateInstallDir,
  readCurrentReleaseVersion,
  resolveCurrentExecutablePath,
  readCurrentExecutablePath,
};
