/**
 * Singleton RouteKit daemon.
 *
 * One process owns a private authenticated control listener and one stable
 * model-gateway front door. Router generations run on ephemeral loopback
 * ports behind that front door; config/account reload builds a complete new
 * generation before atomically switching new traffic and draining the old.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  CLIPROXY_API_KEY_ENV,
  CLIPROXY_BASE_URL_ENV,
  cliproxyApiKey,
  cliproxyBaseUrl,
  subscriptionAccountIdentity,
  subscriptionCredentialFingerprint
} from "@velum-labs/routekit-accounts";
import {
  AccountActivity,
  type AccountActivityService,
  AccountAuth,
  type AccountAuthService
} from "@velum-labs/routekit-accounts/effect";
import type { LeaderboardConfig, RouterConfig } from "@velum-labs/routekit-config";
import { configuredProviderIds, resolveLeaderboardConfig } from "@velum-labs/routekit-config";
import type {
  DaemonStatus,
  RouteKitControlHandlers,
  RouteKitControlMethod,
  RouteKitControlParams
} from "@velum-labs/routekit-control";
import {
  ROUTEKIT_CONTROL_CAPABILITY,
  ROUTEKIT_DAEMON_ROLL_CAPABILITY
} from "@velum-labs/routekit-control";
import { toPromiseControlHandlers } from "@velum-labs/routekit-control/effect";
import type {
  SwitchingGatewayProxy,
  WorkloadJwtVerifierOptions
} from "@velum-labs/routekit-gateway";
import { createWorkloadJwtVerifier, resolveCodexStartupModel } from "@velum-labs/routekit-gateway";
import { startSwitchingGatewayProxyEffect } from "@velum-labs/routekit-gateway/effect";
import type { RunningControlServer } from "@velum-labs/routekit-runtime/control";
import {
  CONTROL_PROTOCOL_VERSION,
  ControlError,
  generateControlToken
} from "@velum-labs/routekit-runtime/control";
import {
  RouteKitFailure,
  runRouteKitEffect,
  startControlServerEffect,
  toRouteKitFailure
} from "@velum-labs/routekit-runtime/effect";
import type { PortlessSession } from "@velum-labs/routekit-runtime/network";
import { createPortlessSession } from "@velum-labs/routekit-runtime/network";
import type { ServiceRecord } from "@velum-labs/routekit-runtime/service";
import {
  nextServiceGeneration,
  processIdentity,
  supervisorFromEnv
} from "@velum-labs/routekit-runtime/service";
import { createConsentManager } from "@velum-labs/routekit-telemetry-core";
import { Effect, Layer, ManagedRuntime } from "effect";
import { CallAttributionStore, callInspection } from "./call-attribution-store.js";
import type { CliproxySidecar } from "./cliproxy-sidecar.js";
import { createCliproxySidecar } from "./cliproxy-sidecar.js";
import { createDaemonControlDispatch } from "./control-dispatch.js";
import { prepareDaemonBootstrap } from "./daemon-bootstrap-preflight.js";
import { createDaemonControlHandlers } from "./daemon-control-handlers.js";
import {
  captureDaemonStarted,
  cleanupFailedDaemon,
  createDaemonLifecycle
} from "./daemon-lifecycle.js";
import {
  accountEntries,
  accountEntriesWithPaths,
  redactedProcessArgs
} from "./daemon-maintenance.js";
import {
  type DaemonPublicRecord,
  daemonPublicRecordPath,
  dataTokenForPrincipal,
  healthyControl,
  type RevisionState,
  removeDaemonPublicRecord,
  workloadJwtOptions,
  writeDaemonPublicRecord,
  writeDaemonRevisions,
  writeSnapshot
} from "./daemon-state.js";
import { type DaemonLive, daemonLive } from "./effect/daemon-live.js";
import { makeCompositionalRoutingPolicyReader } from "./eval-routing-policy.js";
import { DAEMON_HOST_PROTOCOL_VERSION } from "./host-protocol.js";
import { LeaderboardRollupStore } from "./leaderboard.js";
import { ActiveGateway, type ActiveGatewayValue } from "./services/active-gateway/service.js";
import { EvalSessionManager } from "./services/eval-session-manager/service.js";
import type { RunningGatewayGeneration } from "./services/gateway-generation/service.js";
import { Generations } from "./services/generations/service.js";
import {
  DaemonTelemetry,
  DEFAULT_TELEMETRY_HOST,
  GatewayTelemetryAggregator,
  resolveTelemetryProjectKey,
  type TelemetryTransportFactory
} from "./telemetry.js";

export const ROUTEKIT_DAEMON_KIND = "daemon";
export const ROUTEKIT_PRODUCT = "routekit";

export type RouteKitDaemonOptions = {
  packageVersion: string;
  env?: NodeJS.ProcessEnv;
  stateHome?: string;
  configPath?: string;
  host?: string;
  port?: number;
  controlPort?: number;
  authToken?: string;
  authTokenFile?: string;
  /** Optional short-lived workload JWT authorization policy. */
  workloadJwt?: WorkloadJwtVerifierOptions;
  portless?: boolean;
  drainGraceMs?: number;
  onShutdownRequested?: (reason: "stop" | "restart" | "upgrade") => void;
  onRollRequested?: (
    params: import("@velum-labs/routekit-control").RouteKitControlParams["daemon.roll"]
  ) => Promise<import("@velum-labs/routekit-control").RouteKitControlResults["daemon.roll"]>;
  hosted?: {
    generation: number;
    controlToken: string;
    dataUrl: () => string;
    hostPid: number;
    hostStartedAt: string;
    rolling: () => boolean;
    sidecar: CliproxySidecar;
    initiallyPaused?: boolean;
    executeIdempotent?<T>(input: {
      method: RouteKitControlMethod;
      key: string;
      params: RouteKitControlParams[RouteKitControlMethod];
      operation(): Promise<T>;
    }): Promise<T>;
  };
  /** Test seam for a network-free telemetry transport. */
  telemetryTransportFactory?: TelemetryTransportFactory;
  telemetryFlushIntervalMs?: number;
  /** Test seam used by child-process interruption coverage. */
  onAccountTransactionPhase?: (
    phase: "prepared" | "credentials-written" | "router-swapped" | "committed"
  ) => void;
  /** Test seam for generation transaction failure injection and stage assertions. */
  onGenerationStage?: import("./daemon-generations.js").DaemonGenerationManagerOptions["onStage"];
};

export type RunningRouteKitDaemon = {
  record: ServiceRecord;
  dataUrl: string;
  controlUrl: string;
  close(): Promise<void>;
  retire(graceMs?: number): Promise<void>;
  pauseMutations(): Promise<{
    configRevision: number;
    accountRevision: number;
    configHash: string;
  }>;
  resumeMutations(): void;
  snapshot(): {
    configRevision: number;
    accountRevision: number;
    configHash: string;
  };
  reload(): Promise<void>;
};

/**
 * Resolve (or mint) a data-plane token for the calling control principal so
 * tool launchers attribute usage to that admin rather than the owner token.
 * Plaintext is cached in-memory for the daemon lifetime.
 */
export async function bootstrapRouteKitDaemon(
  options: RouteKitDaemonOptions
): Promise<RunningRouteKitDaemon> {
  const {
    env,
    home,
    configPath,
    drainGraceMs,
    tokens,
    dataTokenCache,
    dataAuth,
    store,
    hosted,
    authority,
    accountRecovery,
    runtimeState,
    startedAt
  } = await prepareDaemonBootstrap(options);
  let control: RunningControlServer | undefined;
  let proxy: SwitchingGatewayProxy | undefined;
  let portless: PortlessSession | undefined;
  let sidecarRef: ReturnType<typeof createCliproxySidecar> | undefined;
  let activeRouter: RunningGatewayGeneration | undefined;
  let activeGateway: ActiveGatewayValue | undefined;
  let accountActivity: AccountActivityService | undefined;
  let accountAuth: AccountAuthService | undefined;
  let daemonTelemetry: DaemonTelemetry | undefined;
  let gatewayTelemetry: GatewayTelemetryAggregator | undefined;
  let record: ServiceRecord | undefined;
  let effectRuntime: ManagedRuntime.ManagedRuntime<DaemonLive, never> | undefined;

  try {
    const previous = hosted === undefined ? store.read(ROUTEKIT_DAEMON_KIND) : undefined;
    if (
      hosted === undefined &&
      previous !== undefined &&
      previous.pid !== process.pid &&
      (await healthyControl(previous))
    ) {
      throw new ControlError({
        code: "conflict",
        message: `RouteKit daemon is already running (pid ${previous.pid})`
      });
    }
    if (hosted === undefined && previous !== undefined && previous.pid !== process.pid) {
      // A live-but-unhealthy daemon is not safe to replace under its feet.
      throw new ControlError({
        code: "unavailable",
        message: `RouteKit daemon pid ${previous.pid} is alive but its control plane is unhealthy; stop it before recovery`
      });
    }
    const generation =
      hosted?.generation ??
      nextServiceGeneration(Math.max(previous?.generation ?? 0, runtimeState.revisions.daemon));
    if (hosted === undefined) {
      runtimeState.revisions.daemon = generation;
      writeDaemonRevisions(home, runtimeState.revisions);
    }
    const sidecar = hosted?.sidecar ?? createCliproxySidecar({ env });
    sidecarRef = sidecar;
    let leaderboardConfig: LeaderboardConfig = resolveLeaderboardConfig(runtimeState.config);
    const callAttributions = new CallAttributionStore({
      limit: leaderboardConfig.liveLimit,
      ttlMs: leaderboardConfig.liveTtlHours * 60 * 60 * 1_000
    });
    const leaderboardRollups = new LeaderboardRollupStore({
      home,
      config: leaderboardConfig
    });
    const telemetry = createConsentManager({
      path: () => join(home, "telemetry.json"),
      environmentVariable: "ROUTEKIT_TELEMETRY"
    });
    daemonTelemetry = new DaemonTelemetry({
      env,
      resolveConsent: telemetry.resolve,
      ...(options.telemetryTransportFactory !== undefined
        ? { factory: options.telemetryTransportFactory }
        : {})
    });
    gatewayTelemetry = new GatewayTelemetryAggregator({
      telemetry: daemonTelemetry,
      version: options.packageVersion,
      ...(options.telemetryFlushIntervalMs !== undefined
        ? { flushIntervalMs: options.telemetryFlushIntervalMs }
        : {})
    });
    // Independent of leaderboard durable rollups: last-selection only.
    mkdirSync(join(home, "usage"), { recursive: true, mode: 0o700 });
    mkdirSync(join(home, "subscriptions"), { recursive: true, mode: 0o700 });
    const activeCredentialFingerprints = (): Map<string, string> =>
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
    const applyLeaderboardConfig = (config: RouterConfig): void => {
      leaderboardConfig = resolveLeaderboardConfig(config);
      callAttributions.configureBudget({
        limit: leaderboardConfig.liveLimit,
        ttlMs: leaderboardConfig.liveTtlHours * 60 * 60 * 1_000
      });
      leaderboardRollups.configure({
        durable: leaderboardConfig.durable,
        durableRetentionDays: leaderboardConfig.durableRetentionDays
      });
    };
    const provenance = {
      onModelCall(record: Parameters<typeof callInspection>[0]): void {
        callAttributions.onModelCall(record);
        const inspection = callInspection(record);
        if (inspection !== undefined) leaderboardRollups.record(inspection);
        gatewayTelemetry?.record(record);
      }
    };
    const wantsCliproxySidecar = (config: RouterConfig): boolean =>
      config.providers["cliproxy"] !== undefined;
    // Router generations reach the managed sidecar with its own ingress key
    // and configured listen address; resolved per generation so state created
    // by the first login (key, config) is seen without a daemon restart.
    const routerEnv = (): NodeJS.ProcessEnv => {
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
    const compositionalPolicyReader = makeCompositionalRoutingPolicyReader(home);
    const evalSessions = new EvalSessionManager();
    effectRuntime = ManagedRuntime.make(
      daemonLive({
        env: {
          home,
          configPath,
          env,
          packageVersion: options.packageVersion,
          generation,
          startedAt,
          hosted
        },
        state: runtimeState,
        sidecar,
        tokens,
        evalSessions,
        telemetry: {
          consent: telemetry,
          ...(daemonTelemetry !== undefined ? { daemon: daemonTelemetry } : {}),
          ...(gatewayTelemetry !== undefined ? { gateway: gatewayTelemetry } : {})
        },
        activityPath: join(home, "usage", "account-activity.v1.json"),
        authPath: join(home, "subscriptions", "account-auth.v1.json"),
        generations: {
          drainGraceMs,
          routerEnv,
          provenance,
          compositionalPolicyReader,
          wantsSidecar: wantsCliproxySidecar,
          applyConfig: applyLeaderboardConfig,
          activeCredentialFingerprints,
          ...(options.onGenerationStage !== undefined ? { onStage: options.onGenerationStage } : {})
        },
        dataPlane: {
          token: dataAuth.token,
          path: dataAuth.path,
          cache: dataTokenCache
        },
        accountRecovery,
        callAttributions,
        leaderboard: {
          rollups: leaderboardRollups,
          config: () => leaderboardConfig
        },
        policy: { wantsCliproxySidecar },
        host: {
          ...(options.onShutdownRequested !== undefined
            ? { onShutdownRequested: options.onShutdownRequested }
            : {}),
          ...(options.onRollRequested !== undefined
            ? { onRollRequested: options.onRollRequested }
            : {}),
          ...(options.onAccountTransactionPhase !== undefined
            ? { onAccountTransactionPhase: options.onAccountTransactionPhase }
            : {})
        }
      })
    );
    const running = await runRouteKitEffect(
      Effect.gen(function* () {
        accountActivity = yield* AccountActivity;
        accountAuth = yield* AccountAuth;
        yield* sidecar.reconcile(wantsCliproxySidecar(runtimeState.config));
        const generations = yield* Generations;
        const gateway = yield* ActiveGateway;
        activeGateway = gateway;
        const router = yield* generations.start(runtimeState.config);
        gateway.setRouter(router);
        activeRouter = router;
        yield* accountAuth.reconcileActiveCredentials(activeCredentialFingerprints());
        const workloadJwt = workloadJwtOptions(options.workloadJwt, env);
        const verifyWorkloadJwt =
          workloadJwt === undefined ? undefined : createWorkloadJwtVerifier(workloadJwt);
        proxy = yield* startSwitchingGatewayProxyEffect({
          target: router.url,
          host: options.host ?? "127.0.0.1",
          port: options.port ?? 8080,
          authToken: dataAuth.token,
          resolveDataPrincipal: (presented) => {
            const evalPrincipal = evalSessions.resolve(presented);
            if (evalPrincipal !== undefined) return evalPrincipal;
            const principal = tokens.resolve(presented, "data");
            if (principal !== undefined) {
              return {
                id: principal.id,
                label: principal.label,
                role: principal.role
              };
            }
            return verifyWorkloadJwt?.(presented);
          }
        });
        portless =
          hosted === undefined
            ? yield* Effect.tryPromise({
                try: () =>
                  createPortlessSession(options.portless ?? env.ROUTEKIT_PORTLESS !== "0", {
                    project: "routekit",
                    ownerLabel: "routekit-daemon",
                    bareNames: []
                  }),
                catch: toRouteKitFailure
              })
            : undefined;
        const dataUrl =
          hosted?.dataUrl() ??
          (portless?.enabled === true ? portless.register("gateway", proxy.port()) : proxy.url());
        gateway.setProxy(proxy);
        gateway.setDataUrl(dataUrl);
        const handlers = toPromiseControlHandlers(createDaemonControlHandlers(), effectRuntime!);
        const dispatch = createDaemonControlDispatch({
          handlers,
          runtimeState,
          packageVersion: options.packageVersion,
          ...(daemonTelemetry !== undefined ? { daemonTelemetry } : {}),
          ...(hosted?.executeIdempotent !== undefined
            ? { executeIdempotent: hosted.executeIdempotent }
            : {})
        });
        control = yield* startControlServerEffect({
          handler: dispatch,
          token: hosted?.controlToken ?? generateControlToken(),
          product: ROUTEKIT_PRODUCT,
          packageVersion: options.packageVersion,
          port: options.controlPort,
          capabilities: [
            ROUTEKIT_CONTROL_CAPABILITY,
            ...(hosted === undefined ? [] : [ROUTEKIT_DAEMON_ROLL_CAPABILITY])
          ],
          authorize: (presented) => {
            const principal = tokens.resolve(presented, "control");
            if (principal === undefined) return undefined;
            return {
              id: principal.id,
              label: principal.label,
              role: principal.role
            };
          },
          onError: (error, context) => {
            const operation = context.method ?? "control transport";
            console.error(`RouteKit ${operation} failed (request ${context.requestId}):`, error);
          }
        });
        gateway.setControl(control);
        const workerRecordInput = {
          kind: ROUTEKIT_DAEMON_KIND,
          pid: process.pid,
          ...(processIdentity(process.pid) !== undefined
            ? { processIdentity: processIdentity(process.pid) }
            : {}),
          url: control.url,
          port: control.port,
          startedAt,
          version: options.packageVersion,
          protocolVersion: CONTROL_PROTOCOL_VERSION,
          controlToken: control.token,
          dataUrl,
          dataPort: proxy.port(),
          host: options.host ?? "127.0.0.1",
          portless: portless?.enabled ?? false,
          drainGraceMs,
          authTokenFile: dataAuth.path,
          generation,
          supervisor: supervisorFromEnv(env),
          ...(process.argv[1] !== undefined ? { binPath: process.argv[1] } : {}),
          args: redactedProcessArgs(process.argv.slice(2)),
          cwd: process.cwd()
        } satisfies Omit<ServiceRecord, "product" | "owner">;
        record =
          hosted === undefined
            ? store.write(workerRecordInput)
            : { product: ROUTEKIT_PRODUCT, owner: ROUTEKIT_PRODUCT, ...workerRecordInput };
        if (hosted === undefined) {
          writeDaemonPublicRecord(home, {
            product: ROUTEKIT_PRODUCT,
            kind: ROUTEKIT_DAEMON_KIND,
            url: control.url,
            port: control.port,
            generation,
            protocolVersion: CONTROL_PROTOCOL_VERSION,
            dataUrl,
            dataPort: proxy.port(),
            startedAt
          });
        }
        const supervisor = (["systemd", "launchd", "detached"] as const).includes(
          supervisorFromEnv(env) as never
        )
          ? (supervisorFromEnv(env) as "systemd" | "launchd" | "detached")
          : "unknown";
        captureDaemonStarted({
          daemonTelemetry,
          packageVersion: options.packageVersion,
          supervisor
        });
        const lifecycle = createDaemonLifecycle({
          runtimeState,
          handlers,
          drainGraceMs,
          packageVersion: options.packageVersion,
          supervisor,
          getProxy: () => activeGateway?.proxy() ?? proxy,
          getActiveRouter: () => activeGateway?.router() ?? activeRouter,
          getControl: () => control,
          accountActivity,
          accountAuth,
          daemonTelemetry,
          gatewayTelemetry,
          closeSidecar: () => (hosted === undefined ? sidecar.close : Effect.void),
          cleanupRegistration: () => {
            if (hosted !== undefined) return;
            if (portless?.enabled) portless.unregister("gateway");
            store.remove(ROUTEKIT_DAEMON_KIND, { ifPid: process.pid });
            removeDaemonPublicRecord(home);
            authority?.release();
          },
          effectRuntime: effectRuntime!
        });
        if (record === undefined) {
          return yield* new RouteKitFailure({
            message: "RouteKit daemon failed to publish a service record"
          });
        }
        return { record, dataUrl, controlUrl: control.url, lifecycle };
      }),
      effectRuntime
    );
    return {
      record: running.record,
      dataUrl: running.dataUrl,
      controlUrl: running.controlUrl,
      close: () => runRouteKitEffect(running.lifecycle.close()),
      retire: (graceMs) => runRouteKitEffect(running.lifecycle.retire(graceMs)),
      pauseMutations: () => runRouteKitEffect(running.lifecycle.pauseMutations()),
      resumeMutations: () => running.lifecycle.resumeMutations(),
      snapshot: () => running.lifecycle.snapshot(),
      reload: () => runRouteKitEffect(running.lifecycle.reload())
    };
  } catch (error) {
    try {
      await runRouteKitEffect(
        cleanupFailedDaemon({
          gatewayTelemetry,
          daemonTelemetry,
          proxy,
          activeRouter: activeGateway?.router() ?? activeRouter,
          accountActivity,
          accountAuth,
          closeSidecar: () =>
            hosted === undefined ? (sidecarRef?.close ?? Effect.void) : Effect.void,
          control,
          cleanupRegistration: () => {
            if (hosted !== undefined) return;
            if (portless?.enabled) portless.unregister("gateway");
            if (record !== undefined) store.remove(ROUTEKIT_DAEMON_KIND, { ifPid: process.pid });
            removeDaemonPublicRecord(home);
            authority?.release();
          },
          ...(effectRuntime !== undefined ? { effectRuntime } : {})
        })
      );
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "RouteKit daemon startup failed and cleanup was incomplete"
      );
    }
    throw error;
  }
}
