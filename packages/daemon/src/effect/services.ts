import {
  AccountActivity,
  type AccountActivityService,
  AccountAuth,
  type AccountAuthService
} from "@velum-labs/routekit-accounts/effect";
import type { LeaderboardConfig, RouterConfig } from "@velum-labs/routekit-config";
import type { RouteKitControlParams, RouteKitControlResults } from "@velum-labs/routekit-control";
import type { ProvenanceSink, SwitchingGatewayProxy } from "@velum-labs/routekit-gateway";
import type { RunningRouter } from "@velum-labs/routekit-router";
import type { RunningControlServer, TokenStore } from "@velum-labs/routekit-runtime";
import { Context, Effect, Layer } from "effect";
import type { AccountTransactionRecovery } from "../account-transaction.js";
import type { CallAttributionStore } from "../call-attribution-store.js";
import type { CliproxySidecar } from "../cliproxy-sidecar.js";
import type { DaemonGenerationManager, DaemonGenerationStage } from "../daemon-generations.js";
import type { DaemonRuntimeState } from "../daemon-runtime-state.js";
import type { LeaderboardRollupStore } from "../leaderboard.js";
import type { DaemonTelemetry, GatewayTelemetryAggregator } from "../telemetry.js";

export type DaemonHosted = {
  hostPid: number;
  hostStartedAt: string;
  rolling: () => boolean;
  dataUrl: () => string;
};

export type DaemonEnvValue = {
  home: string;
  configPath: string;
  env: NodeJS.ProcessEnv;
  packageVersion: string;
  generation: number;
  startedAt: string;
  hosted: DaemonHosted | undefined;
};

export type ActiveGatewayValue = {
  router(): RunningRouter | undefined;
  setRouter(router: RunningRouter): void;
  proxy(): SwitchingGatewayProxy | undefined;
  setProxy(proxy: SwitchingGatewayProxy): void;
  dataUrl(): string | undefined;
  setDataUrl(url: string): void;
  control(): RunningControlServer | undefined;
  setControl(control: RunningControlServer): void;
};

export type TelemetryServiceValue = {
  consent: {
    resolve(env: NodeJS.ProcessEnv): {
      enabled: boolean;
      source: "do-not-track" | "env" | "config" | "default";
      categories: Record<"usage" | "reliability" | "adoption", boolean>;
    };
    enable(): unknown;
    disable(): unknown;
    setCategory(category: "usage" | "reliability" | "adoption", enabled: boolean): unknown;
    resetIdentity(env: NodeJS.ProcessEnv): unknown;
  };
  daemon?: DaemonTelemetry;
  gateway?: GatewayTelemetryAggregator;
};

export type DaemonGenerationHooks = {
  drainGraceMs: number;
  routerEnv: () => NodeJS.ProcessEnv;
  provenance: ProvenanceSink;
  wantsSidecar(config: RouterConfig): boolean;
  applyConfig(config: RouterConfig): void;
  activeCredentialFingerprints(): Map<string, string>;
  onStage?: (stage: DaemonGenerationStage) => void;
};

export class DaemonEnv extends Context.Service<DaemonEnv, DaemonEnvValue>()(
  "@velum-labs/routekit-daemon/DaemonEnv"
) {}

export type DaemonStateService = Omit<DaemonRuntimeState, "awaitMutations"> & {
  awaitMutations(_unit?: void): ReturnType<DaemonRuntimeState["awaitMutations"]>;
};

export class DaemonState extends Context.Service<DaemonState, DaemonStateService>()(
  "@velum-labs/routekit-daemon/DaemonState"
) {}

export class Sidecar extends Context.Service<Sidecar, CliproxySidecar>()(
  "@velum-labs/routekit-daemon/Sidecar"
) {}

/**
 * @effect-expect-leaking ChildProcessSpawner | Crypto | FileSystem | HttpClient | Path | Stdio | Terminal
 */
export class Generations extends Context.Service<Generations, DaemonGenerationManager>()(
  "@velum-labs/routekit-daemon/Generations"
) {}

export class ActiveGateway extends Context.Service<ActiveGateway, ActiveGatewayValue>()(
  "@velum-labs/routekit-daemon/ActiveGateway"
) {
  static readonly layer = Layer.sync(ActiveGateway, () => {
    let router: RunningRouter | undefined;
    let proxy: SwitchingGatewayProxy | undefined;
    let dataUrl: string | undefined;
    let control: RunningControlServer | undefined;
    return {
      router: () => router,
      setRouter: (next) => {
        router = next;
      },
      proxy: () => proxy,
      setProxy: (next) => {
        proxy = next;
      },
      dataUrl: () => dataUrl,
      setDataUrl: (next) => {
        dataUrl = next;
      },
      control: () => control,
      setControl: (next) => {
        control = next;
      }
    };
  });
}

export class Tokens extends Context.Service<Tokens, TokenStore>()(
  "@velum-labs/routekit-daemon/Tokens"
) {}

export class Telemetry extends Context.Service<Telemetry, TelemetryServiceValue>()(
  "@velum-labs/routekit-daemon/Telemetry"
) {}

export type DataPlaneValue = {
  token: string;
  path: string;
  cache: Map<string, string>;
};

export class DataPlane extends Context.Service<DataPlane, DataPlaneValue>()(
  "@velum-labs/routekit-daemon/DataPlane"
) {}

export class AccountRecovery extends Context.Service<AccountRecovery, AccountTransactionRecovery>()(
  "@velum-labs/routekit-daemon/AccountRecovery"
) {}

export class CallAttributions extends Context.Service<CallAttributions, CallAttributionStore>()(
  "@velum-labs/routekit-daemon/CallAttributions"
) {}

export type LeaderboardValue = {
  rollups: LeaderboardRollupStore;
  config: () => LeaderboardConfig;
};

export class Leaderboard extends Context.Service<Leaderboard, LeaderboardValue>()(
  "@velum-labs/routekit-daemon/Leaderboard"
) {}

export type DaemonPolicyValue = {
  wantsCliproxySidecar: (config: RouterConfig) => boolean;
};

export class DaemonPolicy extends Context.Service<DaemonPolicy, DaemonPolicyValue>()(
  "@velum-labs/routekit-daemon/DaemonPolicy"
) {}

export type DaemonHostValue = {
  onShutdownRequested?: (reason: "stop" | "restart" | "upgrade") => void;
  onRollRequested?: (
    params: RouteKitControlParams["daemon.roll"]
  ) => Promise<RouteKitControlResults["daemon.roll"]>;
  onAccountTransactionPhase?: (
    phase: "prepared" | "credentials-written" | "router-swapped" | "committed"
  ) => void;
};

export class DaemonHost extends Context.Service<DaemonHost, DaemonHostValue>()(
  "@velum-labs/routekit-daemon/DaemonHost"
) {}

export type DaemonAccountServices = {
  env: DaemonEnvValue;
  state: DaemonStateService;
  generations: DaemonGenerationManager;
  activity: AccountActivityService;
  auth: AccountAuthService;
  sidecar: CliproxySidecar;
  gateway: ActiveGatewayValue;
};

/** Account and generation services used by control handlers. */
export const daemonAccountServices: Effect.Effect<
  DaemonAccountServices,
  never,
  | DaemonEnv
  | DaemonState
  | Generations
  | AccountActivity
  | AccountAuth
  | Sidecar
  | ActiveGateway
> = Effect.gen(function* () {
  const env = yield* DaemonEnv;
  const state = yield* DaemonState;
  const generations = yield* Generations;
  const activity = yield* AccountActivity;
  const auth = yield* AccountAuth;
  const sidecar = yield* Sidecar;
  const gateway = yield* ActiveGateway;
  return { env, state, generations, activity, auth, sidecar, gateway };
});
