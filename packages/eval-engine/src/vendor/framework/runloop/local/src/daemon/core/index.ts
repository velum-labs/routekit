import { Context, Crypto, Effect, Layer, Option, Path, Stream } from "effect";

import type { OpenRouterAuthSource } from "../../../../../contracts/internal/src/openrouter-auth.ts";
import type { OriDaemonShape } from "./service.ts";
import type { OriDaemonServices } from "./types.ts";

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
import { OriDaemon as OriDaemonService } from "./service.ts";
import { invokeRuntimeCommand } from "../invoke/invoke.ts";
import { resolveRolloverConfig } from "../../event/rollover.ts";
import { makeContextWindowLookup } from "../../models/context-window.ts";
import { OpenRouterModels } from "../../openrouter/models-service.ts";
import { ReloadCoordinator } from "../../reload/coordinator.ts";

const OriDaemon = OriDaemonService;

class OriDaemonConfig extends Context.Service<
  OriDaemonConfig,
  {
    readonly authSource: Option.Option<OpenRouterAuthSource>;
    readonly featuresRoot?: string | undefined;
  }
>()("ori/runtime/OriDaemonConfig") {
  static readonly fromOptions = (options: {
    readonly authSource: Option.Option<OpenRouterAuthSource>;
    readonly featuresRoot?: string | undefined;
  }): Layer.Layer<OriDaemonConfig> =>
    Layer.succeed(OriDaemonConfig)(OriDaemonConfig.of(options));
}

interface OriDaemonLayerOptions {
  readonly authSource: Option.Option<OpenRouterAuthSource>;
  readonly featuresRoot?: string | undefined;
}

const defaultFeaturesRoot = Effect.fn("Daemon.defaultFeaturesRoot")(
  function* () {
    const config = yield* OriDaemonConfig;
    return config.featuresRoot;
  }
);

const defaultAuthSource = Effect.fn("Daemon.defaultAuthSource")(function* () {
  const config = yield* OriDaemonConfig;
  return config.authSource;
});

const makeOriDaemon = (services: OriDaemonServices): OriDaemonShape => {
  const registry = makeCancellationRegistry();
  const invoke: OriDaemonShape["invoke"] = (command) =>
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
  return OriDaemon.of({
    cancel: registry.cancel,
    invoke,
  });
};

const oriDaemonImplementationLayer = Layer.effect(OriDaemon)(
  Effect.gen(function* () {
    const logger = yield* DaemonAuditLogger;
    const crypto = yield* Crypto.Crypto;
    const journal = yield* RuntimeEventJournal;
    const path = yield* Path.Path;
    const reloadCoordinator = yield* ReloadCoordinator;
    const runner = yield* AgentRunner;
    const sessionStore = yield* AgentSessionStore;
    const daemonAddress = yield* DaemonAddress;
    const openRouterModels = yield* OpenRouterModels;
    const authSource = yield* defaultAuthSource();

    yield* logConfiguredAuthSource({
      authSource,
      crypto,
      logger,
    });

    return makeOriDaemon({
      crypto,
      daemonAddress,
      defaultCwd: path.resolve(),
      defaultFeaturesRoot: yield* defaultFeaturesRoot(),
      journal,
      logger,
      contextWindowLookup: makeContextWindowLookup(),
      openRouterModels,
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

export const makeOriDaemonLayer = (
  options?: OriDaemonLayerOptions
): Layer.Layer<
  OriDaemonService,
  never,
  | Path.Path
  | Crypto.Crypto
  | AgentRunner
  | RuntimeEventJournal
  | AgentSessionStore
  | DaemonAddress
  | OpenRouterModels
  | ReloadCoordinator
  | DaemonAuditLogger
> =>
  oriDaemonImplementationLayer.pipe(
    Layer.provide(
      OriDaemonConfig.fromOptions({
        authSource: options?.authSource ?? Option.none(),
        featuresRoot: options?.featuresRoot,
      })
    )
  );

export const oriDaemonLayer = makeOriDaemonLayer();

export { OriDaemon, OriDaemonConfig, makeRuntimeAuditEvent };
export type { OriDaemonLayerOptions };
