import type {
  AccountActivityService,
  AccountAuthService
} from "@velum-labs/routekit-accounts/effect";
import type { RouteKitControlHandlers } from "@velum-labs/routekit-control";
import type { SwitchingGatewayProxy } from "@velum-labs/routekit-gateway";
import { extendCleanupGrace, registerCleanup } from "@velum-labs/routekit-runtime";
import type { RunningControlServer } from "@velum-labs/routekit-runtime/control";
import { ResourceDisposalTimeoutError } from "@velum-labs/routekit-runtime/lifecycle";
import {
  type RouteKitPlatform,
  routeKitError,
  runRouteKitEffect,
  toRouteKitFailure
} from "@velum-labs/routekit-runtime/effect";
import { Cause, Deferred, Effect, Exit, type ManagedRuntime, Scope } from "effect";

import type { DaemonRuntimeState } from "./daemon-runtime-state.js";
import type { RunningGatewayGeneration } from "./services/gateway-generation/service.js";
import type { DaemonTelemetry, GatewayTelemetryAggregator } from "./telemetry.js";

type Supervisor = "systemd" | "launchd" | "detached" | "unknown";

export type DaemonLifecycleOptions = {
  runtimeState: DaemonRuntimeState;
  handlers: RouteKitControlHandlers;
  drainGraceMs: number;
  packageVersion: string;
  supervisor: Supervisor;
  getProxy(): SwitchingGatewayProxy | undefined;
  getActiveRouter(): RunningGatewayGeneration | undefined;
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

type DaemonFinalizer = Effect.Effect<void, unknown, RouteKitPlatform>;

function callbackFinalizer(run: () => unknown): Effect.Effect<void, Error> {
  return Effect.tryPromise({
    try: async () => {
      await run();
    },
    catch: toRouteKitFailure
  });
}

function closeDaemonResources(
  finalizers: readonly DaemonFinalizer[],
  shutdownBudgetMs?: number
): Effect.Effect<void, Error, RouteKitPlatform> {
  return Effect.gen(function* () {
    const platform = yield* Effect.context<RouteKitPlatform>();
    const scope = yield* Scope.make("sequential");
    const errors: unknown[] = [];
    const deadline =
      shutdownBudgetMs === undefined ? undefined : Date.now() + shutdownBudgetMs;

    for (const finalizer of finalizers) {
      yield* Scope.addFinalizer(
        scope,
        Effect.suspend(() => {
          const remaining =
            deadline === undefined ? undefined : Math.max(0, deadline - Date.now());
          const bounded =
            remaining === undefined
              ? finalizer
              : finalizer.pipe(
                  Effect.timeoutOrElse({
                    duration: remaining,
                    orElse: () =>
                      Effect.fail(new ResourceDisposalTimeoutError(shutdownBudgetMs!))
                  })
                );
          return Effect.exit(bounded.pipe(Effect.provide(platform))).pipe(
            Effect.flatMap((closed) =>
              Exit.isFailure(closed)
                ? Effect.sync(() => {
                    errors.push(Cause.squash(closed.cause));
                  })
                : Effect.void
            )
          );
        })
      );
    }

    yield* Scope.close(scope, Exit.void);
    if (errors.length > 0) {
      return yield* Effect.fail(
        new AggregateError(errors, "one or more daemon resource finalizers failed")
      );
    }
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
  ): Effect.Effect<void, Error, RouteKitPlatform> => {
    const finalizers: DaemonFinalizer[] = [
      // Native Scope finalizers run in LIFO order. Register the Effect runtime
      // first so it disposes last, after every Effect-owned resource.
      callbackFinalizer(async () => await options.effectRuntime?.dispose()),
      callbackFinalizer(() => options.cleanupRegistration()),
      callbackFinalizer(() => options.gatewayTelemetry?.close()),
      callbackFinalizer(async () => await options.daemonTelemetry?.shutdown()),
      options.closeSidecar()
    ];
    if (options.accountAuth !== undefined) {
      finalizers.push(options.accountAuth.close as Effect.Effect<void, unknown, RouteKitPlatform>);
    }
    if (options.accountActivity !== undefined) {
      finalizers.push(
        options.accountActivity.close as Effect.Effect<void, unknown, RouteKitPlatform>
      );
    }
    const activeRouter = options.getActiveRouter();
    if (activeRouter !== undefined) finalizers.push(activeRouter.close);
    const proxy = options.getProxy();
    if (proxy !== undefined) {
      finalizers.push(mode === "retire" ? proxy.retire(graceMs) : proxy.drain(graceMs));
    }
    const control = options.getControl();
    if (control !== undefined) {
      finalizers.push(
        mode === "retire" ? control.retire(Math.min(graceMs, 2_000)) : control.close
      );
    }
    return closeDaemonResources(finalizers, graceMs + 10_000);
  };

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
  activeRouter?: RunningGatewayGeneration;
  accountActivity?: AccountActivityService;
  accountAuth?: AccountAuthService;
  closeSidecar(): Effect.Effect<void, Error>;
  control?: RunningControlServer;
  cleanupRegistration(): void;
  effectRuntime?: ManagedRuntime.ManagedRuntime<any, never>;
}): Effect.Effect<void, Error, RouteKitPlatform> {
  const finalizers: DaemonFinalizer[] = [
    callbackFinalizer(async () => await input.effectRuntime?.dispose()),
    callbackFinalizer(() => input.cleanupRegistration())
  ];
  if (input.control !== undefined) finalizers.push(input.control.close);
  finalizers.push(input.closeSidecar());
  if (input.accountAuth !== undefined) {
    finalizers.push(input.accountAuth.close as Effect.Effect<void, unknown, RouteKitPlatform>);
  }
  if (input.accountActivity !== undefined) {
    finalizers.push(input.accountActivity.close as Effect.Effect<void, unknown, RouteKitPlatform>);
  }
  if (input.activeRouter !== undefined) finalizers.push(input.activeRouter.close);
  if (input.proxy !== undefined) finalizers.push(input.proxy.close);
  finalizers.push(
    callbackFinalizer(async () => await input.daemonTelemetry?.shutdown()),
    callbackFinalizer(() => input.gatewayTelemetry?.close())
  );
  return closeDaemonResources(finalizers);
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
