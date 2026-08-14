import { AccountActivity, AccountAuth } from "@velum-labs/routekit-accounts/effect";
import type { TokenStore } from "@velum-labs/routekit-runtime";
import { RouteKitLive } from "@velum-labs/routekit-runtime/effect";
import { Effect, Layer } from "effect";
import type { CliproxySidecar } from "../cliproxy-sidecar.js";
import { createDaemonGenerationManager } from "../daemon-generations.js";
import type { DaemonRuntimeState } from "../daemon-runtime-state.js";
import {
  ActiveGateway,
  DaemonEnv,
  type DaemonEnvValue,
  type DaemonGenerationHooks,
  DaemonState,
  Generations,
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
  | Generations;

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
    Layer.succeed(DaemonState, options.state),
    Layer.succeed(Sidecar, options.sidecar),
    Layer.succeed(Tokens, options.tokens),
    Layer.succeed(Telemetry, options.telemetry),
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
