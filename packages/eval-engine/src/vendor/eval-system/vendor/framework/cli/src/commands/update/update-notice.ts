import { Clock, Effect } from "effect";

import type { UpdateNotice } from "../../../../contracts/author/src/chat.ts";
import type { UpdateChannel } from "./release-channel.ts";
import type { UpdateSeverity } from "./release-version.ts";

import { HostProcess } from "../../../../contracts/internal/src/cli/host-process.ts";
import { resolveEffectiveUpdateChannelForExecutable } from "./effective-channel.ts";
import { ROUTEKIT_EVAL_NO_UPDATE_CHECK_ENV } from "./routekit-eval-config.ts";
import { fetchReleaseVersionForChannel } from "./release-channel.ts";
import { classifyUpdateSeverity } from "./release-version.ts";
import {
  isUpdateCheckCacheFresh,
  VERSION_UPDATE_CHECK_CACHE_STALE_AFTER_MS,
} from "./update-cache.ts";
import {
  readUpdateCheckState,
  writeUpdateCheckState,
} from "./update-check-state.ts";
import {
  readCurrentExecutablePath,
  readCurrentReleaseVersion,
  resolveUpdateInstallDir,
} from "./update-runner.ts";

const TUI_UPDATE_CHECK_TIMEOUT = "5 seconds";

const isUpdateCheckOptedOut = (
  env: Readonly<Record<string, string | undefined>>
): boolean => {
  const value = env[ROUTEKIT_EVAL_NO_UPDATE_CHECK_ENV];
  if (value === undefined) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false";
};

export interface UpdateCheckStatus {
  readonly channel: UpdateChannel;
  readonly currentVersion: string;
  readonly latestVersion: string;
  readonly severity: UpdateSeverity;
}

interface UpdateCheckContext {
  readonly channel: UpdateChannel;
  readonly currentVersion: string;
}

const resolveUpdateCheckContext = Effect.fn("UpdateNotice.resolveCheckContext")(
  function* (input: {
    readonly channel?: UpdateChannel | undefined;
    readonly executablePath: string | undefined;
  }) {
    const hostProcess = yield* HostProcess;
    const env = yield* hostProcess.env;
    if (isUpdateCheckOptedOut(env)) {
      return null;
    }

    const installDir = yield* resolveUpdateInstallDir(input.executablePath);
    if (installDir === undefined) {
      return null;
    }

    const currentVersion = yield* readCurrentReleaseVersion(
      input.executablePath
    );
    if (currentVersion === null) {
      return null;
    }

    const channel = yield* resolveEffectiveUpdateChannelForExecutable({
      executablePath: input.executablePath,
      explicit: input.channel,
    });
    return {
      channel,
      currentVersion,
    } satisfies UpdateCheckContext;
  }
);

const statusFromLatestVersion = (
  context: UpdateCheckContext,
  latestVersion: string
): UpdateCheckStatus => ({
  currentVersion: context.currentVersion,
  latestVersion,
  severity: classifyUpdateSeverity(context.currentVersion, latestVersion),
  channel: context.channel,
});

const fetchUpdateStatus = Effect.fn("UpdateNotice.fetchStatus")(function* (
  context: UpdateCheckContext
) {
  const latestVersion = yield* fetchReleaseVersionForChannel(
    context.channel
  ).pipe(
    Effect.timeout(TUI_UPDATE_CHECK_TIMEOUT),
    Effect.orElseSucceed((): string | null => null)
  );
  if (latestVersion === null) {
    return null;
  }

  return statusFromLatestVersion(context, latestVersion);
});

export const checkUpdateStatusForExecutable = Effect.fn(
  "UpdateNotice.checkStatusForExecutable"
)(function* (input: {
  readonly channel?: UpdateChannel | undefined;
  readonly executablePath: string | undefined;
}) {
  const context = yield* resolveUpdateCheckContext(input);
  if (context === null) {
    return null;
  }
  return yield* fetchUpdateStatus(context);
});

export const checkVersionUpdateStatusForExecutable = Effect.fn(
  "UpdateNotice.checkVersionStatusForExecutable"
)(function* (input: {
  readonly channel?: UpdateChannel | undefined;
  readonly executablePath: string | undefined;
}) {
  const context = yield* resolveUpdateCheckContext(input);
  if (context === null) {
    return null;
  }

  const state = yield* readUpdateCheckState();
  const now = yield* Clock.currentTimeMillis;
  const cachedChannel = state.channel ?? "stable";
  const cacheHit =
    state.latestVersion !== undefined &&
    cachedChannel === context.channel &&
    isUpdateCheckCacheFresh(
      state.checkedAt,
      now,
      VERSION_UPDATE_CHECK_CACHE_STALE_AFTER_MS
    );
  if (cacheHit) {
    return statusFromLatestVersion(context, state.latestVersion);
  }

  const status = yield* fetchUpdateStatus(context);
  if (status !== null) {
    yield* writeUpdateCheckState({
      ...state,
      channel: status.channel,
      checkedAt: new Date(now).toISOString(),
      latestVersion: status.latestVersion,
    }).pipe(Effect.ignore);
  }
  return status;
});

const checkTuiUpdateNoticeForExecutable = Effect.fn(
  "UpdateNotice.checkTuiForExecutable"
)(function* (input: {
  readonly channel?: UpdateChannel | undefined;
  readonly executablePath: string | undefined;
}) {
  const status = yield* checkUpdateStatusForExecutable(input);
  if (status === null || status.severity === "none") {
    return null;
  }
  return {
    currentVersion: status.currentVersion,
    latestVersion: status.latestVersion,
    severity: status.severity,
  } satisfies UpdateNotice;
});

export const checkTuiUpdateNotice = Effect.fn("UpdateNotice.checkTui")(
  function* (channel?: UpdateChannel) {
    return yield* checkTuiUpdateNoticeForExecutable({
      channel,
      executablePath: readCurrentExecutablePath(),
    });
  }
);

export {
  checkTuiUpdateNoticeForExecutable,
  isUpdateCheckOptedOut,
  TUI_UPDATE_CHECK_TIMEOUT,
};
