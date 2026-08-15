import type {
  AccountActivityService,
  AccountAuthService
} from "@velum-labs/routekit-accounts/effect";
import type { RouteKitControlHandlers } from "@velum-labs/routekit-control";
import type { SwitchingGatewayProxy } from "@velum-labs/routekit-gateway";
import type { RunningRouter } from "@velum-labs/routekit-router";
import type { RunningControlServer } from "@velum-labs/routekit-runtime";
import { extendCleanupGrace, registerCleanup } from "@velum-labs/routekit-runtime";
import {
  EffectResourceScope,
  type RouteKitPlatform,
  routeKitError,
  runRouteKitEffect,
  toRouteKitFailure
} from "@velum-labs/routekit-runtime/effect";
import { Deferred, Effect, type ManagedRuntime } from "effect";

import type { DaemonRuntimeState } from "./daemon-runtime-state.js";
import type { DaemonTelemetry, GatewayTelemetryAggregator } from "./telemetry.js";

type Supervisor = "systemd" | "launchd" | "detached" | "unknown";

export type DaemonLifecycleOptions = {
  runtimeState: DaemonRuntimeState;
  handlers: RouteKitControlHandlers;
  drainGraceMs: number;
  packageVersion: string;
  supervisor: Supervisor;
  getProxy(): SwitchingGatewayProxy | undefined;
  getActiveRouter(): RunningRouter | undefined;
  getControl(): RunningControlServer | undefined;
  accountActivity?: AccountActivityService;
  accountAuth?: AccountAuthService;
  daemonTelemetry?: DaemonTelemetry;
  gatewayTelemetry?: GatewayTelemetryAggregator;
  closeSidecar(): Effect.Effect<void, Error>;
  cleanupRegistration(): void;
  /** Disposed last so in-flight Effect work can finish during teardown. */
  effectRuntime?: ManagedRuntime.ManagedRuntime<any, never>;
};

export function captureDaemonStarted(input: {
  daemonTelemetry?: DaemonTelemetry;
  packageVersion: string;
  supervisor: Supervisor;
}): void {
  input.daemonTelemetry?.capture("routekit.daemon_lifecycle", {
    action: "started",
    outcome: "success",
    supervisor: input.supervisor,
    version: input.packageVersion
  });
}

export function createDaemonLifecycle(options: DaemonLifecycleOptions): {
  close(): Effect.Effect<void, Error, RouteKitPlatform>;
  retire(graceMs?: number): Effect.Effect<void, Error, RouteKitPlatform>;
  pauseMutations(): Effect.Effect<ReturnType<DaemonRuntimeState["snapshot"]>, Error>;
  resumeMutations(): void;
  snapshot(): ReturnType<DaemonRuntimeState["snapshot"]>;
  reload(): Effect.Effect<void, Error>;
} {
  const shutdownResources = (
    mode: "close" | "retire",
    graceMs: number
  ): Effect.Effect<void, unknown, RouteKitPlatform> =>
    Effect.gen(function* () {
      const scope = new EffectResourceScope({ shutdownBudgetMs: graceMs + 10_000 });
      // ResourceScope finalizers run in LIFO order. Stop ingress first, then
      // drain the data plane before closing its router and supporting resources.
      // Telemetry remains alive through operational shutdown and the service
      // registration is removed only after every owned resource was attempted.
      // The Effect runtime is registered first so it disposes last.
      yield* scope.defer(async () => await options.effectRuntime?.dispose());
      yield* scope.defer(() => options.cleanupRegistration());
      yield* scope.defer(() => options.gatewayTelemetry?.close());
      yield* scope.defer(async () => await options.daemonTelemetry?.shutdown());
      yield* scope.deferEffect(options.closeSidecar());
      if (options.accountAuth !== undefined) {
        yield* scope.deferEffect(options.accountAuth.close as Effect.Effect<void, unknown>);
      }
      if (options.accountActivity !== undefined) {
        yield* scope.deferEffect(options.accountActivity.close as Effect.Effect<void, unknown>);
      }
      yield* scope.defer(async () => await options.getActiveRouter()?.close());
      yield* scope.defer(async () => {
        if (mode === "retire") await options.getProxy()?.retire(graceMs);
        else await options.getProxy()?.drain(graceMs);
      });
      yield* scope.defer(async () => {
        if (mode === "retire") await options.getControl()?.retire(Math.min(graceMs, 2_000));
        else await options.getControl()?.close();
      });
      yield* scope.dispose();
    });

  let removeSighupListener = (): void => {};
  let shutdownLatch: Deferred.Deferred<void, Error> | undefined;
  let shutdownOwner: Effect.Effect<void, Error, RouteKitPlatform> | undefined;
  const shutdown = (
    mode: "close" | "retire",
    graceMs: number
  ): Effect.Effect<void, Error, RouteKitPlatform> => {
    if (shutdownOwner !== undefined) return Deferred.await(shutdownLatch!);
    shutdownLatch = Deferred.makeUnsafe<void, Error>();
    shutdownOwner = Effect.gen(function* () {
      if (mode === "close") options.runtimeState.beginShutdown();
      else options.runtimeState.beginRetire();
      yield* options.runtimeState.awaitMutations();
      if (mode === "close") {
        yield* Effect.sync(() => {
          try {
            options.daemonTelemetry?.capture("routekit.daemon_lifecycle", {
              action: "stopped",
              outcome: "success",
              supervisor: options.supervisor,
              version: options.packageVersion
            });
          } catch (error) {
            process.stderr.write(
              `routekit daemon stop telemetry failed: ${error instanceof Error ? error.message : String(error)}\n`
            );
          }
        });
      }
      options.runtimeState.markDraining();
      yield* shutdownResources(mode, graceMs).pipe(
        Effect.mapError((cause) => routeKitError(cause))
      );
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          removeSighupListener();
          options.runtimeState.markClosed();
        })
      ),
      Effect.matchEffect({
        onFailure: (error) =>
          Deferred.fail(shutdownLatch!, error).pipe(Effect.andThen(Effect.fail(error))),
        onSuccess: () => Deferred.succeed(shutdownLatch!, undefined)
      })
    );
    return shutdownOwner;
  };
  const close = (): Effect.Effect<void, Error, RouteKitPlatform> =>
    shutdown("close", options.drainGraceMs);

  extendCleanupGrace(options.drainGraceMs + 10_000);
  registerCleanup(() => runRouteKitEffect(close()).catch(() => undefined));
  const onSighup = (): void => {
    void runRouteKitEffect(reload(options.handlers, "sighup")).catch((error: unknown) => {
      process.stderr.write(
        `routekit daemon reload failed: ${error instanceof Error ? error.message : String(error)}\n`
      );
    });
  };
  process.on("SIGHUP", onSighup);
  removeSighupListener = () => process.off("SIGHUP", onSighup);

  return {
    close,
    retire: (graceMs = options.drainGraceMs) => shutdown("retire", graceMs),
    pauseMutations: () =>
      Effect.gen(function* () {
        yield* Effect.try({
          try: () => {
            options.runtimeState.pause();
          },
          catch: toRouteKitFailure
        });
        yield* options.runtimeState.awaitMutations();
        return options.runtimeState.snapshot();
      }),
    resumeMutations: () => {
      options.runtimeState.resume();
    },
    snapshot: () => options.runtimeState.snapshot(),
    reload: () => reload(options.handlers, "direct")
  };
}

export function cleanupFailedDaemon(input: {
  gatewayTelemetry?: GatewayTelemetryAggregator;
  daemonTelemetry?: DaemonTelemetry;
  proxy?: SwitchingGatewayProxy;
  activeRouter?: RunningRouter;
  accountActivity?: AccountActivityService;
  accountAuth?: AccountAuthService;
  closeSidecar(): Effect.Effect<void, Error>;
  control?: RunningControlServer;
  cleanupRegistration(): void;
  effectRuntime?: ManagedRuntime.ManagedRuntime<any, never>;
}): Effect.Effect<void, Error, RouteKitPlatform> {
  return Effect.gen(function* () {
    const scope = new EffectResourceScope();
    yield* scope.defer(async () => await input.effectRuntime?.dispose());
    yield* scope.defer(() => input.cleanupRegistration());
    yield* scope.defer(async () => await input.control?.close());
    yield* scope.deferEffect(input.closeSidecar());
    if (input.accountAuth !== undefined) {
      yield* scope.deferEffect(input.accountAuth.close as Effect.Effect<void, unknown>);
    }
    if (input.accountActivity !== undefined) {
      yield* scope.deferEffect(input.accountActivity.close as Effect.Effect<void, unknown>);
    }
    yield* scope.defer(async () => await input.activeRouter?.close());
    yield* scope.defer(async () => await input.proxy?.close());
    yield* scope.defer(async () => await input.daemonTelemetry?.shutdown());
    yield* scope.defer(() => input.gatewayTelemetry?.close());
    yield* scope.dispose().pipe(Effect.mapError((cause) => routeKitError(cause)));
  });
}

function reload(handlers: RouteKitControlHandlers, requestId: string): Effect.Effect<void, Error> {
  return Effect.tryPromise({
    try: () =>
      Promise.resolve(
        handlers["daemon.reload"](
          {},
          {
            signal: new AbortController().signal,
            requestId
          }
        )
      ).then(() => undefined),
    catch: toRouteKitFailure
  });
}
