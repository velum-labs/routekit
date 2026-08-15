import type { EffectRouteKitControlHandlers } from "@velum-labs/routekit-control/effect";
import {
  TELEMETRY_SCHEMA_INVENTORY,
  type TelemetryStatus,
  telemetryStatusMetadata
} from "@velum-labs/routekit-telemetry-core";
import { Effect } from "effect";
import { controlTry, controlTryPromise } from "./control-effect.js";
import { DaemonEnv, DaemonState, Telemetry } from "./effect/services.js";
import { DEFAULT_TELEMETRY_HOST, resolveTelemetryProjectKey } from "./telemetry.js";

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
                  yield* controlTryPromise(async () => {
                    await telemetry.daemon?.flush();
                    await telemetry.daemon?.shutdown();
                  });
                } else {
                  yield* controlTryPromise(async () => {
                    await telemetry.daemon?.discard();
                  });
                }
                telemetry.gateway?.discard();
              }
              yield* controlTry(() => {
                if (params.enabled !== undefined) {
                  if (params.enabled) telemetry.consent.enable();
                  else telemetry.consent.disable();
                }
                if (params.category !== undefined && params.categoryEnabled !== undefined) {
                  if (
                    !params.categoryEnabled &&
                    (params.category === "usage" || params.category === "reliability")
                  ) {
                    telemetry.gateway?.discard(params.category);
                  }
                  telemetry.consent.setCategory(params.category, params.categoryEnabled);
                }
                const result = telemetry.consent.resolve(env.env);
                if (result.enabled && result.categories.adoption) {
                  telemetry.daemon?.capture("routekit.telemetry_preference_changed", {
                    action: params.enabled !== undefined ? "master" : "category",
                    ...(params.category !== undefined ? { category: params.category } : {}),
                    enabled: params.enabled ?? params.categoryEnabled!,
                    source: result.source,
                    version: env.packageVersion
                  });
                }
              });
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
              yield* controlTryPromise(async () => {
                await telemetry.daemon?.flush();
                await telemetry.daemon?.shutdown();
              });
              telemetry.gateway?.discard();
              yield* controlTry(() => {
                telemetry.consent.resetIdentity(env.env);
                const result = telemetry.consent.resolve(env.env);
                if (result.enabled && result.categories.adoption) {
                  telemetry.daemon?.capture("routekit.telemetry_preference_changed", {
                    action: "identity-reset",
                    enabled: true,
                    source: result.source,
                    version: env.packageVersion
                  });
                }
              });
              return telemetryStatus(env.env, telemetry.consent);
            })
          );
        }),
      "telemetry.schema": () => controlTry(() => TELEMETRY_SCHEMA_INVENTORY),
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
