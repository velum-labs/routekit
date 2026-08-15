import type { Effect } from "effect";

import type { UpdateSeverity } from "../release-version.ts";

/** A held update awaiting approval, surfaced to operators through a {@link Notifier}. */
interface HeldUpdateNotice {
  readonly approvalToken: string;
  readonly currentVersion: string | null;
  readonly latestVersion: string;
  readonly severity: UpdateSeverity;
}

/**
 * Pluggable destination for auto-update notifications. Implementations must
 * never fail the caller — delivery is best-effort so a flaky notifier can never
 * stop the server or the update itself. The only implementation is
 * {@link makeLogNotifier}, which writes to stdout / the daemon log; held updates
 * are surfaced there with an `routekit-eval update` instruction.
 */
interface Notifier {
  /** Announce an update applied automatically (at/below threshold) or after approval. */
  readonly notifyApplied: (input: {
    readonly version: string;
  }) => Effect.Effect<void>;
  /** Announce a failure somewhere in the auto-update flow. */
  readonly notifyFailure: (input: {
    readonly detail: string;
  }) => Effect.Effect<void>;
  /** Announce an update that exceeds the auto-apply threshold and needs approval. */
  readonly notifyHeldUpdate: (notice: HeldUpdateNotice) => Effect.Effect<void>;
}

const versionLabel = (version: string | null): string => version ?? "unknown";

export const formatHeldUpdateMessage = (notice: HeldUpdateNotice): string =>
  `RouteKitEval ${notice.severity} update available: ${versionLabel(notice.currentVersion)} -> ${notice.latestVersion}. ` +
  "This exceeds the auto-update threshold and needs approval. Run `routekit-eval update` to install it.";

export const formatAppliedMessage = (version: string): string =>
  `RouteKitEval updated to ${version}. Restarting the runtime to apply it.`;

export const formatFailureMessage = (detail: string): string =>
  `RouteKitEval auto-update failed: ${detail}`;

/**
 * The default notifier: writes human-readable lines through the provided log
 * sink (stdout or the daemon log hub). Always succeeds.
 */
export const makeLogNotifier = (
  log: (line: string) => Effect.Effect<void>
): Notifier => ({
  notifyApplied: (input): Effect.Effect<void> =>
    log(formatAppliedMessage(input.version)),
  notifyFailure: (input): Effect.Effect<void> =>
    log(formatFailureMessage(input.detail)),
  notifyHeldUpdate: (notice): Effect.Effect<void> =>
    log(formatHeldUpdateMessage(notice)),
});

export type { HeldUpdateNotice, Notifier };
