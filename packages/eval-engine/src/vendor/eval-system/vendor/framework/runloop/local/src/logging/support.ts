import type { Stdio } from "effect";

import { Context, Effect, Layer, Logger as EffectLogger, Option } from "effect";

import type { FeatureLogger } from "../../../../contracts/author/src/index.ts";
import type {
  LoggerShape,
  LogLevel,
} from "../../../../contracts/internal/src/runtime/services.ts";
import type { TelemetryUsageSinkShape } from "../../../../contracts/internal/src/runtime/telemetry-usage-sink.ts";
import type { DaemonAuditLogger } from "../daemon/core/audit-logger.ts";

import {
  installFeatureLog,
  noopFeatureLogger,
} from "../../../../contracts/author/src/logger.ts";
import { LogSink } from "../../../../contracts/internal/src/runtime/log-sink.ts";
import { TelemetryUsageSink } from "../../../../contracts/internal/src/runtime/telemetry-usage-sink.ts";
import {
  formatLogRecord,
  Logger,
  makeLogger,
  readLogLevelConfig,
} from "../../../../engine/runtime-io/src/logger.ts";
import { makeDaemonAuditLayer } from "../daemon/core/audit-logger.ts";
import { DaemonLogHub } from "../daemon/logging/log-hub.ts";

/**
 * The slice of a daemon runtime {@link makeDaemonHubPublish} needs: a `runFork`
 * that can run a hub-publishing effect. Structural so callers outside the daemon
 * (and tests) can satisfy it without the full `DaemonRuntime` service set.
 */
interface HubPublishRuntime {
  readonly runFork: (
    effect: Effect.Effect<void, never, DaemonLogHub>
  ) => unknown;
}

/**
 * Dev/daemon {@link LogSink}: publishes formatted records to the
 * {@link DaemonLogHub} instead of stdout, so diagnostics reach
 * `GET /api/logs/stream` and the durable `.routekit-eval/logs` NDJSON without corrupting a
 * host TUI that owns the terminal.
 */
const hubLogSinkLayer = Layer.effect(LogSink)(
  Effect.gen(function* () {
    const hub = yield* DaemonLogHub;
    return LogSink.of({
      write: (record) => hub.publish(formatLogRecord(record)),
    });
  })
);

const daemonEffectLoggerLayer = EffectLogger.layer([
  Effect.gen(function* () {
    const hub = yield* DaemonLogHub;
    const logLevel = yield* readLogLevelConfig;
    if (logLevel === "debug" || logLevel === "trace") {
      return EffectLogger.defaultLogger;
    }
    return EffectLogger.make<unknown, number>((options) => {
      Effect.runFork(
        hub
          .publish(EffectLogger.formatSimple.log(options))
          .pipe(Effect.provideService(DaemonLogHub, hub))
      );
      return 0;
    });
  }),
  EffectLogger.tracerLogger,
]);

const runVoid = (effect: Effect.Effect<void>): void => {
  Effect.runFork(effect);
};

export { noopFeatureLogger };

/**
 * Bridge the internal Effect-based {@link LoggerShape} to the effect-free
 * {@link FeatureLogger} feature authors receive. Each call forks the logging
 * effect (fire-and-forget) so a feature never has to know about Effect, and a
 * slow or failing sink never blocks the feature's own work.
 */
export const makeFeatureLogger = (logger: LoggerShape): FeatureLogger => ({
  child: (scope, fields): FeatureLogger =>
    makeFeatureLogger(logger.child(scope, fields)),
  debug: (message, fields): void => {
    runVoid(logger.debug(message, fields));
  },
  error: (message, error, fields): void => {
    runVoid(logger.error(message, error, fields));
  },
  info: (message, fields): void => {
    runVoid(logger.info(message, fields));
  },
  trace: (message, fields): void => {
    runVoid(logger.trace(message, fields));
  },
  warn: (message, fields): void => {
    runVoid(logger.warn(message, fields));
  },
});

/**
 * The per-feature {@link FeatureLogger} for `scope`, or `None` when `context`
 * carries no {@link Logger}.
 *
 * For call sites that want to know whether logging is actually wired rather than
 * write into a noop: a caller threading `Option<FeatureLogger>` onward can skip
 * the work of building a log payload entirely, and "no logger" stays `None` all
 * the way down instead of becoming an indistinguishable `Some(noop)`.
 */
export const featureLoggerOptionFromContext = (
  context: Context.Context<never>,
  scope: string
): Option.Option<FeatureLogger> =>
  Context.getOption(context, Logger).pipe(
    Option.map((logger) => makeFeatureLogger(logger.child(scope)))
  );

/**
 * Build a per-feature {@link FeatureLogger} from the {@link Logger} captured in
 * `context`, scoped to `scope` (e.g. `feature:<id>`). Falls back to
 * {@link noopFeatureLogger} when no logger is provided, so host call sites
 * outside a logging runtime stay safe.
 */
export const featureLoggerFromContext = (
  context: Context.Context<never>,
  scope: string
): FeatureLogger =>
  Option.getOrElse(
    featureLoggerOptionFromContext(context, scope),
    () => noopFeatureLogger
  );

/**
 * Build an effect-free {@link FeatureLogger} that renders each record to a line
 * and hands it to `publish` (typically the daemon log hub's publisher). Used by
 * host call sites that hold a hub publisher but run outside the daemon's logging
 * runtime — e.g. the dev/start scheduler loop — so scheduler diagnostics still
 * reach `routekit-eval logs` (RFC 0011). Records below `minLevel` are dropped.
 */
export const makeHubPublishLogger = (
  publish: (line: string) => void,
  minLevel: LogLevel,
  scope: string
): FeatureLogger =>
  makeFeatureLogger(
    makeLogger({
      minLevel,
      scope,
      sink: {
        write: (record) =>
          Effect.sync(() => {
            publish(formatLogRecord(record));
          }),
      },
    })
  );

/**
 * A line publisher that forks each line onto `daemonRuntime` and publishes it to
 * the {@link DaemonLogHub}, so a caller outside the daemon's runtime (the dev
 * scheduler loop) can still feed `routekit-eval logs`.
 */
export const makeDaemonHubPublish =
  (daemonRuntime: HubPublishRuntime): ((line: string) => void) =>
  (line) => {
    daemonRuntime.runFork(
      DaemonLogHub.pipe(Effect.flatMap((hub) => hub.publish(line)))
    );
  };

/**
 * Build a hub-backed {@link FeatureLogger} scoped to `scope`, reading the minimum
 * level from `ROUTEKIT_EVAL_LOG_LEVEL`. Records render to lines that flow to `publish`
 * (typically {@link makeDaemonHubPublish}), so diagnostics reach `routekit-eval logs`.
 */
export const makeSchedulerHubLogger = (
  publish: (line: string) => void,
  scope: string
): Effect.Effect<FeatureLogger> =>
  readLogLevelConfig.pipe(
    Effect.map((minLevel) => makeHubPublishLogger(publish, minLevel, scope))
  );

/**
 * Publish the process-global `log` (RFC 0011, `routekit-eval/logger`) by bridging the
 * {@link Logger} in context to an effect-free {@link FeatureLogger} and
 * installing it on the shared `globalThis` slot the author SDK reads. Scoped:
 * the logger is installed on acquire and the prior occupant restored on release,
 * so two concurrent runtimes (e.g. the CLI core layer + an in-process daemon
 * under `routekit-eval dev`) each release cleanly without blanking the other's install.
 *
 * Note: {@link Logger} is a required service of this layer — both call sites
 * (the CLI core layer and the daemon observability layer) always provide one.
 *
 * Provide this layer wherever the host wires its {@link Logger} — the CLI core
 * layer and the daemon observability layer — so `log` routes to `routekit-eval logs` /
 * CLI stderr in every run mode, exactly like the injected per-feature logger.
 */
export const globalFeatureLogLayer = Layer.effectDiscard(
  Effect.acquireRelease(
    Effect.gen(function* () {
      const logger = yield* Logger;
      const restore = installFeatureLog(makeFeatureLogger(logger));
      return restore;
    }),
    (restore) => Effect.sync(restore)
  )
);

/**
 * The daemon's observability stack: the framework-wide {@link Logger} backed by
 * the {@link DaemonLogHub} sink, merged with the audit logger (and the hub they
 * share). The hub is teed into `GET /api/logs/stream` and the durable
 * `.routekit-eval/logs` NDJSON, so diagnostics survive without touching stdout. Requires
 * `Stdio` (provide `bunServicesLayer`) for the audit logger's stdout mirror.
 *
 * Pass `telemetryUsageSink` to route the usage events a daemon-hosted surface
 * writes through its {@link FeatureLogger} (`slash_command`, `run_steered`) to a
 * real sink. The daemon is its own `ManagedRuntime`, so it does not inherit the
 * CLI's `TelemetryUsageSink`; without this the {@link Logger} falls back to the
 * no-op sink and those events are dropped.
 */
export const makeDaemonObservabilityLayer = (options?: {
  readonly suppressAuditStdout?: boolean | undefined;
  readonly telemetryUsageSink?: TelemetryUsageSinkShape | undefined;
  readonly suppressTuiLogs?: boolean | undefined;
}): Layer.Layer<
  Logger | DaemonLogHub | DaemonAuditLogger,
  never,
  Stdio.Stdio
> => {
  const audit = makeDaemonAuditLayer({
    suppressAuditStdout: options?.suppressAuditStdout,
  });
  const usageSink = options?.telemetryUsageSink;
  const hubLogger = Logger.layer.pipe(Layer.provide(hubLogSinkLayer));
  // `Logger.layer` reads the sink off its construction context rather than its
  // requirement channel (it is optional there), so providing it here is what
  // makes the daemon's wiring explicit instead of dependent on whatever ambient
  // context happened to build this layer.
  const logger =
    usageSink === undefined
      ? hubLogger
      : hubLogger.pipe(
          Layer.provide(
            Layer.succeed(TelemetryUsageSink)(TelemetryUsageSink.of(usageSink))
          )
        );
  const observability = logger.pipe(Layer.provideMerge(audit));
  const effectLogger =
    options?.suppressTuiLogs === true ? daemonEffectLoggerLayer : Layer.empty;
  // Install the process-global `log` (RFC 0011, `routekit-eval/logger`) from the daemon's
  // hub-backed Logger, so a feature's bare `log.*` reaches `routekit-eval logs` /
  // `.routekit-eval/logs` NDJSON in daemon mode too — not just CLI stderr. `provideMerge`
  // feeds `observability`'s `Logger` into the install layer's requirement and
  // still re-exposes the observability services to the rest of the daemon.
  // Scoped, so the global is cleared when the daemon runtime tears down.
  const observabilityWithEffectLogger = effectLogger.pipe(
    Layer.provideMerge(observability)
  );
  return globalFeatureLogLayer.pipe(
    Layer.provideMerge(observabilityWithEffectLogger)
  );
};

export { hubLogSinkLayer };
export type { HubPublishRuntime };
