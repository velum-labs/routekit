import { Clock, Effect } from "effect";

import type { OutputModeValue } from "../../../../contracts/internal/src/cli/output-mode.ts";
import type { UpdateChannel } from "./release-channel.ts";

import { CliIo } from "../../../../contracts/internal/src/cli/cli-io.ts";
import { HostProcess } from "../../../../contracts/internal/src/cli/host-process.ts";
import { resolveEffectiveUpdateChannelForExecutable } from "./effective-channel.ts";
import { isTruthyEnvValue } from "./env-values.ts";
import { classifyUpdateSeverity } from "./release-version.ts";
import {
  isUpdateCheckCacheFresh,
  UPDATE_CHECK_CACHE_STALE_AFTER_MS,
} from "./update-cache.ts";
import { readUpdateCheckState } from "./update-check-state.ts";
import { isUpdateCheckOptedOut } from "./update-notice.ts";
import {
  readCurrentExecutablePath,
  readCurrentReleaseVersion,
} from "./update-runner.ts";

const BANNER_EXCLUDED_COMMANDS = new Set([
  "code",
  "dev",
  "start",
  "tui",
  "update",
  "version",
]);

const updateCommandForChannel = (channel: UpdateChannel | undefined): string =>
  channel === "alpha" ? "routekit-eval update --alpha" : "routekit-eval update";

interface CachedUpdateBannerInput {
  readonly channel: UpdateChannel | undefined;
  readonly cachedChannel: UpdateChannel | undefined;
  readonly checkedAt: string | undefined;
  readonly commandArgs: readonly string[];
  readonly currentVersion: string | null;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly isStdoutTty: boolean;
  readonly latestVersion: string | undefined;
  readonly mode: OutputModeValue;
  readonly now: number;
}

export const cachedUpdateBannerLine = (
  input: CachedUpdateBannerInput
): string | null => {
  const [command] = input.commandArgs;
  const effectiveChannel = input.channel ?? "stable";
  const cachedChannel = input.cachedChannel ?? "stable";
  if (
    input.mode !== "human" ||
    !input.isStdoutTty ||
    isTruthyEnvValue(input.env.CI) ||
    isUpdateCheckOptedOut(input.env) ||
    command === undefined ||
    BANNER_EXCLUDED_COMMANDS.has(command) ||
    input.currentVersion === null ||
    input.latestVersion === undefined ||
    !isUpdateCheckCacheFresh(
      input.checkedAt,
      input.now,
      UPDATE_CHECK_CACHE_STALE_AFTER_MS
    ) ||
    cachedChannel !== effectiveChannel ||
    classifyUpdateSeverity(input.currentVersion, input.latestVersion) === "none"
  ) {
    return null;
  }
  const updateCommand = updateCommandForChannel(input.channel);
  return `Update available: ${input.latestVersion} — run \`${updateCommand}\`\n`;
};

export const emitCachedUpdateBanner = Effect.fn("UpdateBanner.emitCached")(
  function* (
    commandArgs: readonly string[],
    mode: OutputModeValue,
    isStdoutTty: boolean
  ) {
    const hostProcess = yield* HostProcess;
    const env = yield* hostProcess.env;
    const state = yield* readUpdateCheckState();
    const executablePath = readCurrentExecutablePath();
    const currentVersion = yield* readCurrentReleaseVersion(executablePath);
    const channel = yield* resolveEffectiveUpdateChannelForExecutable({
      executablePath,
    });
    const now = yield* Clock.currentTimeMillis;
    const line = cachedUpdateBannerLine({
      channel,
      cachedChannel: state.channel,
      checkedAt: state.checkedAt,
      commandArgs,
      currentVersion,
      env,
      isStdoutTty,
      latestVersion: state.latestVersion,
      mode,
      now,
    });
    if (line !== null) {
      const cliIo = yield* CliIo;
      yield* cliIo.writeStderr(line);
    }
  }
);
