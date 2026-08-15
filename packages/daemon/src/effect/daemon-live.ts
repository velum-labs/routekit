import { AccountActivity, AccountAuth } from "@velum-labs/routekit-accounts/effect";
import type { TokenStore } from "@velum-labs/routekit-runtime";
import { RouteKitLive } from "@velum-labs/routekit-runtime/effect";
import { Effect, Layer } from "effect";
import type { AccountTransactionRecovery } from "../account-transaction.js";
import type { CallAttributionStore } from "../call-attribution-store.js";
import type { CliproxySidecar } from "../cliproxy-sidecar.js";
import { createDaemonGenerationManager } from "../daemon-generations.js";
import type { DaemonRuntimeState } from "../daemon-runtime-state.js";
import {
  AccountRecovery,
  ActiveGateway,
  CallAttributions,
  DaemonEnv,
  type DaemonEnvValue,
  type DaemonGenerationHooks,
  DaemonHost,
  type DaemonHostValue,
  DaemonPolicy,
  type DaemonPolicyValue,
  DaemonState,
  DataPlane,
  type DataPlaneValue,
  Generations,
  Leaderboard,
  type LeaderboardValue,
  Sidecar,
  Telemetry,
  type TelemetryServiceValue,
  Tokens
} from "./services.js";

export type DaemonLiveOptions = {
  env: DaemonEnvValue;
  state: DaemonRuntimeState;
  sidecar: CliproxySidecar;
  tokens: TokenStore;
  telemetry: TelemetryServiceValue;
  activityPath: string;
  authPath: string;
  generations: DaemonGenerationHooks;
  dataPlane: DataPlaneValue;
  accountRecovery: AccountTransactionRecovery;
  callAttributions: CallAttributionStore;
  leaderboard: LeaderboardValue;
  policy: DaemonPolicyValue;
  host: DaemonHostValue;
};

export type DaemonLive =
  | DaemonEnv
  | DaemonState
  | Sidecar
  | Tokens
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

/**
 * Daemon-lifetime services provided to control handlers.
 *
 * Coordinators stay mutable class instances. This layer is the composition
 * API: handlers `yield*` services instead of a constructor bag. Generation
 * replace swaps `ActiveGateway` rather than rebuilding the layer.
 */
export function daemonLive(options: DaemonLiveOptions): Layer.Layer<DaemonLive, never, never> {
  const core = Layer.mergeAll(
    Layer.succeed(DaemonEnv, options.env),
    DaemonState.layer(options.state),
    Layer.succeed(Sidecar, options.sidecar),
    Layer.succeed(Tokens, options.tokens),
    Layer.succeed(Telemetry, options.telemetry),
    Layer.succeed(DataPlane, options.dataPlane),
    Layer.succeed(AccountRecovery, options.accountRecovery),
    Layer.succeed(CallAttributions, options.callAttributions),
    Layer.succeed(Leaderboard, options.leaderboard),
    Layer.succeed(DaemonPolicy, options.policy),
    Layer.succeed(DaemonHost, options.host),
    ActiveGateway.layer,
    AccountActivity.layer({ statePath: options.activityPath }),
    AccountAuth.layer({ statePath: options.authPath })
  ).pipe(Layer.provideMerge(RouteKitLive));

  const generations = Layer.effect(
    Generations,
    Effect.gen(function* () {
      const env = yield* DaemonEnv;
      const state = yield* DaemonState;
      const sidecar = yield* Sidecar;
      const activity = yield* AccountActivity;
      const auth = yield* AccountAuth;
      const gateway = yield* ActiveGateway;
      return createDaemonGenerationManager({
        configPath: env.configPath,
        home: env.home,
        drainGraceMs: options.generations.drainGraceMs,
        sidecar,
        routerEnv: options.generations.routerEnv,
        provenance: options.generations.provenance,
        activity,
        authHealth: auth,
        wantsSidecar: options.generations.wantsSidecar,
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
        setActiveRouter: (router) => {
          gateway.setRouter(router);
        },
        getProxy: () => gateway.proxy(),
        activeCredentialFingerprints: options.generations.activeCredentialFingerprints,
        applyConfig: options.generations.applyConfig,
        ...(options.generations.onStage !== undefined
          ? { onStage: options.generations.onStage }
          : {})
      });
    })
  );

  return generations.pipe(Layer.provideMerge(core)) as Layer.Layer<DaemonLive, never, never>;
}
