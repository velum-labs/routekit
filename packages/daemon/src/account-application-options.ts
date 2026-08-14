import type {
  AccountActivityCoordinator,
  AccountAuthCoordinator
} from "@velum-labs/routekit-accounts";
import type { RouterConfig } from "@velum-labs/routekit-config";
import type { RunningRouter } from "@velum-labs/routekit-router";
import type { RouteKitPlatform } from "@velum-labs/routekit-runtime/effect";
import type { Effect } from "effect";
import type { AccountTransactionRecovery } from "./account-transaction.js";
import type { CliproxySidecar } from "./cliproxy-sidecar.js";
import type { DaemonGenerationMutation } from "./daemon-generations.js";
import type { DaemonRuntimeState } from "./daemon-runtime-state.js";

export type AccountApplicationServiceOptions = {
  env: NodeJS.ProcessEnv;
  home: string;
  configPath: string;
  runtimeState: DaemonRuntimeState;
  sidecar: CliproxySidecar;
  activity: AccountActivityCoordinator;
  authHealth: AccountAuthCoordinator;
  recovery: AccountTransactionRecovery;
  activeRouter(): RunningRouter;
  replaceRouter(
    config: RouterConfig,
    document: string,
    mutation: DaemonGenerationMutation
  ): Effect.Effect<void, Error, RouteKitPlatform>;
  onTransactionPhase?: (
    phase: "prepared" | "credentials-written" | "router-swapped" | "committed"
  ) => void;
};
