import { join } from "node:path";
import {
  CLIPROXY_API_KEY_ENV,
  CLIPROXY_BASE_URL_ENV,
  cliproxyApiKey,
  cliproxyBaseUrl,
  subscriptionAccountIdentity,
  subscriptionCredentialFingerprint
} from "@velum-labs/routekit-accounts";
import { AccountActivity, AccountAuth } from "@velum-labs/routekit-accounts/effect";
import type { LeaderboardConfig, RouterConfig } from "@velum-labs/routekit-config";
import { resolveLeaderboardConfig } from "@velum-labs/routekit-config";
import type {
  RouteKitControlHandlers,
  RouteKitControlMethod,
  RouteKitControlParams
} from "@velum-labs/routekit-control";
import {
  ROUTEKIT_CONTROL_CAPABILITY,
  ROUTEKIT_DAEMON_ROLL_CAPABILITY
} from "@velum-labs/routekit-control";
import type { EffectRouteKitControlHandlers } from "@velum-labs/routekit-control/effect";
import type { SwitchingGatewayProxy } from "@velum-labs/routekit-gateway";
import { createWorkloadJwtVerifier } from "@velum-labs/routekit-gateway";
import { startSwitchingGatewayProxyEffect } from "@velum-labs/routekit-gateway/effect";
import type { RunningControlServer } from "@velum-labs/routekit-runtime/control";
import {
  CONTROL_PROTOCOL_VERSION,
  ControlError,
  generateControlToken
} from "@velum-labs/routekit-runtime/control";
import {
  RouteKitFailure,
  RouteKitLive,
  startControlServerEffect,
  toRouteKitFailure,
  withAbortSignal
} from "@velum-labs/routekit-runtime/effect";
import type { PortlessSession } from "@velum-labs/routekit-runtime/network";
import { createPortlessSession } from "@velum-labs/routekit-runtime/network";
import type { ServiceRecord } from "@velum-labs/routekit-runtime/service";
import {
  nextServiceGeneration,
  processIdentity,
  supervisorFromEnv
} from "@velum-labs/routekit-runtime/service";
import { Context, Effect, Layer, Ref } from "effect";

import type { AccountTransactionRecovery } from "../account-transaction.js";
import { callInspection } from "../call-attribution-store.js";
import {
  createCliproxySidecar,
  createHostedCliproxySidecar
} from "../cliproxy-sidecar.js";
import { createDaemonControlDispatch } from "../control-dispatch.js";
import type { DaemonBootstrapPreflight } from "../daemon-bootstrap-preflight.js";
import { prepareDaemonBootstrap } from "../daemon-bootstrap-preflight.js";
import type { RouteKitDaemonOptions } from "../daemon-options.js";
import { createDaemonControlHandlers } from "../daemon-control-handlers.js";
import { createDaemonGenerationManager } from "../daemon-generations.js";
import {
  accountEntriesWithPaths,
  canonicalConfigDocument,
  redactedProcessArgs
} from "../daemon-maintenance.js";
import {
  healthyControl,
  removeDaemonPublicRecord,
  workloadJwtOptions,
  writeDaemonPublicRecord,
  writeDaemonRevisions
} from "../daemon-state.js";
import { makeCompositionalRoutingPolicyReader } from "../eval-routing-policy.js";
import { DAEMON_HOST_PROTOCOL_VERSION } from "../host-protocol.js";
import { LeaderboardRollupStore } from "../leaderboard.js";
import { AccountRecovery } from "../account-recovery-context.js";
import { ActiveGateway } from "../services/active-gateway/service.js";
import { CallAttributions } from "../services/call-attributions/service.js";
import { DaemonEnv } from "../daemon-env-context.js";
import { DaemonHost } from "../daemon-host-context.js";
import { DaemonPolicy } from "../daemon-policy-context.js";
import { DaemonRuntime } from "../services/daemon-runtime/service.js";
import { DaemonState } from "../daemon-state-context.js";
import { DataPlane } from "../data-plane-context.js";
import { EvalSessions } from "../services/eval-session/service.js";
import type { RunningGatewayGeneration } from "../gateway-generation.js";
import { Generations } from "../services/generations/service.js";
import { Leaderboard } from "../leaderboard-context.js";
import { Sidecar } from "../sidecar-context.js";
import { Telemetry } from "../services/telemetry/service.js";
import { Tokens } from "../services/tokens/service.js";

const ROUTEKIT_DAEMON_KIND = "daemon";
const ROUTEKIT_PRODUCT = "routekit";

export type DaemonLiveOptions = RouteKitDaemonOptions;

type Foundation = DaemonBootstrapPreflight & {
  readonly generation: number;
  readonly previous: ServiceRecord | undefined;
};

class DaemonFoundation extends Context.Service<DaemonFoundation, Foundation>()(
  "@velum-labs/routekit-daemon/DaemonFoundation"
) {}

export type DaemonLive =
  | DaemonRuntime
  | DaemonEnv
  | DaemonState
  | Sidecar
  | Tokens
  | EvalSessions
  | Telemetry
  | ActiveGateway
  | AccountActivity
  | AccountAuth
  | Generations
  | DataPlane
  | AccountRecovery
  | CallAttributions
  | Leaderboard
  | DaemonPolicy
  | DaemonHost;

const prepareFoundation = (options: RouteKitDaemonOptions) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: async (): Promise<Foundation> => {
        const preflight = await prepareDaemonBootstrap(options);
        const previous =
          preflight.hosted === undefined
            ? preflight.store.read(ROUTEKIT_DAEMON_KIND)
            : undefined;
        if (
          preflight.hosted === undefined &&
          previous !== undefined &&
          previous.pid !== process.pid &&
          (await healthyControl(previous))
        ) {
          throw new ControlError({
            code: "conflict",
            message: `RouteKit daemon is already running (pid ${previous.pid})`
          });
        }
        if (
          preflight.hosted === undefined &&
          previous !== undefined &&
          previous.pid !== process.pid
        ) {
          throw new ControlError({
            code: "unavailable",
            message: `RouteKit daemon pid ${previous.pid} is alive but its control plane is unhealthy; stop it before recovery`
          });
        }
        const generation =
          preflight.hosted?.generation ??
          nextServiceGeneration(
            Math.max(previous?.generation ?? 0, preflight.runtimeState.revisions.daemon)
          );
        if (preflight.hosted === undefined) {
          preflight.runtimeState.revisions.daemon = generation;
          writeDaemonRevisions(preflight.home, preflight.runtimeState.revisions);
        }
        return { ...preflight, generation, previous };
      },
      catch: toRouteKitFailure
    }),
    (foundation) =>
      Effect.sync(() => {
        foundation.authority?.release();
      })
  );

const wantsSidecar = (config: RouterConfig): boolean =>
  config.providers.cliproxy !== undefined;

const activeCredentialFingerprints = (env: NodeJS.ProcessEnv): Map<string, string> =>
  new Map(
    accountEntriesWithPaths(env).flatMap((entry) =>
      entry.connector === "native"
        ? [
            [
              subscriptionAccountIdentity(entry.subscriptionKind, entry.label),
              subscriptionCredentialFingerprint(entry.path)
            ] as const
          ]
        : []
    )
  );

const routerEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const injected: NodeJS.ProcessEnv = { ...env };
  if ((env[CLIPROXY_API_KEY_ENV] ?? "").length === 0) {
    const key = cliproxyApiKey(env);
    if (key !== undefined) injected[CLIPROXY_API_KEY_ENV] = key;
  }
  if ((env[CLIPROXY_BASE_URL_ENV] ?? "").length === 0) {
    injected[CLIPROXY_BASE_URL_ENV] = cliproxyBaseUrl(env);
  }
  return injected;
};

function promiseHandlers(
  handlers: EffectRouteKitControlHandlers,
  context: Context.Context<DaemonLive>
): RouteKitControlHandlers {
  return new Proxy(handlers, {
    get(target, method, receiver) {
      const handler = Reflect.get(target, method, receiver) as
        | ((params: never, context: never) => Effect.Effect<unknown, Error, any>)
        | undefined;
      if (typeof handler !== "function") return handler;
      return (
        params: RouteKitControlParams[RouteKitControlMethod],
        handlerContext: Parameters<RouteKitControlHandlers[RouteKitControlMethod]>[1]
      ) =>
        Effect.runPromiseWith(context)(
          withAbortSignal(handler(params as never, handlerContext as never), handlerContext.signal)
        );
    }
  }) as unknown as RouteKitControlHandlers;
}

const acquireRunningDaemon = Effect.fn("Daemon.acquireRunning")(function* (
  options: RouteKitDaemonOptions
) {
  const foundation = yield* DaemonFoundation;
  const state = yield* DaemonState;
  const sidecar = yield* Sidecar;
  const generations = yield* Generations;
  const gateway = yield* ActiveGateway;
  const evalSessions = yield* EvalSessions;
  const tokens = yield* Tokens;
  const telemetry = yield* Telemetry;
  const auth = yield* AccountAuth;
  const context = yield* Effect.context<DaemonLive>();
  const provideRuntime = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E> =>
    effect.pipe(Effect.provide(context as Context.Context<R>));
  yield* Effect.addFinalizer(() => Effect.sync(() => foundation.runtimeState.markClosed()));

  yield* sidecar.reconcile(wantsSidecar(state.config));
  const router = yield* generations.start(state.config);
  yield* Ref.update(gateway.state, (current) => ({ ...current, router }));
  yield* Effect.addFinalizer(() => {
    const active = gateway.router();
    return active === undefined ? Effect.void : active.close.pipe(Effect.ignore);
  });
  yield* auth.reconcileActiveCredentials(activeCredentialFingerprints(foundation.env));

  const workloadJwt = workloadJwtOptions(options.workloadJwt, foundation.env);
  const verifyWorkloadJwt =
    workloadJwt === undefined ? undefined : createWorkloadJwtVerifier(workloadJwt);
  const proxy = yield* startSwitchingGatewayProxyEffect({
    target: router.url,
    host: options.host ?? "127.0.0.1",
    port: options.port ?? 8080,
    authToken: tokens.dataAuth.token,
    resolveDataPrincipal: (presented) => {
      const evalPrincipal = evalSessions.resolve(presented);
      if (evalPrincipal !== undefined) return evalPrincipal;
      const principal = tokens.resolve(presented, "data");
      return principal === undefined
        ? verifyWorkloadJwt?.(presented)
        : { id: principal.id, label: principal.label, role: principal.role };
    }
  });
  yield* Effect.addFinalizer(() => proxy.drain(foundation.drainGraceMs).pipe(Effect.ignore));

  const portless: PortlessSession | undefined =
    foundation.hosted === undefined
      ? yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: () =>
              createPortlessSession(
                options.portless ?? foundation.env.ROUTEKIT_PORTLESS !== "0",
                { project: ROUTEKIT_PRODUCT, ownerLabel: "routekit-daemon", bareNames: [] }
              ),
            catch: toRouteKitFailure
          }),
          (session) =>
            Effect.sync(() => {
              if (session.enabled) session.unregister("gateway");
            })
        )
      : undefined;
  const dataUrl =
    foundation.hosted?.dataUrl() ??
    (portless?.enabled === true ? portless.register("gateway", proxy.port()) : proxy.url());
  yield* Ref.update(gateway.state, (current) => ({ ...current, proxy, dataUrl }));

  const handlers = promiseHandlers(createDaemonControlHandlers(), context);
  const dispatch = createDaemonControlDispatch({
    handlers,
    runtimeState: foundation.runtimeState,
    packageVersion: options.packageVersion,
    daemonTelemetry: telemetry.daemon,
    ...(foundation.hosted?.executeIdempotent === undefined
      ? {}
      : { executeIdempotent: foundation.hosted.executeIdempotent })
  });
  const control = yield* startControlServerEffect({
    handler: dispatch,
    token: foundation.hosted?.controlToken ?? generateControlToken(),
    product: ROUTEKIT_PRODUCT,
    packageVersion: options.packageVersion,
    port: options.controlPort,
    capabilities: [
      ROUTEKIT_CONTROL_CAPABILITY,
      ...(foundation.hosted === undefined ? [] : [ROUTEKIT_DAEMON_ROLL_CAPABILITY])
    ],
    authorize: (presented) => {
      const principal = tokens.resolve(presented, "control");
      return principal === undefined
        ? undefined
        : { id: principal.id, label: principal.label, role: principal.role };
    },
    onError: (error, errorContext) => {
      const operation = errorContext.method ?? "control transport";
      process.stderr.write(
        `RouteKit ${operation} failed (request ${errorContext.requestId}): ${String(error)}\n`
      );
    }
  });
  yield* Effect.addFinalizer(() => control.close.pipe(Effect.ignore));
  yield* Ref.update(gateway.state, (current) => ({ ...current, control }));

  const recordInput = {
    kind: ROUTEKIT_DAEMON_KIND,
    pid: process.pid,
    ...(processIdentity(process.pid) === undefined
      ? {}
      : { processIdentity: processIdentity(process.pid) }),
    url: control.url,
    port: control.port,
    startedAt: foundation.startedAt,
    version: options.packageVersion,
    protocolVersion: CONTROL_PROTOCOL_VERSION,
    controlToken: control.token,
    dataUrl,
    dataPort: proxy.port(),
    host: options.host ?? "127.0.0.1",
    portless: portless?.enabled ?? false,
    drainGraceMs: foundation.drainGraceMs,
    authTokenFile: tokens.dataAuth.path,
    generation: foundation.generation,
    supervisor: supervisorFromEnv(foundation.env),
    ...(process.argv[1] === undefined ? {} : { binPath: process.argv[1] }),
    args: redactedProcessArgs(process.argv.slice(2)),
    cwd: process.cwd()
  } satisfies Omit<ServiceRecord, "product" | "owner">;
  const record =
    foundation.hosted === undefined
      ? foundation.store.write(recordInput)
      : { product: ROUTEKIT_PRODUCT, owner: ROUTEKIT_PRODUCT, ...recordInput };
  if (foundation.hosted === undefined) {
    writeDaemonPublicRecord(foundation.home, {
      product: ROUTEKIT_PRODUCT,
      kind: ROUTEKIT_DAEMON_KIND,
      url: control.url,
      port: control.port,
      generation: foundation.generation,
      protocolVersion: CONTROL_PROTOCOL_VERSION,
      dataUrl,
      dataPort: proxy.port(),
      startedAt: foundation.startedAt
    });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        foundation.store.remove(ROUTEKIT_DAEMON_KIND, { ifPid: process.pid });
        removeDaemonPublicRecord(foundation.home);
      })
    );
  }

  telemetry.daemon.capture("routekit.daemon_lifecycle", {
    action: "started",
    outcome: "success",
    supervisor: (["systemd", "launchd", "detached"] as const).includes(
      supervisorFromEnv(foundation.env) as never
    )
      ? (supervisorFromEnv(foundation.env) as "systemd" | "launchd" | "detached")
      : "unknown",
    version: options.packageVersion
  });

  const prepareClose = Effect.gen(function* () {
    foundation.runtimeState.beginShutdown();
    yield* foundation.runtimeState.awaitMutations();
    telemetry.daemon.capture("routekit.daemon_lifecycle", {
      action: "stopped",
      outcome: "success",
      supervisor: (["systemd", "launchd", "detached"] as const).includes(
        supervisorFromEnv(foundation.env) as never
      )
        ? (supervisorFromEnv(foundation.env) as "systemd" | "launchd" | "detached")
        : "unknown",
      version: options.packageVersion
    });
    foundation.runtimeState.markDraining();
    yield* proxy.drain(foundation.drainGraceMs);
  });
  const prepareRetire = (graceMs = foundation.drainGraceMs) =>
    Effect.gen(function* () {
      foundation.runtimeState.beginRetire();
      yield* foundation.runtimeState.awaitMutations();
      foundation.runtimeState.markDraining();
      yield* Effect.all([proxy.retire(graceMs), control.retire(Math.min(graceMs, 2_000))], {
        concurrency: "unbounded"
      });
    });
  const reload = Effect.gen(function* () {
    const document = canonicalConfigDocument(foundation.configPath);
    yield* generations.replace(
      foundation.runtimeState.config,
      document,
      { write: false, configRevision: true }
    );
  });

  return DaemonRuntime.of({
    record,
    dataUrl,
    controlUrl: control.url,
    prepareClose: provideRuntime(prepareClose),
    prepareRetire: (graceMs) => provideRuntime(prepareRetire(graceMs)),
    pauseMutations: provideRuntime(Effect.gen(function* () {
      foundation.runtimeState.pause();
      yield* foundation.runtimeState.awaitMutations();
      return foundation.runtimeState.snapshot();
    })),
    resumeMutations: provideRuntime(Effect.sync(() => foundation.runtimeState.resume())),
    snapshot: provideRuntime(Effect.sync(() => foundation.runtimeState.snapshot())),
    reload: provideRuntime(reload)
  });
});

/** Construct and own the complete daemon worker lifetime. */
export function daemonLive(options: DaemonLiveOptions): Layer.Layer<DaemonLive, Error> {
  const foundation = Layer.effect(DaemonFoundation, prepareFoundation(options));
  const platform = RouteKitLive.pipe(Layer.provideMerge(foundation));

  const owned = Layer.mergeAll(
    Layer.effect(
      Sidecar,
      Effect.flatMap(DaemonFoundation, (value) =>
        Effect.acquireRelease(
          Effect.sync(() =>
            value.hosted === undefined
              ? createCliproxySidecar({ env: value.env })
              : createHostedCliproxySidecar(value.hosted.sidecarRequest)
          ),
          (sidecar) => sidecar.close.pipe(Effect.ignore)
        )
      )
    ),
    Layer.unwrap(
      Effect.map(DaemonFoundation, (value) =>
        Tokens.layer({
          home: value.home,
          ...(options.authToken === undefined ? {} : { authToken: options.authToken }),
          ...(options.authTokenFile === undefined
            ? {}
            : { authTokenFile: options.authTokenFile })
        })
      )
    ),
    Layer.unwrap(
      Effect.map(DaemonFoundation, (value) =>
        Telemetry.layer({
          home: value.home,
          env: value.env,
          packageVersion: options.packageVersion,
          ...(options.telemetryTransportFactory === undefined
            ? {}
            : { transportFactory: options.telemetryTransportFactory }),
          ...(options.telemetryFlushIntervalMs === undefined
            ? {}
            : { flushIntervalMs: options.telemetryFlushIntervalMs })
        })
      )
    ),
    Layer.effect(
      Leaderboard,
      Effect.flatMap(DaemonFoundation, (value) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            let config: LeaderboardConfig = resolveLeaderboardConfig(value.runtimeState.config);
            const rollups = new LeaderboardRollupStore({ home: value.home, config });
            return Leaderboard.of({
              rollups,
              config: () => config,
              applyConfig: (next) => {
                config = resolveLeaderboardConfig(next);
                rollups.configure({
                  durable: config.durable,
                  durableRetentionDays: config.durableRetentionDays
                });
              }
            });
          }),
          (leaderboard) => Effect.sync(() => leaderboard.rollups.flush())
        )
      )
    ),
    EvalSessions.layer()
  ).pipe(Layer.provideMerge(platform));

  const staticServices = Layer.mergeAll(
    Layer.effect(
      DaemonEnv,
      Effect.map(DaemonFoundation, (value) =>
        DaemonEnv.of({
          home: value.home,
          configPath: value.configPath,
          env: value.env,
          packageVersion: options.packageVersion,
          generation: value.generation,
          startedAt: value.startedAt,
          hosted: value.hosted
        })
      )
    ),
    Layer.unwrap(
      Effect.map(DaemonFoundation, (value) => DaemonState.layer(value.runtimeState))
    ),
    Layer.effect(
      DataPlane,
      Effect.map(Tokens, (tokens) => ({
        token: tokens.dataAuth.token,
        path: tokens.dataAuth.path
      }))
    ),
    Layer.effect(
      AccountRecovery,
      Effect.map(DaemonFoundation, (value) => value.accountRecovery)
    ),
    Layer.unwrap(
      Effect.map(DaemonFoundation, (value) =>
        CallAttributions.layer(resolveLeaderboardConfig(value.runtimeState.config))
      )
    ),
    Layer.effect(
      DaemonPolicy,
      Effect.succeed({ wantsCliproxySidecar: wantsSidecar })
    ),
    Layer.effect(
      DaemonHost,
      Effect.map(DaemonFoundation, (value) => ({
        ...(options.onShutdownRequested === undefined
          ? {}
          : {
              onShutdownRequested: (reason: "stop" | "restart" | "upgrade") =>
                Effect.sync(() => options.onShutdownRequested?.(reason))
            }),
        ...(options.onRollRequested === undefined
          ? {}
          : {
              onRollRequested: (params: RouteKitControlParams["daemon.roll"]) =>
                Effect.tryPromise({
                  try: () => options.onRollRequested!(params),
                  catch: toRouteKitFailure
                })
            }),
        ...(options.onAccountTransactionPhase === undefined
          ? {}
          : { onAccountTransactionPhase: options.onAccountTransactionPhase })
      }))
    ),
    ActiveGateway.layer,
    Layer.unwrap(
      Effect.map(DaemonFoundation, (value) =>
        AccountActivity.layer({ statePath: join(value.home, "usage", "account-activity.v1.json") })
      )
    ),
    Layer.unwrap(
      Effect.map(DaemonFoundation, (value) =>
        AccountAuth.layer({ statePath: join(value.home, "subscriptions", "account-auth.v1.json") })
      )
    )
  ).pipe(Layer.provideMerge(owned));

  const generations = Layer.effect(
    Generations,
    Effect.gen(function* () {
      const foundation = yield* DaemonFoundation;
      const state = yield* DaemonState;
      const sidecar = yield* Sidecar;
      const activity = yield* AccountActivity;
      const auth = yield* AccountAuth;
      const gateway = yield* ActiveGateway;
      const callAttributions = yield* CallAttributions;
      const leaderboard = yield* Leaderboard;
      const telemetry = yield* Telemetry;
      return createDaemonGenerationManager({
        configPath: foundation.configPath,
        home: foundation.home,
        drainGraceMs: foundation.drainGraceMs,
        sidecar,
        routerEnv: () => routerEnv(foundation.env),
        provenance: {
          onModelCall(record) {
            callAttributions.onModelCall(record);
            const inspection = callInspection(record);
            if (inspection !== undefined) leaderboard.rollups.record(inspection);
            telemetry.gateway.record(record);
          }
        },
        compositionalPolicyReader: makeCompositionalRoutingPolicyReader(foundation.home),
        activity,
        authHealth: auth,
        wantsSidecar,
        getCurrentConfig: () => state.config,
        setCurrentConfig: (config) => {
          state.config = config;
        },
        getCurrentDocument: () => state.document,
        setCurrentDocument: (document) => {
          state.document = document;
        },
        getRevisions: () => state.revisions,
        setRevisions: (revisions) => {
          state.revisions = revisions;
        },
        getActiveRouter: () => gateway.router(),
        setActiveRouter: (router) =>
          Ref.update(gateway.state, (current) => ({ ...current, router })),
        getProxy: () => gateway.proxy(),
        activeCredentialFingerprints: () => activeCredentialFingerprints(foundation.env),
        applyConfig: (config) => {
          leaderboard.applyConfig(config);
          const current = leaderboard.config();
          callAttributions.configureBudget({
            limit: current.liveLimit,
            ttlMs: current.liveTtlHours * 60 * 60 * 1_000
          });
        },
        ...(options.onGenerationStage === undefined ? {} : { onStage: options.onGenerationStage })
      });
    })
  ).pipe(Layer.provideMerge(staticServices));

  return Layer.effect(DaemonRuntime, acquireRunningDaemon(options)).pipe(
    Layer.provideMerge(generations)
  ) as Layer.Layer<DaemonLive, Error>;
}
