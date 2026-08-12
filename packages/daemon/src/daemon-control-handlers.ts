import { existsSync } from "node:fs";
import type {
  AccountActivityCoordinator,
  AccountAuthCoordinator
} from "@velum-labs/routekit-accounts";
import { configuredProviderIds } from "@velum-labs/routekit-config";
import type { DaemonStatus, RouteKitControlHandlers } from "@velum-labs/routekit-control";
import { resolveCodexStartupModel } from "@velum-labs/routekit-gateway";
import {
  CONTROL_PROTOCOL_VERSION,
  ControlError,
  supervisorFromEnv
} from "@velum-labs/routekit-runtime";
import {
  durationBucket,
  TELEMETRY_SCHEMA_INVENTORY,
  telemetryStatusMetadata
} from "@velum-labs/routekit-telemetry-core";
import { AccountApplicationService } from "./account-application-service.js";
import type { AccountTransactionRecovery } from "./account-transaction.js";
import type { CallAttributionStore } from "./call-attribution-store.js";
import type { CliproxySidecar } from "./cliproxy-sidecar.js";
import {
  createTelemetryControlHandlers,
  createTokenControlHandlers
} from "./daemon-control-groups.js";
import { accountEntries } from "./daemon-maintenance.js";
import type { DaemonRuntimeState } from "./daemon-runtime-state.js";
import { dataTokenForPrincipal, writeSnapshot } from "./daemon-state.js";
import { DAEMON_HOST_PROTOCOL_VERSION } from "./host-protocol.js";
import type { LeaderboardRollupStore } from "./leaderboard.js";
import { ProviderQueryService } from "./provider-query-service.js";
import { RouterGenerationService } from "./router-generation-service.js";
import {
  type DaemonTelemetry,
  DEFAULT_TELEMETRY_HOST,
  type GatewayTelemetryAggregator,
  resolveTelemetryProjectKey
} from "./telemetry.js";

export type DaemonControlHandlerContext = {
  env: NodeJS.ProcessEnv;
  home: string;
  configPath: string;
  dataUrl: string;
  generation: number;
  startedAt: string;
  packageVersion: string;
  hosted:
    | { hostPid: number; hostStartedAt: string; rolling: () => boolean; dataUrl: () => string }
    | undefined;
  tokens: any;
  dataTokenCache: Map<string, string>;
  dataAuth: { token: string; path: string };
  runtimeState: DaemonRuntimeState;
  activeRouter: () => import("@velum-labs/routekit-router").RunningRouter | undefined;
  proxy: () => import("@velum-labs/routekit-gateway").SwitchingGatewayProxy | undefined;
  control: () => import("@velum-labs/routekit-runtime").RunningControlServer | undefined;
  sidecar: CliproxySidecar;
  accountActivity: AccountActivityCoordinator | undefined;
  accountAuth: AccountAuthCoordinator | undefined;
  accountRecovery: AccountTransactionRecovery;
  callAttributions: CallAttributionStore;
  leaderboardRollups: LeaderboardRollupStore;
  leaderboardConfig: () => import("@velum-labs/routekit-config").LeaderboardConfig;
  telemetry: ReturnType<typeof import("@velum-labs/routekit-telemetry-core").createConsentManager>;
  daemonTelemetry?: DaemonTelemetry;
  gatewayTelemetry?: GatewayTelemetryAggregator;
  serializeMutation: <T>(operation: () => Promise<T>) => Promise<T>;
  replaceRouter: (...args: any[]) => Promise<any>;
  wantsCliproxySidecar: (config: import("@velum-labs/routekit-config").RouterConfig) => boolean;
  onShutdownRequested?: (reason: "stop" | "restart" | "upgrade") => void;
  onRollRequested?: (params: any) => Promise<any>;
  onAccountTransactionPhase?: (
    phase: "prepared" | "credentials-written" | "router-swapped" | "committed"
  ) => void;
};

export function createDaemonControlHandlers(
  context: DaemonControlHandlerContext
): RouteKitControlHandlers {
  const {
    env,
    home,
    configPath,
    dataUrl,
    generation,
    startedAt,
    packageVersion,
    hosted,
    tokens,
    dataTokenCache,
    dataAuth,
    runtimeState,
    activeRouter,
    proxy,
    control,
    sidecar,
    accountActivity,
    accountAuth,
    accountRecovery,
    callAttributions,
    leaderboardRollups,
    leaderboardConfig,
    telemetry,
    daemonTelemetry,
    gatewayTelemetry,
    serializeMutation,
    replaceRouter,
    wantsCliproxySidecar,
    onShutdownRequested,
    onRollRequested,
    onAccountTransactionPhase
  } = context;
  const telemetryStatus = (): import("@velum-labs/routekit-telemetry-core").TelemetryStatus =>
    telemetryStatusMetadata(telemetry.resolve(env), {
      provider: "posthog",
      host: env.ROUTEKIT_POSTHOG_HOST?.trim() || DEFAULT_TELEMETRY_HOST,
      configured: resolveTelemetryProjectKey(env).length > 0
    }) as import("@velum-labs/routekit-telemetry-core").TelemetryStatus;
  const handlers: RouteKitControlHandlers = {
    "daemon.status": async () =>
      ({
        pid: process.pid,
        workerPid: process.pid,
        hostPid: hosted?.hostPid ?? process.pid,
        hostStartedAt: hosted?.hostStartedAt ?? startedAt,
        startedAt,
        packageVersion: packageVersion,
        protocolVersion: CONTROL_PROTOCOL_VERSION,
        hostProtocolVersion: hosted === undefined ? 0 : DAEMON_HOST_PROTOCOL_VERSION,
        generation,
        configRevision: runtimeState.revisions.config,
        accountRevision: runtimeState.revisions.accounts,
        controlUrl: control()?.url ?? "",
        dataUrl: hosted?.dataUrl() ?? dataUrl,
        dataPort: proxy()?.port() ?? 0,
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
      if (onRollRequested === undefined) {
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
      const toVersion = params.candidate?.expectedVersion ?? packageVersion;
      daemonTelemetry?.capture("routekit.daemon_lifecycle", {
        action: "roll_started",
        outcome: "success",
        supervisor,
        version: packageVersion,
        reason: params.reason,
        from_version: packageVersion,
        to_version: toVersion
      });
      try {
        const result = await onRollRequested(params);
        daemonTelemetry?.capture("routekit.daemon_lifecycle", {
          action: "roll_committed",
          outcome: "success",
          supervisor,
          version: result.packageVersion,
          reason: params.reason,
          from_version: packageVersion,
          to_version: result.packageVersion,
          duration_bucket: durationBucket(Date.now() - startedAt)
        });
        return result;
      } catch (error) {
        daemonTelemetry?.capture("routekit.daemon_lifecycle", {
          action: "roll_failed",
          outcome: "error",
          supervisor,
          version: packageVersion,
          reason: params.reason,
          from_version: packageVersion,
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
      queueMicrotask(() => onShutdownRequested?.(params.reason));
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
      activeRouter: () => activeRouter()!,
      callAttributions,
      leaderboardRollups,
      leaderboardConfig,
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
      activeRouter: () => activeRouter()!,
      serializeMutation,
      replaceRouter,
      ...(onAccountTransactionPhase !== undefined
        ? { onTransactionPhase: onAccountTransactionPhase }
        : {})
    }).handlers(),
    ...createTelemetryControlHandlers({
      env,
      packageVersion: packageVersion,
      telemetry,
      telemetryStatus,
      schema: TELEMETRY_SCHEMA_INVENTORY,
      serializeMutation,
      ...(daemonTelemetry !== undefined ? { daemonTelemetry } : {}),
      ...(gatewayTelemetry !== undefined ? { gatewayTelemetry } : {})
    }),
    "doctor.run": async (_params, context) => {
      const providers = await activeRouter()!.providerStatuses(context.signal);
      const configuredProviders = configuredProviderIds(runtimeState.config);
      const accounts = accountEntries(env);
      const missingProviders = [
        ...new Set(
          accounts
            .filter((entry) => {
              const provider = entry.connector === "cliproxy" ? "cliproxy" : entry.subscriptionKind;
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
          const info = activeRouter()!.modelInfo(entry.id);
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
            params.model === undefined ? "no model is available" : `unknown model: ${params.model}`
        });
      }
      return {
        tool: params.tool,
        model,
        gatewayUrl: dataUrl,
        authToken: dataTokenForPrincipal(tokens, dataTokenCache, dataAuth.token, context.principal),
        env: {},
        ...(codexSelection !== undefined ? { codexSelection } : {})
      };
    },
    ...createTokenControlHandlers({ home, tokens, dataTokenCache })
  };
  return handlers;
}
