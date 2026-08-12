import type {
  AccountActivityCoordinator,
  AccountAuthCoordinator
} from "@velum-labs/routekit-accounts";
import type { LeaderboardConfig, RouterConfig } from "@velum-labs/routekit-config";
import type {
  RouteKitControlHandlers,
  RouteKitControlParams,
  RouteKitControlResults
} from "@velum-labs/routekit-control";
import type { SwitchingGatewayProxy } from "@velum-labs/routekit-gateway";
import type { RunningRouter } from "@velum-labs/routekit-router";
import type { RunningControlServer, TokenStore } from "@velum-labs/routekit-runtime";
import {
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
import type { DaemonGenerationMutation } from "./daemon-generations.js";
import { DaemonLifecycleService } from "./daemon-lifecycle-service.js";
import type { DaemonRuntimeState } from "./daemon-runtime-state.js";
import { writeSnapshot } from "./daemon-state.js";
import { DoctorApplicationService } from "./doctor-application-service.js";
import { LauncherApplicationService } from "./launcher-application-service.js";
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
  tokens: TokenStore;
  dataTokenCache: Map<string, string>;
  dataAuth: { token: string; path: string };
  runtimeState: DaemonRuntimeState;
  activeRouter: () => RunningRouter | undefined;
  proxy: () => SwitchingGatewayProxy | undefined;
  control: () => RunningControlServer | undefined;
  sidecar: CliproxySidecar;
  accountActivity: AccountActivityCoordinator | undefined;
  accountAuth: AccountAuthCoordinator | undefined;
  accountRecovery: AccountTransactionRecovery;
  callAttributions: CallAttributionStore;
  leaderboardRollups: LeaderboardRollupStore;
  leaderboardConfig: () => LeaderboardConfig;
  telemetry: ReturnType<typeof import("@velum-labs/routekit-telemetry-core").createConsentManager>;
  daemonTelemetry?: DaemonTelemetry;
  gatewayTelemetry?: GatewayTelemetryAggregator;
  serializeMutation: <T>(operation: () => Promise<T>) => Promise<T>;
  replaceRouter: (
    config: RouterConfig,
    document: string,
    mutation: DaemonGenerationMutation
  ) => Promise<void>;
  wantsCliproxySidecar: (config: RouterConfig) => boolean;
  onShutdownRequested?: (reason: "stop" | "restart" | "upgrade") => void;
  onRollRequested?: (
    params: RouteKitControlParams["daemon.roll"]
  ) => Promise<RouteKitControlResults["daemon.roll"]>;
  onAccountTransactionPhase?: (
    phase: "prepared" | "credentials-written" | "router-swapped" | "committed"
  ) => void;
};

/**
 * Composes owned application services into the daemon control handler map.
 * Protocol policy lives in the method table; this function only binds use cases.
 */
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
  const providerHandlers = new ProviderQueryService({
    env,
    runtimeState,
    activeRouter: () => activeRouter()!,
    callAttributions,
    leaderboardRollups,
    leaderboardConfig,
    writeSnapshot: (category, name, value) => writeSnapshot(home, category, name, value)
  }).handlers();
  return {
    ...new DaemonLifecycleService({
      env,
      dataUrl,
      generation,
      startedAt,
      packageVersion,
      hosted,
      runtimeState,
      proxy,
      control,
      ...(daemonTelemetry !== undefined ? { daemonTelemetry } : {}),
      ...(onShutdownRequested !== undefined ? { onShutdownRequested } : {}),
      ...(onRollRequested !== undefined ? { onRollRequested } : {})
    }).handlers(),
    ...new RouterGenerationService({
      configPath,
      runtimeState,
      serializeMutation,
      replaceRouter
    }).handlers(),
    ...providerHandlers,
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
      packageVersion,
      telemetry,
      telemetryStatus,
      schema: TELEMETRY_SCHEMA_INVENTORY,
      serializeMutation,
      ...(daemonTelemetry !== undefined ? { daemonTelemetry } : {}),
      ...(gatewayTelemetry !== undefined ? { gatewayTelemetry } : {})
    }),
    ...new DoctorApplicationService({
      env,
      configPath,
      dataUrl,
      runtimeState,
      sidecar,
      accountRecovery,
      activeRouter,
      proxy,
      control,
      wantsCliproxySidecar
    }).handlers(),
    ...new LauncherApplicationService({
      dataUrl,
      tokens,
      dataTokenCache,
      dataAuth,
      activeRouter,
      listModels: providerHandlers["models.list"]
    }).handlers(),
    ...createTokenControlHandlers({ home, tokens, dataTokenCache })
  };
}
