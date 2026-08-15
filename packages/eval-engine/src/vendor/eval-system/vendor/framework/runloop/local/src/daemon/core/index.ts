import { Context, Crypto, Effect, Layer, Option, Path, Stream } from "effect";

import type { GatewayAuthSource } from "../../../../../contracts/internal/src/gateway-auth.ts";
import type { RouteKitEvalDaemonShape } from "./service.ts";
import type { RouteKitEvalDaemonServices } from "./types.ts";

import { TelemetryObserver } from "../../../../../contracts/internal/src/runtime/telemetry-observer.ts";
import { RuntimeEventJournal } from "../../../../../engine/events/src/event-journal-service.ts";
import { AgentSessionStore } from "../../../../../engine/session/src/session-store-service.ts";
import { AgentRunner } from "../../agent-runner/service.ts";
import { DaemonAddress } from "./address.ts";
import {
  DaemonAuditLogger,
  logConfiguredAuthSource,
  makeRuntimeAuditEvent,
} from "./audit-logger.ts";
import { makeCancellationRegistry } from "./cancellation.ts";
import { RouteKitEvalDaemon as RouteKitEvalDaemonService } from "./service.ts";
import { invokeRuntimeCommand } from "../invoke/invoke.ts";
import { resolveRolloverConfig } from "../../event/rollover.ts";
import { makeContextWindowLookup } from "../../models/context-window.ts";
import { GatewayModels } from "../../gateway/models-service.ts";
import { ReloadCoordinator } from "../../reload/coordinator.ts";

const RouteKitEvalDaemon = RouteKitEvalDaemonService;

class RouteKitEvalDaemonConfig extends Context.Service<
  RouteKitEvalDaemonConfig,
  {
    readonly authSource: Option.Option<GatewayAuthSource>;
    readonly featuresRoot?: string | undefined;
  }
>()("routekit-eval/runtime/RouteKitEvalDaemonConfig") {
  static readonly fromOptions = (options: {
    readonly authSource: Option.Option<GatewayAuthSource>;
    readonly featuresRoot?: string | undefined;
  }): Layer.Layer<RouteKitEvalDaemonConfig> =>
    Layer.succeed(RouteKitEvalDaemonConfig)(RouteKitEvalDaemonConfig.of(options));
}

interface RouteKitEvalDaemonLayerOptions {
  readonly authSource: Option.Option<GatewayAuthSource>;
  readonly featuresRoot?: string | undefined;
}

const defaultFeaturesRoot = Effect.fn("Daemon.defaultFeaturesRoot")(
  function* () {
    const config = yield* RouteKitEvalDaemonConfig;
    return config.featuresRoot;
  }
);

const defaultAuthSource = Effect.fn("Daemon.defaultAuthSource")(function* () {
  const config = yield* RouteKitEvalDaemonConfig;
  return config.authSource;
});

const makeRouteKitEvalDaemon = (services: RouteKitEvalDaemonServices): RouteKitEvalDaemonShape => {
  const registry = makeCancellationRegistry();
  const invoke: RouteKitEvalDaemonShape["invoke"] = (command) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const entry = yield* registry.begin(command.commandId);
        const stream = yield* invokeRuntimeCommand(
          services,
          command,
          entry.cancellation
        ).pipe(
          Effect.catchCause((cause) =>
            registry
              .remove(command.commandId)
              .pipe(Effect.andThen(Effect.failCause(cause)))
          )
        );
        return stream.pipe(Stream.ensuring(registry.remove(command.commandId)));
      })
    );
  return RouteKitEvalDaemon.of({
    cancel: registry.cancel,
    invoke,
  });
};

const routeKitEvalDaemonImplementationLayer = Layer.effect(RouteKitEvalDaemon)(
  Effect.gen(function* () {
    const logger = yield* DaemonAuditLogger;
    const crypto = yield* Crypto.Crypto;
    const journal = yield* RuntimeEventJournal;
    const path = yield* Path.Path;
    const reloadCoordinator = yield* ReloadCoordinator;
    const runner = yield* AgentRunner;
    const sessionStore = yield* AgentSessionStore;
    const daemonAddress = yield* DaemonAddress;
    const gatewayModels = yield* GatewayModels;
    const authSource = yield* defaultAuthSource();

    yield* logConfiguredAuthSource({
      authSource,
      crypto,
      logger,
    });

    return makeRouteKitEvalDaemon({
      crypto,
      daemonAddress,
      defaultCwd: path.resolve(),
      defaultFeaturesRoot: yield* defaultFeaturesRoot(),
      journal,
      logger,
      contextWindowLookup: makeContextWindowLookup(),
      gatewayModels,
      reloadCoordinator,
      rollover: resolveRolloverConfig(globalThis.process.env),
      runner,
      sessionStore,
      telemetryObserver: Option.getOrUndefined(
        yield* Effect.serviceOption(TelemetryObserver)
      ),
    });
  })
);

export const makeRouteKitEvalDaemonLayer = (
  options?: RouteKitEvalDaemonLayerOptions
): Layer.Layer<
  RouteKitEvalDaemonService,
  never,
  | Path.Path
  | Crypto.Crypto
  | AgentRunner
  | RuntimeEventJournal
  | AgentSessionStore
  | DaemonAddress
  | GatewayModels
  | ReloadCoordinator
  | DaemonAuditLogger
> =>
  routeKitEvalDaemonImplementationLayer.pipe(
    Layer.provide(
      RouteKitEvalDaemonConfig.fromOptions({
        authSource: options?.authSource ?? Option.none(),
        featuresRoot: options?.featuresRoot,
      })
    )
  );

export const routeKitEvalDaemonLayer = makeRouteKitEvalDaemonLayer();

export { RouteKitEvalDaemon, RouteKitEvalDaemonConfig, makeRuntimeAuditEvent };
export type { RouteKitEvalDaemonLayerOptions };
