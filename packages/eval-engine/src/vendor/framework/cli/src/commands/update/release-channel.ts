import { Effect, Schedule, Schema } from "effect";
import { HttpClient } from "effect/unstable/http";

import { CliFailureError } from "../../../../contracts/internal/src/errors.ts";
import { parseReleaseVersion } from "./release-version.ts";
import { formatUnknownError } from "../../../../utils/core/src/error-formatting.ts";

const ORI_UPDATE_BASE_URL = "https://openrouter.ai/labs/ori";
const ORI_UPDATE_VERSION_URL = `${ORI_UPDATE_BASE_URL}/version`;
/**
 * Alpha (pre-release) channel version pointer. It lives on the mirror's default
 * branch (raw content), NOT behind the `openrouter.ai/labs/ori/*` proxy — the
 * proxy only serves the non-prerelease `latest` release and structurally cannot
 * reach prereleases. Kept in lockstep with `install-config.ts`
 * (`rawContentBase` + `alphaVersionPointerName`) and `install.sh`'s alpha path.
 */
const ORI_UPDATE_ALPHA_VERSION_URL =
  "https://raw.githubusercontent.com/OpenRouterLabs/ori-releases/main/version-alpha";

/**
 * The release channel an update targets. `stable` (default) installs the latest
 * non-prerelease build via `openrouter.ai/labs/ori/*`; `alpha` opts in to the
 * pre-release channel. `ori start`'s background auto-updater also defaults to
 * `stable`, but MAY track `alpha` instead when started with `--alpha` — a
 * deliberate, explicit per-invocation choice, never a persisted subscription.
 */
const UpdateChannelSchema = Schema.Literals(["stable", "alpha"]).annotate({
  identifier: "UpdateChannel",
});
type UpdateChannel = typeof UpdateChannelSchema.Type;

const ALPHA_CHANNEL: UpdateChannel = "alpha";

/**
 * A version pointer that fetched successfully but carried no usable version —
 * either an empty body or a string that {@link parseReleaseVersion} rejects. The
 * wrapper maps it (like every other failure) into an actionable
 * {@link makeUpdateFailure}.
 */
class ReleaseVersionError extends Schema.TaggedErrorClass<ReleaseVersionError>()(
  "ReleaseVersionError",
  {
    detail: Schema.String,
  }
) {
  override readonly message = this.detail;
}

/** The version pointer URL for a channel. */
const versionUrlForChannel = (channel: UpdateChannel): string =>
  channel === ALPHA_CHANNEL
    ? ORI_UPDATE_ALPHA_VERSION_URL
    : ORI_UPDATE_VERSION_URL;

const makeUpdateFailure = (
  operation: string,
  cause: unknown
): CliFailureError =>
  new CliFailureError({
    detail: `${operation}: ${formatUnknownError(cause)}`,
    hint: "Check your network connection, then run `ori update` again.",
  });

const VERSION_FETCH_RETRY_TIMES = 3;
const versionFetchRetrySchedule = Schedule.spaced("1 second");

/** Overrides for {@link fetchReleaseVersionForChannel}. */
interface FetchReleaseVersionOptions {
  /**
   * Spacing between transient-failure retries. Tests inject a near-zero
   * schedule so they can assert the retry count without waiting real seconds.
   */
  readonly retrySchedule?: Schedule.Schedule<unknown>;
}

/**
 * Fetch and validate the latest published version string for a channel.
 * Transient failures (network errors, timeouts, HTTP 408/429/5xx) are retried
 * on a spaced schedule; non-transient errors fail immediately. The failure
 * message names the exact URL so it is actionable per channel.
 */
export const fetchReleaseVersionForChannel = Effect.fn(
  "UpdateCommand.fetchReleaseVersionForChannel"
)(
  function* (channel: UpdateChannel, options?: FetchReleaseVersionOptions) {
    const client = (yield* HttpClient.HttpClient).pipe(
      HttpClient.filterStatusOk,
      HttpClient.retryTransient({
        schedule: options?.retrySchedule ?? versionFetchRetrySchedule,
        times: VERSION_FETCH_RETRY_TIMES,
      })
    );
    const response = yield* client.get(versionUrlForChannel(channel));
    const version = (yield* response.text).trim();
    if (version.length === 0) {
      return yield* new ReleaseVersionError({
        detail: "empty version response",
      });
    }
    if (parseReleaseVersion(version) === undefined) {
      return yield* new ReleaseVersionError({
        detail: `malformed version response: ${version}`,
      });
    }
    return version;
  },
  (effect, channel: UpdateChannel, _options?: FetchReleaseVersionOptions) =>
    effect.pipe(
      Effect.mapError((cause) =>
        makeUpdateFailure(
          `Failed to fetch ${versionUrlForChannel(channel)}`,
          cause
        )
      )
    )
);

export {
  ALPHA_CHANNEL,
  makeUpdateFailure,
  ORI_UPDATE_ALPHA_VERSION_URL,
  ORI_UPDATE_BASE_URL,
  ORI_UPDATE_VERSION_URL,
  UpdateChannelSchema,
};
export type { UpdateChannel };
