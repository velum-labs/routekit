import {
  Duration,
  Effect,
  FileSystem,
  HashSet,
  Option,
  Path,
  Ref,
  Stream,
} from "effect";

import type { DaemonRuntime } from "../../../../runloop/local/src/daemon/server/server-types.ts";
import type { FeatureBootResult } from "../../../../runloop/local/src/feature-boot/types.ts";
import type {
  DevReloadWatcherOptions,
  WatcherDeps,
} from "./reload-watcher-snapshot.ts";

import { CliIo } from "../../../../contracts/internal/src/cli/cli-io.ts";
import { readOptionalConfigString } from "./optional-config.ts";
import { logWatcherStopped } from "./reload-watcher-diagnostics.ts";
import {
  addCandidates,
  buildReloadEventStream,
} from "./reload-watcher-snapshot.ts";
import {
  bootstrapInitialReload,
  drainAndReload,
} from "./reload-watcher-steps.ts";

const EMPTY_COUNT = 0;
const RELOAD_COALESCE_MS = 100;
const DEFAULT_RELOAD_DRAIN_TIMEOUT_MS = 300_000;
const ROUTEKIT_EVAL_DEV_IGNORE_ENV = "ROUTEKIT_EVAL_DEV_IGNORE";
const ROUTEKIT_EVAL_DEV_RELOAD_DRAIN_TIMEOUT_MS_ENV = "ROUTEKIT_EVAL_DEV_RELOAD_DRAIN_TIMEOUT_MS";
const ROUTEKIT_EVAL_DEV_WATCH_POLL_ENV = "ROUTEKIT_EVAL_DEV_WATCH_POLL";

const parseDrainTimeoutMs = (value: string | undefined): number => {
  if (value === undefined) {
    return DEFAULT_RELOAD_DRAIN_TIMEOUT_MS;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > EMPTY_COUNT
    ? parsed
    : DEFAULT_RELOAD_DRAIN_TIMEOUT_MS;
};

const parseIgnorePatterns = (value: string | undefined): readonly string[] =>
  (value ?? "")
    .split(",")
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern.length !== EMPTY_COUNT);

const readDevReloadConfig = Effect.fn("DevReloadWatcher.readConfig")(
  function* () {
    const poll = yield* readOptionalConfigString(ROUTEKIT_EVAL_DEV_WATCH_POLL_ENV);
    const drainTimeout = yield* readOptionalConfigString(
      ROUTEKIT_EVAL_DEV_RELOAD_DRAIN_TIMEOUT_MS_ENV
    );
    const ignore = yield* readOptionalConfigString(ROUTEKIT_EVAL_DEV_IGNORE_ENV);
    return {
      drainTimeoutMs: parseDrainTimeoutMs(drainTimeout),
      ignorePatterns: parseIgnorePatterns(ignore),
      usePolling: poll === "1",
    };
  }
);

export const startDevReloadWatcher = Effect.fn("DevReloadWatcher.start")(
  function* (
    featuresRoot: string,
    daemonRuntime: DaemonRuntime,
    options: DevReloadWatcherOptions = {}
  ) {
    const config = yield* readDevReloadConfig();
    const deps: WatcherDeps = {
      cliIo: yield* CliIo,
      daemonContext: yield* daemonRuntime.contextEffect,
      featuresRoot,
      fs: yield* FileSystem.FileSystem,
      ignorePatterns: config.ignorePatterns,
      lastGoodBoot: yield* Ref.make(Option.none<FeatureBootResult>()),
      options,
      path: yield* Path.Path,
      pending: yield* Ref.make(HashSet.empty<string>()),
    };

    yield* bootstrapInitialReload(deps);

    const events = buildReloadEventStream(deps, config.usePolling);

    // Surface failures on the detached reload fiber instead of dying silently (ROUTEKIT_EVAL-248).
    yield* events.pipe(
      Stream.mapEffect((candidate) =>
        Ref.update(deps.pending, addCandidates(candidate))
      ),
      Stream.debounce(Duration.millis(RELOAD_COALESCE_MS)),
      Stream.mapEffect(() => drainAndReload(deps, config.drainTimeoutMs)),
      Stream.runDrain,
      Effect.tapCause(logWatcherStopped(deps.cliIo, deps.pending)),
      Effect.forkScoped
    );
  }
);

export type { DevReloadWatcherOptions };
