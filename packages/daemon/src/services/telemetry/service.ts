import { join } from "node:path";
import type { RouteKitControlParams } from "@velum-labs/routekit-control";
import {
  RouteKitFailure,
  toRouteKitFailure
} from "@velum-labs/routekit-runtime/effect";
import { createConsentManager } from "@velum-labs/routekit-telemetry-core";
import { Context, Effect, Layer } from "effect";

import {
  DaemonTelemetry,
  GatewayTelemetryAggregator,
  type TelemetryTransportFactory
} from "../../telemetry.js";

export type TelemetryServiceValue = {
  readonly consent: ReturnType<typeof createConsentManager>;
  readonly daemon: DaemonTelemetry;
  readonly gateway: GatewayTelemetryAggregator;
  readonly flushAndShutdown: Effect.Effect<void>;
  readonly discardDaemon: Effect.Effect<void>;
  applyPreference(
    params: RouteKitControlParams["telemetry.set"],
    env: NodeJS.ProcessEnv,
    packageVersion: string
  ): Effect.Effect<void, RouteKitFailure>;
  resetIdentity(
    env: NodeJS.ProcessEnv,
    packageVersion: string
  ): Effect.Effect<void, RouteKitFailure>;
};

export type TelemetryLayerOptions = {
  readonly home: string;
  readonly env: NodeJS.ProcessEnv;
  readonly packageVersion: string;
  readonly transportFactory?: TelemetryTransportFactory;
  readonly flushIntervalMs?: number;
};

/** Owns consent, the PostHog transport, and gateway aggregation as one lifetime. */
export class Telemetry extends Context.Service<Telemetry, TelemetryServiceValue>()(
  "@velum-labs/routekit-daemon/Telemetry"
) {
  static layer(options: TelemetryLayerOptions): Layer.Layer<Telemetry> {
    return Layer.effect(
      Telemetry,
      Effect.acquireRelease(
        Effect.sync(() => {
          const consent = createConsentManager({
            path: () => join(options.home, "telemetry.json"),
            environmentVariable: "ROUTEKIT_TELEMETRY"
          });
          const daemon = new DaemonTelemetry({
            env: options.env,
            resolveConsent: consent.resolve,
            ...(options.transportFactory === undefined
              ? {}
              : { factory: options.transportFactory })
          });
          const gateway = new GatewayTelemetryAggregator({
            telemetry: daemon,
            version: options.packageVersion,
            ...(options.flushIntervalMs === undefined
              ? {}
              : { flushIntervalMs: options.flushIntervalMs })
          });
          const flushAndShutdown = Effect.promise(async () => {
            await daemon.flush();
            await daemon.shutdown();
          });
          const discardDaemon = Effect.promise(() => daemon.discard());
          return Telemetry.of({
            consent,
            daemon,
            gateway,
            flushAndShutdown,
            discardDaemon,
            applyPreference: (params, env, packageVersion) =>
              Effect.try({
                try: () => {
                  if (params.enabled !== undefined) {
                    if (params.enabled) consent.enable();
                    else consent.disable();
                  }
                  if (params.category !== undefined && params.categoryEnabled !== undefined) {
                    if (
                      !params.categoryEnabled &&
                      (params.category === "usage" || params.category === "reliability")
                    ) {
                      gateway.discard(params.category);
                    }
                    consent.setCategory(params.category, params.categoryEnabled);
                  }
                  const result = consent.resolve(env);
                  if (result.enabled && result.categories.adoption) {
                    daemon.capture("routekit.telemetry_preference_changed", {
                      action: params.enabled !== undefined ? "master" : "category",
                      ...(params.category !== undefined ? { category: params.category } : {}),
                      enabled: params.enabled ?? params.categoryEnabled!,
                      source: result.source,
                      version: packageVersion
                    });
                  }
                },
                catch: toRouteKitFailure
              }),
            resetIdentity: (env, packageVersion) =>
              Effect.try({
                try: () => {
                  consent.resetIdentity(env);
                  const result = consent.resolve(env);
                  if (result.enabled && result.categories.adoption) {
                    daemon.capture("routekit.telemetry_preference_changed", {
                      action: "identity-reset",
                      enabled: true,
                      source: result.source,
                      version: packageVersion
                    });
                  }
                },
                catch: toRouteKitFailure
              })
          });
        }),
        (telemetry) =>
          Effect.sync(() => telemetry.gateway.close()).pipe(
            Effect.andThen(Effect.promise(() => telemetry.daemon.shutdown()))
          )
      )
    );
  }
}
