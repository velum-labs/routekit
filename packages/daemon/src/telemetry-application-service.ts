import type { EffectRouteKitControlHandlers } from "@velum-labs/routekit-control/effect";
import {
  TELEMETRY_SCHEMA_INVENTORY,
  type TelemetryStatus,
  telemetryStatusMetadata
} from "@velum-labs/routekit-telemetry-core";
import { Effect } from "effect";

import { DaemonEnv } from "./daemon-env-context.js";
import { DaemonState } from "./daemon-state-context.js";
import { Telemetry } from "./services/telemetry/service.js";
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

/** Binds telemetry use cases to the control protocol. */
export class TelemetryApplicationService {
  handlers(): TelemetryHandlers {
    return {
      "telemetry.get": () =>
        Effect.gen(function* () {
          const daemonEnv = yield* DaemonEnv;
          const telemetry = yield* Telemetry;
          return telemetryStatus(daemonEnv.env, telemetry.consent);
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
                  telemetry.gateway.flush();
                  yield* telemetry.flushAndShutdown;
                } else {
                  yield* telemetry.discardDaemon;
                }
                telemetry.gateway.discard();
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
              telemetry.gateway.flush();
              yield* telemetry.flushAndShutdown;
              telemetry.gateway.discard();
              yield* telemetry.resetIdentity(env.env, env.packageVersion);
              return telemetryStatus(env.env, telemetry.consent);
            })
          );
        }),
      "telemetry.schema": () => Effect.succeed(TELEMETRY_SCHEMA_INVENTORY),
      "telemetry.captureCommand": (params) =>
        Effect.gen(function* () {
          const telemetry = yield* Telemetry;
          return { accepted: telemetry.daemon.capture("routekit.command_completed", params) };
        })
    };
  }
}
