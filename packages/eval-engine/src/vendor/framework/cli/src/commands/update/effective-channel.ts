import { Effect, Option } from "effect";

import type { UpdateChannel } from "./release-channel.ts";

import {
  readChannelPreference,
  readEarlyAccessPreference,
} from "./ori-early-access.ts";
import { ALPHA_CHANNEL } from "./release-channel.ts";
import { parseReleaseVersion } from "./release-version.ts";
import { readCurrentReleaseVersion } from "./update-runner.ts";

export interface EffectiveUpdateChannelInput {
  readonly explicit?: UpdateChannel | undefined;
  readonly persistedChannel?: UpdateChannel | undefined;
  readonly persistedPreference?: boolean | undefined;
  readonly installedVersion?: string | null | undefined;
}

/**
 * Resolve the release channel without allowing a prerelease installation to
 * silently fall back to stable. Explicit selection wins, followed by a
 * persisted channel, alpha evidence from the installed release metadata, and
 * then the early-access preference.
 */
export const resolveEffectiveUpdateChannel = (
  input: EffectiveUpdateChannelInput
): UpdateChannel => {
  if (input.explicit !== undefined) {
    return input.explicit;
  }
  if (input.persistedChannel === ALPHA_CHANNEL) {
    return ALPHA_CHANNEL;
  }
  const parsedInstalled =
    input.installedVersion === null || input.installedVersion === undefined
      ? undefined
      : parseReleaseVersion(input.installedVersion);
  if (parsedInstalled?.prerelease[0]?.toLowerCase() === "alpha") {
    return ALPHA_CHANNEL;
  }
  if (input.persistedChannel === "stable") {
    return "stable";
  }
  if (input.persistedPreference === true) {
    return ALPHA_CHANNEL;
  }
  return "stable";
};

/**
 * Resolve the effective channel for an installed executable. Missing or
 * unreadable preference/version metadata intentionally falls through to stable.
 */
export const resolveEffectiveUpdateChannelForExecutable = Effect.fn(
  "UpdateChannel.resolveEffective"
)(function* (input: {
  readonly explicit?: UpdateChannel | undefined;
  readonly executablePath: string | undefined;
}) {
  if (input.explicit !== undefined) {
    return input.explicit;
  }
  const preference = yield* readEarlyAccessPreference();
  const persistedChannel = yield* readChannelPreference();
  const installedVersion = yield* readCurrentReleaseVersion(
    input.executablePath
  );
  return resolveEffectiveUpdateChannel({
    explicit: input.explicit,
    installedVersion,
    persistedChannel: Option.getOrUndefined(persistedChannel),
    persistedPreference: Option.getOrUndefined(preference),
  });
});
