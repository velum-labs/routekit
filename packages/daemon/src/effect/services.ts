import { AccountActivity, AccountAuth } from "@velum-labs/routekit-accounts/effect";
import type { RouterConfig } from "@velum-labs/routekit-config";
import type { ProvenanceSink, SwitchingGatewayProxy } from "@velum-labs/routekit-gateway";
import type { RunningRouter } from "@velum-labs/routekit-router";
import type { RunningControlServer, TokenStore } from "@velum-labs/routekit-runtime";
import { Context, Effect, Layer } from "effect";
import type { CliproxySidecar } from "../cliproxy-sidecar.js";
import type { DaemonGenerationManager, DaemonGenerationStage } from "../daemon-generations.js";
import type { DaemonRuntimeState } from "../daemon-runtime-state.js";
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

export class DaemonState extends Context.Service<DaemonState, DaemonRuntimeState>()(
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

/** Account and generation services used by control handlers. */
export const daemonAccountServices = Effect.gen(function* () {
  const env = yield* DaemonEnv;
  const state = yield* DaemonState;
  const generations = yield* Generations;
  const activity = yield* AccountActivity;
  const auth = yield* AccountAuth;
  const sidecar = yield* Sidecar;
  const gateway = yield* ActiveGateway;
  return { env, state, generations, activity, auth, sidecar, gateway };
});
