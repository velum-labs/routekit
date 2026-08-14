import type { LeaderboardConfig, RouterConfig } from "@velum-labs/routekit-config";
import type { RouteKitControlParams, RouteKitControlResults } from "@velum-labs/routekit-control";
import type { EffectRouteKitControlHandlers } from "@velum-labs/routekit-control/effect";
import type { AccountApplicationServiceOptions } from "./account-application-options.js";
import { AccountEnrollService } from "./account-enroll-service.js";
import { AccountMutationService } from "./account-mutation-service.js";
import { AccountQueryService } from "./account-query-service.js";
import type { AccountTransactionRecovery } from "./account-transaction.js";
import type { CallAttributionStore } from "./call-attribution-store.js";
import { DaemonLifecycleService } from "./daemon-lifecycle-service.js";
import { DoctorApplicationService } from "./doctor-application-service.js";
import { LauncherApplicationService } from "./launcher-application-service.js";
import { TelemetryApplicationService } from "./telemetry-application-service.js";
import { TokenApplicationService } from "./token-application-service.js";
import type { LeaderboardRollupStore } from "./leaderboard.js";
import { ProviderQueryService } from "./provider-query-service.js";
import { RouterGenerationService } from "./router-generation-service.js";

export type DaemonControlHandlerContext = {
  dataTokenCache: Map<string, string>;
  dataAuth: { token: string; path: string };
  accountRecovery: AccountTransactionRecovery;
  callAttributions: CallAttributionStore;
  leaderboardRollups: LeaderboardRollupStore;
  leaderboardConfig: () => LeaderboardConfig;
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
 * Catalog services are yielded from `daemonLive`, not passed in this bag.
 */
export function createDaemonControlHandlers(
  context: DaemonControlHandlerContext
): EffectRouteKitControlHandlers {
  const {
    dataTokenCache,
    dataAuth,
    accountRecovery,
    callAttributions,
    leaderboardRollups,
    leaderboardConfig,
    wantsCliproxySidecar,
    onShutdownRequested,
    onRollRequested,
    onAccountTransactionPhase
  } = context;
  const providerHandlers = new ProviderQueryService({
    callAttributions,
    leaderboardRollups,
    leaderboardConfig
  }).handlers();
  const accountOptions: AccountApplicationServiceOptions = {
    recovery: accountRecovery,
    ...(onAccountTransactionPhase !== undefined
      ? { onTransactionPhase: onAccountTransactionPhase }
      : {})
  };
  const handlers: EffectRouteKitControlHandlers = {
    ...new DaemonLifecycleService({
      ...(onShutdownRequested !== undefined ? { onShutdownRequested } : {}),
      ...(onRollRequested !== undefined ? { onRollRequested } : {})
    }).handlers(),
    ...new RouterGenerationService().handlers(),
    ...providerHandlers,
    ...new AccountQueryService(accountOptions).handlers(),
    ...new AccountEnrollService(accountOptions).handlers(),
    ...new AccountMutationService(accountOptions).handlers(),
    ...new TelemetryApplicationService().handlers(),
    ...new DoctorApplicationService({
      accountRecovery,
      wantsCliproxySidecar
    }).handlers(),
    ...new LauncherApplicationService({
      dataTokenCache,
      dataAuth,
      listModels: providerHandlers["models.list"]
    }).handlers(),
    ...new TokenApplicationService({ dataTokenCache }).handlers()
  };
  return handlers;
}
