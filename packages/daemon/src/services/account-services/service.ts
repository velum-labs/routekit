import {
  AccountActivity,
  type AccountActivityService,
  AccountAuth,
  type AccountAuthService
} from "@velum-labs/routekit-accounts/effect";
import { Effect } from "effect";

import type { CliproxySidecar } from "../../cliproxy-sidecar.js";
import type { DaemonGenerationManager } from "../../daemon-generations.js";
import { ActiveGateway, type ActiveGatewayValue } from "../active-gateway/service.js";
import { DaemonEnv, type DaemonEnvValue } from "../daemon-env/service.js";
import { DaemonState, type DaemonStateService } from "../daemon-state/service.js";
import { Generations } from "../generations/service.js";
import { Sidecar } from "../sidecar/service.js";

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
  DaemonEnv | DaemonState | Generations | AccountActivity | AccountAuth | Sidecar | ActiveGateway
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
