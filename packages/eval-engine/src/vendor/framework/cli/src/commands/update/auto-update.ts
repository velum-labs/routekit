import type { FileSystem } from "effect";
import type { HttpClient } from "effect/unstable/http";
import type { ChildProcessSpawner } from "effect/unstable/process";

import { Crypto, Duration, Effect, Path } from "effect";

import type { CliIo } from "../../../../contracts/internal/src/cli/cli-io.ts";
import type {
  CliFailureError,
  CliIoError,
} from "../../../../contracts/internal/src/errors.ts";
import type { TelemetryObserverShape } from "../../../../contracts/internal/src/runtime/telemetry-observer.ts";
import type { Notifier } from "./notify/notifier.ts";
import type {
  AutoUpdateLevel,
  ResolvedAutoUpdateConfig,
} from "./ori-config.ts";
import type { UpdateChannel } from "./release-channel.ts";
import type { UpdateSeverity } from "./release-version.ts";

import {
  autoUpdateStatePath,
  clearPendingUpdate,
  readAutoUpdateState,
  shouldNotifyHeldUpdate,
  writeAutoUpdateState,
} from "./auto-update-state.ts";
import { fetchReleaseVersionForChannel } from "./release-channel.ts";
import { classifyUpdateSeverity } from "./release-version.ts";
import {
  readCurrentReleaseVersion,
  resolveUpdateInstallDir,
  runUpdateFromExecutablePath,
} from "./update-runner.ts";
import { formatUnknownError } from "../../../../utils/core/src/error-formatting.ts";

const SEVERITY_RANK: Record<UpdateSeverity, number> = {
  major: 3,
  minor: 2,
  none: 0,
  patch: 1,
};
const LEVEL_RANK: Record<AutoUpdateLevel, number> = {
  major: 3,
  minor: 2,
  off: 0,
  patch: 1,
};
const JITTER_FRACTION = 0.1;

/**
 * Whether an update of the given `severity` is at or below the configured
 * auto-apply `level`. `off` never auto-applies; `patch` applies only patches;
 * `minor` applies patch+minor; `major` applies everything.
 */
const severityWithinThreshold = (
  severity: UpdateSeverity,
  level: AutoUpdateLevel
): boolean =>
  level !== "off" &&
  severity !== "none" &&
  SEVERITY_RANK[severity] <= LEVEL_RANK[level];

/** What a single auto-update tick decided to do. */
type AutoUpdateOutcome =
  | {
      readonly current: string | null;
      readonly kind: "up-to-date";
      readonly latest: string;
    }
  | { readonly detail: string; readonly kind: "error" }
  | {
      readonly from: string | null;
      readonly kind: "applied";
      readonly severity: UpdateSeverity;
      readonly to: string;
    }
  | {
      readonly from: string | null;
      readonly kind: "held";
      readonly severity: UpdateSeverity;
      readonly to: string;
    }
  | { readonly kind: "disabled" }
  | { readonly kind: "unsupported" };

/**
 * The fallible/process-level operations a tick performs, behind an interface so
 * the loop can be exercised with stubs (no network, installer, or restart).
 * `R` is whatever services the real implementations require.
 */
interface AutoUpdateActions<R> {
  /** Run the installer for the current executable. */
  readonly applyUpdate: Effect.Effect<void, CliFailureError | CliIoError, R>;
  /** Fetch the latest published release version. */
  readonly fetchLatest: Effect.Effect<string, CliFailureError, R>;
  /** A fresh ISO timestamp (for notification de-dupe records). */
  readonly nowIso: Effect.Effect<string, never, R>;
  /** A fresh opaque approval token. */
  readonly token: Effect.Effect<string, never, R>;
  /** The installed release version, or `null` when unknown (no sidecar). */
  readonly readCurrent: Effect.Effect<string | null, never, R>;
  /** The install dir, or `undefined` for non-installed builds (source checkouts). */
  readonly resolveInstallDir: Effect.Effect<string | undefined, never, R>;
  /** Drain and restart the running server; never returns in production. */
  readonly restart: Effect.Effect<void, never, R>;
}

/** Services required by {@link makeProductionAutoUpdateActions}. */
type ProductionAutoUpdateEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | CliIo
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path;

/**
 * Build the production actions from the running executable, a restart effect,
 * and the tracked release `channel`. The caller resolves the effective channel
 * before constructing these actions.
 */
const makeProductionAutoUpdateActions = (input: {
  readonly channel: UpdateChannel;
  readonly executablePath: string | undefined;
  readonly restart: Effect.Effect<void>;
}): AutoUpdateActions<ProductionAutoUpdateEnv> => ({
  // The auto-updater has already fetched `latest` and confirmed an update is
  // available before applying, so force the install to skip a redundant
  // version fetch and the ORI-370 up-to-date short-circuit.
  applyUpdate: runUpdateFromExecutablePath(
    input.executablePath,
    input.channel,
    { force: true }
  ),
  fetchLatest: fetchReleaseVersionForChannel(input.channel),
  nowIso: Effect.sync(() => new Date().toISOString()),
  readCurrent: readCurrentReleaseVersion(input.executablePath),
  resolveInstallDir: resolveUpdateInstallDir(input.executablePath),
  restart: input.restart,
  token: Effect.gen(function* () {
    const cryptoService = yield* Crypto.Crypto;
    return yield* cryptoService.randomUUIDv4;
  }).pipe(Effect.orDie),
});

interface AutoUpdateTickOptions<R> {
  readonly actions: AutoUpdateActions<R>;
  readonly config: ResolvedAutoUpdateConfig;
  readonly log: (line: string) => Effect.Effect<void>;
  readonly notifier: Notifier;
  readonly workspaceRoot: string;
  readonly telemetryObserver?: TelemetryObserverShape | undefined;
}

const autoUpdateTelemetryProps = (
  outcome: AutoUpdateOutcome
): Readonly<Record<string, string>> => {
  if (outcome.kind === "up-to-date") {
    return {
      from_version: outcome.current ?? "unknown",
      outcome: "up-to-date",
    };
  }
  if (outcome.kind === "applied" || outcome.kind === "held") {
    return {
      from_version: outcome.from ?? "unknown",
      outcome: outcome.kind,
      to_version: outcome.to,
    };
  }
  return {
    from_version: "unknown",
    outcome: outcome.kind,
  };
};

const emitAutoUpdateTelemetry = <R>(
  options: AutoUpdateTickOptions<R>,
  outcome: AutoUpdateOutcome
): Effect.Effect<void, never, R> => {
  if (options.telemetryObserver === undefined) {
    return Effect.void;
  }
  return options.telemetryObserver
    .observe("update_check", autoUpdateTelemetryProps(outcome))
    .pipe(Effect.ignore);
};

const versionArrow = (from: string | null, to: string): string =>
  `${from ?? "unknown"} -> ${to}`;

/**
 * Run one auto-update check: resolve the install, read the current and latest
 * versions, classify the jump, then apply (and restart) when within the
 * threshold or hold for approval when above it. Never fails — network/installer
 * errors are caught and reported as an `error` outcome so the poll loop survives.
 */
/** The within-threshold details a tick computed before deciding apply vs. hold. */
interface UpdateDecisionContext<R> {
  readonly current: string | null;
  readonly latest: string;
  readonly options: AutoUpdateTickOptions<R>;
  readonly severity: Exclude<UpdateSeverity, "none">;
  readonly statePath: string;
}

const applyUpdateTick = Effect.fn("applyUpdateTick")(function* <R>(
  context: UpdateDecisionContext<R>
) {
  const { current, latest, options, severity, statePath } = context;
  const { actions, log, notifier } = options;
  yield* log(
    `[ori-update] Applying ${severity} update ${versionArrow(current, latest)}...`
  );
  yield* actions.applyUpdate;
  // The binary is on disk; clearing the pending record is best-effort and must
  // never block the restart that loads it (a write failure would otherwise be
  // caught below and strand the process on the old binary).
  yield* clearPendingUpdate(statePath).pipe(Effect.ignore);
  yield* notifier.notifyApplied({ version: latest });
  const outcome = {
    from: current,
    kind: "applied",
    severity,
    to: latest,
  } as const;
  yield* emitAutoUpdateTelemetry(options, outcome);
  yield* actions.restart;
  return outcome;
});

const holdUpdateTick = Effect.fn("holdUpdateTick")(function* <R>(
  context: UpdateDecisionContext<R>
) {
  const { current, latest, options, severity, statePath } = context;
  const { actions, log, notifier } = options;
  const state = yield* readAutoUpdateState(statePath);
  if (shouldNotifyHeldUpdate(state, latest)) {
    const token = yield* actions.token;
    const notifiedAt = yield* actions.nowIso;
    yield* writeAutoUpdateState(statePath, {
      lastCheckedAt: notifiedAt,
      pending: {
        approvalToken: token,
        currentVersion: current,
        decision: "pending",
        latestVersion: latest,
        notifiedAt,
        severity,
      },
    });
    yield* log(
      `[ori-update] Holding ${severity} update ${versionArrow(current, latest)} for approval.`
    );
    yield* notifier.notifyHeldUpdate({
      approvalToken: token,
      currentVersion: current,
      latestVersion: latest,
      severity,
    });
  }
  return {
    from: current,
    kind: "held",
    severity,
    to: latest,
  } as const;
});

// Convert any tick failure into a logged + notified `error` outcome so the poll
// loop survives network/installer errors instead of dying on the first one.
const reportAutoUpdateError = <R>(
  options: AutoUpdateTickOptions<R>,
  error: unknown
): Effect.Effect<AutoUpdateOutcome, never, R> => {
  const detail = formatUnknownError(error);
  return options.log(`[ori-update] Update check failed: ${detail}`).pipe(
    Effect.andThen(options.notifier.notifyFailure({ detail })),
    Effect.map(
      () =>
        ({
          detail,
          kind: "error",
        }) as const
    )
  );
};

export const runAutoUpdateOnce = Effect.fn("runAutoUpdateOnce")(function* <R>(
  options: AutoUpdateTickOptions<R>
) {
  const outcome = yield* Effect.gen(function* () {
    const { actions, config, workspaceRoot } = options;
    if (config.level === "off") {
      return { kind: "disabled" } as const;
    }

    const installDir = yield* actions.resolveInstallDir;
    if (installDir === undefined) {
      return { kind: "unsupported" } as const;
    }

    const current = yield* actions.readCurrent;
    const latest = yield* actions.fetchLatest;
    const severity = classifyUpdateSeverity(current, latest);
    if (severity === "none") {
      return {
        current,
        kind: "up-to-date",
        latest,
      } as const;
    }

    const path = yield* Path.Path;
    const statePath = autoUpdateStatePath(path, workspaceRoot);
    const context: UpdateDecisionContext<R> = {
      current,
      latest,
      options,
      severity,
      statePath,
    };

    if (severityWithinThreshold(severity, config.level)) {
      return yield* applyUpdateTick(context);
    }
    return yield* holdUpdateTick(context);
  }).pipe(Effect.catch((error) => reportAutoUpdateError(options, error)));
  if (outcome.kind !== "applied") {
    yield* emitAutoUpdateTelemetry(options, outcome);
  }
  return outcome;
});

/** Apply a ±`JITTER_FRACTION` jitter to the base interval to avoid synchronized polling. */
export const jitteredIntervalMs = (
  intervalMs: number,
  random: () => number = Math.random
): number => {
  const jitter = (random() * 2 - 1) * JITTER_FRACTION;
  return Math.max(1, Math.round(intervalMs * (1 + jitter)));
};

/**
 * Run the periodic auto-update poll loop: an immediate check on boot, then a
 * check every `config.intervalMs` (±10% jitter). Stops once an update is applied
 * (the process is restarting) or the install is unsupported (a source checkout
 * or packed intern, which can never update). When the level is `off` it logs and
 * returns.
 */
export const runAutoUpdateLoop = <R>(
  options: AutoUpdateTickOptions<R>
): Effect.Effect<void, never, R | FileSystem.FileSystem | Path.Path> => {
  if (options.config.level === "off") {
    return options.log(
      "[ori-update] Auto-update is off; skipping update checks."
    );
  }

  const loop = (): Effect.Effect<
    void,
    never,
    R | FileSystem.FileSystem | Path.Path
  > =>
    runAutoUpdateOnce(options).pipe(
      Effect.flatMap((outcome) => {
        if (outcome.kind === "applied") {
          return Effect.void;
        }
        // A source checkout or packed intern has no release-channel binary to
        // update, so polling can never make progress: log once and stop the loop
        // rather than waking the fiber every interval forever.
        if (outcome.kind === "unsupported") {
          return options.log(
            "[ori-update] Not an installed release-channel binary; skipping auto-update checks."
          );
        }
        return Effect.sleep(
          Duration.millis(jitteredIntervalMs(options.config.intervalMs))
        ).pipe(Effect.flatMap(() => loop()));
      })
    );

  return loop();
};

export { severityWithinThreshold, makeProductionAutoUpdateActions };
export type {
  AutoUpdateOutcome,
  AutoUpdateActions,
  ProductionAutoUpdateEnv,
  AutoUpdateTickOptions,
};
