import type { RouteKitControlParams } from "@velum-labs/routekit-control";
import type { EffectRouteKitControlHandlers } from "@velum-labs/routekit-control/effect";
import {
  TELEMETRY_SCHEMA_INVENTORY,
  type TelemetryStatus,
  telemetryStatusMetadata
} from "@velum-labs/routekit-telemetry-core";
import { Context, Effect } from "effect";
import {
  type DaemonTelemetry,
  DEFAULT_TELEMETRY_HOST,
  type GatewayTelemetryAggregator,
  resolveTelemetryProjectKey
} from "../../telemetry.js";
import { DaemonEnv } from "../../daemon-env-context.js";
import { DaemonState } from "../../daemon-state-context.js";

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
  readonly flushAndShutdown: Effect.Effect<void, Error>;
  readonly discardDaemon: Effect.Effect<void, Error>;
  applyPreference(
    params: RouteKitControlParams["telemetry.set"],
    env: NodeJS.ProcessEnv,
    packageVersion: string
  ): Effect.Effect<void, Error>;
  resetIdentity(env: NodeJS.ProcessEnv, packageVersion: string): Effect.Effect<void, Error>;
};

export class Telemetry extends Context.Service<Telemetry, TelemetryServiceValue>()(
  "@velum-labs/routekit-daemon/Telemetry"
) {}

type TelemetryHandlers = Pick<
  EffectRouteKitControlHandlers,
  | "telemetry.get"
  | "telemetry.set"
  | "telemetry.resetIdentity"
  | "telemetry.schema"
  | "telemetry.captureCommand"
>;

function telemetryStatus(
  env: NodeJS.ProcessEnv,
  consent: Telemetry["Service"]["consent"]
): TelemetryStatus {
  return telemetryStatusMetadata(consent.resolve(env), {
    provider: "posthog",
    host: env.ROUTEKIT_POSTHOG_HOST?.trim() || DEFAULT_TELEMETRY_HOST,
    configured: resolveTelemetryProjectKey(env).length > 0
  }) as TelemetryStatus;
}

/** Owns telemetry consent, identity reset, schema, and command capture. */
export class TelemetryApplicationService {
  handlers(): TelemetryHandlers {
    return {
      "telemetry.get": () =>
        Effect.gen(function* () {
          const daemonEnv = yield* DaemonEnv;
          const telemetry = yield* Telemetry;
          return telemetryStatusMetadata(telemetry.consent.resolve(daemonEnv.env), {
            provider: "posthog",
            host: daemonEnv.env.ROUTEKIT_POSTHOG_HOST?.trim() || DEFAULT_TELEMETRY_HOST,
            configured: resolveTelemetryProjectKey(daemonEnv.env).length > 0
          }) as TelemetryStatus;
        }),
      "telemetry.set": (params) =>
        Effect.gen(function* () {
          const env = yield* DaemonEnv;
          const state = yield* DaemonState;
          const telemetry = yield* Telemetry;
          return yield* state.serializeEffect(
            Effect.gen(function* () {
              if (params.enabled === false) {
                if (telemetry.consent.resolve(env.env).enabled) {
                  telemetry.gateway?.flush();
                  yield* telemetry.flushAndShutdown;
                } else {
                  yield* telemetry.discardDaemon;
                }
                telemetry.gateway?.discard();
              }
              yield* telemetry.applyPreference(params, env.env, env.packageVersion);
              return telemetryStatus(env.env, telemetry.consent);
            })
          );
        }),
      "telemetry.resetIdentity": () =>
        Effect.gen(function* () {
          const env = yield* DaemonEnv;
          const state = yield* DaemonState;
          const telemetry = yield* Telemetry;
          return yield* state.serializeEffect(
            Effect.gen(function* () {
              telemetry.gateway?.flush();
              yield* telemetry.flushAndShutdown;
              telemetry.gateway?.discard();
              yield* telemetry.resetIdentity(env.env, env.packageVersion);
              return telemetryStatus(env.env, telemetry.consent);
            })
          );
        }),
      "telemetry.schema": () => Effect.succeed(TELEMETRY_SCHEMA_INVENTORY),
      "telemetry.captureCommand": (params) =>
        Effect.gen(function* () {
          const telemetry = yield* Telemetry;
          return {
            accepted: telemetry.daemon?.capture("routekit.command_completed", params) ?? false
          };
        })
    };
  }
}
