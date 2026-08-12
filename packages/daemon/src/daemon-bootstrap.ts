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
  AccountActivityCoordinator,
  AccountAuthCoordinator,
  CLIPROXY_API_KEY_ENV,
  CLIPROXY_BASE_URL_ENV,
  cliproxyApiKey,
  cliproxyBaseUrl,
  subscriptionAccountIdentity,
  subscriptionCredentialFingerprint
} from "@velum-labs/routekit-accounts";
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
import type {
  SwitchingGatewayProxy,
  WorkloadJwtVerifierOptions
} from "@velum-labs/routekit-gateway";
import {
  createWorkloadJwtVerifier,
  resolveCodexStartupModel,
  startSwitchingGatewayProxy
} from "@velum-labs/routekit-gateway";
import type { RunningRouter } from "@velum-labs/routekit-router";
import { startRouter } from "@velum-labs/routekit-router";
import type {
  PortlessSession,
  RunningControlServer,
  ServiceRecord
} from "@velum-labs/routekit-runtime";
import {
  CONTROL_PROTOCOL_VERSION,
  ControlError,
  createPortlessSession,
  generateControlToken,
  nextServiceGeneration,
  processIdentity,
  startControlServer,
  supervisorFromEnv
} from "@velum-labs/routekit-runtime";
import {
  createConsentManager,
  durationBucket,
  TELEMETRY_SCHEMA_INVENTORY,
  telemetryStatusMetadata
} from "@velum-labs/routekit-telemetry-core";
import { AccountApplicationService } from "./account-application-service.js";
import { CallAttributionStore, callInspection } from "./call-attribution-store.js";
import type { CliproxySidecar } from "./cliproxy-sidecar.js";
import { createCliproxySidecar } from "./cliproxy-sidecar.js";
import { createDaemonControlDispatch } from "./control-dispatch.js";
import { prepareDaemonBootstrap } from "./daemon-bootstrap-preflight.js";
import {
  createTelemetryControlHandlers,
  createTokenControlHandlers
} from "./daemon-control-groups.js";
import { createDaemonGenerationManager } from "./daemon-generations.js";
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
import { DAEMON_HOST_PROTOCOL_VERSION } from "./host-protocol.js";
import { LeaderboardRollupStore } from "./leaderboard.js";
import { ProviderQueryService } from "./provider-query-service.js";
import { RouterGenerationService } from "./router-generation-service.js";
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
  let activeRouter: RunningRouter | undefined;
  let accountActivity: AccountActivityCoordinator | undefined;
  let accountAuth: AccountAuthCoordinator | undefined;
  let daemonTelemetry: DaemonTelemetry | undefined;
  let gatewayTelemetry: GatewayTelemetryAggregator | undefined;
  let record: ServiceRecord | undefined;
  const serializeMutation = <T>(operation: () => Promise<T>): Promise<T> =>
    runtimeState.serializeMutation(operation);

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
    accountActivity = new AccountActivityCoordinator({
      statePath: join(home, "usage", "account-activity.v1.json")
    });
    mkdirSync(join(home, "subscriptions"), { recursive: true, mode: 0o700 });
    accountAuth = new AccountAuthCoordinator({
      statePath: join(home, "subscriptions", "account-auth.v1.json")
    });
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
    const generations = createDaemonGenerationManager({
      configPath,
      home,
      drainGraceMs,
      sidecar,
      routerEnv,
      provenance,
      activity: accountActivity!,
      authHealth: accountAuth!,
      wantsSidecar: wantsCliproxySidecar,
      getCurrentConfig: () => runtimeState.config,
      setCurrentConfig: (config) => {
        runtimeState.config = config;
      },
      getCurrentDocument: () => runtimeState.document,
      setCurrentDocument: (document) => {
        runtimeState.document = document;
      },
      getRevisions: () => runtimeState.revisions,
      setRevisions: (next) => {
        runtimeState.revisions = next;
      },
      getActiveRouter: () => activeRouter,
      setActiveRouter: (router) => {
        activeRouter = router;
      },
      getProxy: () => proxy,
      activeCredentialFingerprints,
      applyConfig: applyLeaderboardConfig,
      onStage: options.onGenerationStage
    });
    await sidecar.reconcile(wantsCliproxySidecar(runtimeState.config));
    activeRouter = await generations.start(runtimeState.config);
    accountAuth.reconcileActiveCredentials(activeCredentialFingerprints());
    const workloadJwt = workloadJwtOptions(options.workloadJwt, env);
    const verifyWorkloadJwt =
      workloadJwt === undefined ? undefined : createWorkloadJwtVerifier(workloadJwt);
    proxy = await startSwitchingGatewayProxy({
      target: activeRouter.url,
      host: options.host ?? "127.0.0.1",
      port: options.port ?? 8080,
      authToken: dataAuth.token,
      resolveDataPrincipal: (presented) => {
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
        ? await createPortlessSession(options.portless ?? env.ROUTEKIT_PORTLESS !== "0", {
            project: "routekit",
            ownerLabel: "routekit-daemon",
            bareNames: []
          })
        : undefined;
    const dataUrl =
      hosted?.dataUrl() ??
      (portless?.enabled === true ? portless.register("gateway", proxy.port()) : proxy.url());

    const replaceRouter = generations.replace;

    let handlers: RouteKitControlHandlers;
    const telemetryStatus = (): import("@velum-labs/routekit-telemetry-core").TelemetryStatus =>
      telemetryStatusMetadata(telemetry.resolve(env), {
        provider: "posthog",
        host: env.ROUTEKIT_POSTHOG_HOST?.trim() || DEFAULT_TELEMETRY_HOST,
        configured: resolveTelemetryProjectKey(env).length > 0
      }) as import("@velum-labs/routekit-telemetry-core").TelemetryStatus;
    handlers = {
      "daemon.status": async () =>
        ({
          pid: process.pid,
          workerPid: process.pid,
          hostPid: hosted?.hostPid ?? process.pid,
          hostStartedAt: hosted?.hostStartedAt ?? startedAt,
          startedAt,
          packageVersion: options.packageVersion,
          protocolVersion: CONTROL_PROTOCOL_VERSION,
          hostProtocolVersion: hosted === undefined ? 0 : DAEMON_HOST_PROTOCOL_VERSION,
          generation,
          configRevision: runtimeState.revisions.config,
          accountRevision: runtimeState.revisions.accounts,
          controlUrl: control?.url ?? "",
          dataUrl: hosted?.dataUrl() ?? dataUrl,
          dataPort: proxy?.port() ?? 0,
          supervisor: supervisorFromEnv(env),
          draining: runtimeState.draining,
          rolling: hosted?.rolling() ?? false
        }) satisfies DaemonStatus,
      "daemon.roll": async (params, context) => {
        if (context.principal?.role !== "ephemeral") {
          throw new ControlError({
            code: "unauthorized",
            message: "daemon roll requires the local service credential"
          });
        }
        if (options.onRollRequested === undefined) {
          throw new ControlError({
            code: "upgrade_required",
            message: "this daemon does not support rolling process replacement"
          });
        }
        const startedAt = Date.now();
        const supervisor = (["systemd", "launchd", "detached"] as const).includes(
          supervisorFromEnv(env) as never
        )
          ? (supervisorFromEnv(env) as "systemd" | "launchd" | "detached")
          : "unknown";
        const toVersion = params.candidate?.expectedVersion ?? options.packageVersion;
        daemonTelemetry?.capture("routekit.daemon_lifecycle", {
          action: "roll_started",
          outcome: "success",
          supervisor,
          version: options.packageVersion,
          reason: params.reason,
          from_version: options.packageVersion,
          to_version: toVersion
        });
        try {
          const result = await options.onRollRequested(params);
          daemonTelemetry?.capture("routekit.daemon_lifecycle", {
            action: "roll_committed",
            outcome: "success",
            supervisor,
            version: result.packageVersion,
            reason: params.reason,
            from_version: options.packageVersion,
            to_version: result.packageVersion,
            duration_bucket: durationBucket(Date.now() - startedAt)
          });
          return result;
        } catch (error) {
          daemonTelemetry?.capture("routekit.daemon_lifecycle", {
            action: "roll_failed",
            outcome: "error",
            supervisor,
            version: options.packageVersion,
            reason: params.reason,
            from_version: options.packageVersion,
            to_version: toVersion,
            rollback_stage: "candidate",
            duration_bucket: durationBucket(Date.now() - startedAt)
          });
          throw error;
        }
      },
      "daemon.prepareShutdown": async (params) => {
        if (
          runtimeState.lifecycle === "quiescing" ||
          runtimeState.lifecycle === "draining" ||
          runtimeState.lifecycle === "closed"
        ) {
          return { accepted: true };
        }
        runtimeState.beginRetire();
        await runtimeState.awaitMutations();
        queueMicrotask(() => options.onShutdownRequested?.(params.reason));
        return { accepted: true };
      },
      ...new RouterGenerationService({
        configPath,
        runtimeState,
        serializeMutation,
        replaceRouter
      }).handlers(),
      ...new ProviderQueryService({
        env,
        runtimeState,
        activeRouter: () => activeRouter!,
        callAttributions,
        leaderboardRollups,
        leaderboardConfig: () => leaderboardConfig,
        writeSnapshot: (category, name, value) => writeSnapshot(home, category, name, value)
      }).handlers(),
      ...new AccountApplicationService({
        env,
        home,
        configPath,
        runtimeState,
        sidecar,
        activity: accountActivity!,
        authHealth: accountAuth!,
        recovery: accountRecovery,
        activeRouter: () => activeRouter!,
        serializeMutation,
        replaceRouter,
        ...(options.onAccountTransactionPhase !== undefined
          ? { onTransactionPhase: options.onAccountTransactionPhase }
          : {})
      }).handlers(),
      ...createTelemetryControlHandlers({
        env,
        packageVersion: options.packageVersion,
        telemetry,
        telemetryStatus,
        schema: TELEMETRY_SCHEMA_INVENTORY,
        serializeMutation,
        ...(daemonTelemetry !== undefined ? { daemonTelemetry } : {}),
        ...(gatewayTelemetry !== undefined ? { gatewayTelemetry } : {})
      }),
      "doctor.run": async (_params, context) => {
        const providers = await activeRouter!.providerStatuses(context.signal);
        const configuredProviders = configuredProviderIds(runtimeState.config);
        const accounts = accountEntries(env);
        const missingProviders = [
          ...new Set(
            accounts
              .filter((entry) => {
                const provider =
                  entry.connector === "cliproxy" ? "cliproxy" : entry.subscriptionKind;
                return runtimeState.config.providers[provider] === undefined;
              })
              .map((entry) => entry.subscriptionKind)
          )
        ];
        const providerOnly = ["claude-code", "codex", "cliproxy"].filter(
          (provider) =>
            (runtimeState.config.providers as Record<string, unknown>)[provider] !== undefined &&
            !accounts.some((entry) =>
              provider === "cliproxy"
                ? entry.connector === "cliproxy"
                : entry.subscriptionKind === provider
            )
        );
        const consistent = missingProviders.length === 0 && providerOnly.length === 0;
        return {
          checks: [
            { name: "canonical config", ok: existsSync(configPath), detail: configPath },
            { name: "control plane", ok: control !== undefined },
            { name: "model gateway", ok: proxy !== undefined, detail: dataUrl },
            {
              name: "provider configuration",
              ok: configuredProviders.length > 0,
              detail:
                configuredProviders.length > 0
                  ? `${configuredProviders.length} provider(s) configured`
                  : "no providers configured; run `routekit providers add <provider>`"
            },
            {
              name: "account activation recovery",
              ok: true,
              detail:
                accountRecovery.recovered > 0
                  ? `recovered ${accountRecovery.recovered} interrupted operation(s)`
                  : "clean"
            },
            {
              name: "account/provider consistency",
              ok: consistent,
              detail: consistent
                ? "consistent"
                : [
                    ...(missingProviders.length > 0
                      ? [`routing disabled: ${missingProviders.join(", ")}`]
                      : []),
                    ...(providerOnly.length > 0
                      ? [`credential missing: ${providerOnly.join(", ")}`]
                      : [])
                  ].join("; ")
            },
            ...(wantsCliproxySidecar(runtimeState.config)
              ? [
                  {
                    name: "cliproxy sidecar",
                    ok: await sidecar.reachable(),
                    detail: sidecar.managed()
                      ? sidecar.running()
                        ? "managed; running"
                        : "managed; not running"
                      : "external"
                  }
                ]
              : []),
            ...providers.map((provider) => ({
              name: `${provider.provider} live discovery`,
              ok: provider.ok,
              detail: provider.error ?? `${provider.models.length} model(s)`
            }))
          ]
        };
      },
      "launcher.prepare": async (params, context) => {
        const listed = await handlers["models.list"](
          {},
          {
            signal: context.signal,
            requestId: "internal"
          }
        );
        let model = params.model ?? listed.defaultModel ?? listed.models[0]?.id;
        let codexSelection;
        if (params.tool === "codex") {
          const candidates = listed.models.flatMap((entry) => {
            const info = activeRouter!.modelInfo(entry.id);
            if (info === undefined) return [];
            return [
              {
                id: info.id,
                nativeId: info.nativeModel,
                provider: info.provider,
                billingScope: info.billingMode,
                ...(info.createdAt !== undefined ? { createdAt: info.createdAt } : {}),
                ...(info.providerPriority !== undefined
                  ? { providerPriority: info.providerPriority }
                  : {}),
                ...(info.metadata?.architecture !== undefined
                  ? { architecture: info.metadata.architecture }
                  : {}),
                ...(info.metadata?.supportedParameters !== undefined
                  ? { supportedParameters: info.metadata.supportedParameters }
                  : {}),
                ...(info.reasoning !== null ? { reasoning: info.reasoning } : {})
              }
            ];
          });
          try {
            const selected = await resolveCodexStartupModel({
              models: candidates,
              ...(listed.defaultModel !== undefined ? { preferredModel: listed.defaultModel } : {}),
              ...(params.model !== undefined ? { requestedModel: params.model } : {}),
              signal: context.signal
            });
            model = selected.model;
            codexSelection = {
              compatibleModelIds: [...selected.compatibleModelIds],
              models: [...selected.models]
            };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new ControlError({
              code:
                params.model !== undefined && message.startsWith("unknown model")
                  ? "not_found"
                  : "unavailable",
              message
            });
          }
        }
        if (model === undefined || !listed.models.some((entry) => entry.id === model)) {
          throw new ControlError({
            code: "not_found",
            message:
              params.model === undefined
                ? "no model is available"
                : `unknown model: ${params.model}`
          });
        }
        return {
          tool: params.tool,
          model,
          gatewayUrl: dataUrl,
          authToken: dataTokenForPrincipal(
            tokens,
            dataTokenCache,
            dataAuth.token,
            context.principal
          ),
          env: {},
          ...(codexSelection !== undefined ? { codexSelection } : {})
        };
      },
      ...createTokenControlHandlers({ home, tokens, dataTokenCache })
    };

    const dispatch = createDaemonControlDispatch({
      handlers,
      runtimeState,
      packageVersion: options.packageVersion,
      ...(daemonTelemetry !== undefined ? { daemonTelemetry } : {}),
      ...(hosted?.executeIdempotent !== undefined
        ? { executeIdempotent: hosted.executeIdempotent }
        : {})
    });
    control = await startControlServer({
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
      getProxy: () => proxy,
      getActiveRouter: () => activeRouter,
      getControl: () => control,
      accountActivity,
      accountAuth,
      daemonTelemetry,
      gatewayTelemetry,
      closeSidecar: async () => {
        if (hosted === undefined) await sidecar.close();
      },
      cleanupRegistration: () => {
        if (hosted !== undefined) return;
        if (portless?.enabled) portless.unregister("gateway");
        store.remove(ROUTEKIT_DAEMON_KIND, { ifPid: process.pid });
        removeDaemonPublicRecord(home);
        authority?.release();
      }
    });
    return {
      record,
      dataUrl,
      controlUrl: control.url,
      ...lifecycle
    };
  } catch (error) {
    try {
      await cleanupFailedDaemon({
        gatewayTelemetry,
        daemonTelemetry,
        proxy,
        activeRouter,
        accountActivity,
        accountAuth,
        closeSidecar: async () => {
          if (hosted === undefined) await sidecarRef?.close();
        },
        control,
        cleanupRegistration: () => {
          if (hosted !== undefined) return;
          if (portless?.enabled) portless.unregister("gateway");
          if (record !== undefined) store.remove(ROUTEKIT_DAEMON_KIND, { ifPid: process.pid });
          removeDaemonPublicRecord(home);
          authority?.release();
        }
      });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "RouteKit daemon startup failed and cleanup was incomplete"
      );
    }
    throw error;
  }
}
