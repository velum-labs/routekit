import type { EffectRouteKitControlHandlers } from "@velum-labs/routekit-control/effect";
import type {
  TelemetryCategory,
  TelemetrySchemaInventory,
  TelemetryStatus
} from "@velum-labs/routekit-telemetry-core";
import { controlTry, controlTryPromise } from "./control-effect.js";
import type { DaemonTelemetry, GatewayTelemetryAggregator } from "./telemetry.js";

type TelemetryConsentManager = {
  resolve(env: NodeJS.ProcessEnv): {
    enabled: boolean;
    source: "do-not-track" | "env" | "config" | "default";
    categories: Record<TelemetryCategory, boolean>;
  };
  enable(): unknown;
  disable(): unknown;
  setCategory(category: TelemetryCategory, enabled: boolean): unknown;
  resetIdentity(env: NodeJS.ProcessEnv): unknown;
};

type TelemetryHandlers = Pick<
  EffectRouteKitControlHandlers,
  | "telemetry.get"
  | "telemetry.set"
  | "telemetry.resetIdentity"
  | "telemetry.schema"
  | "telemetry.captureCommand"
>;

export type TelemetryApplicationServiceOptions = {
  env: NodeJS.ProcessEnv;
  packageVersion: string;
  telemetry: TelemetryConsentManager;
  telemetryStatus(): TelemetryStatus;
  schema: TelemetrySchemaInventory;
  serializeMutation<T>(operation: () => Promise<T>): Promise<T>;
  daemonTelemetry?: DaemonTelemetry;
  gatewayTelemetry?: GatewayTelemetryAggregator;
};

/** Owns telemetry consent, identity reset, schema, and command capture. */
export class TelemetryApplicationService {
  constructor(private readonly options: TelemetryApplicationServiceOptions) {}

  handlers(): TelemetryHandlers {
    const options = this.options;
    return {
      "telemetry.get": () => controlTry(() => options.telemetryStatus()),
      "telemetry.set": (params) =>
        controlTryPromise(async () => {
        await options.serializeMutation(async () => {
          if (params.enabled === false) {
            if (options.telemetry.resolve(options.env).enabled) {
              options.gatewayTelemetry?.flush();
              await options.daemonTelemetry?.flush();
              await options.daemonTelemetry?.shutdown();
            } else {
              await options.daemonTelemetry?.discard();
            }
            options.gatewayTelemetry?.discard();
          }
          if (params.enabled !== undefined) {
            if (params.enabled) options.telemetry.enable();
            else options.telemetry.disable();
          }
          if (params.category !== undefined && params.categoryEnabled !== undefined) {
            if (
              !params.categoryEnabled &&
              (params.category === "usage" || params.category === "reliability")
            ) {
              options.gatewayTelemetry?.discard(params.category);
            }
            options.telemetry.setCategory(params.category, params.categoryEnabled);
          }
          const result = options.telemetry.resolve(options.env);
          if (result.enabled && result.categories.adoption) {
            options.daemonTelemetry?.capture("routekit.telemetry_preference_changed", {
              action: params.enabled !== undefined ? "master" : "category",
              ...(params.category !== undefined ? { category: params.category } : {}),
              enabled: params.enabled ?? params.categoryEnabled!,
              source: result.source,
              version: options.packageVersion
            });
          }
        });
        return options.telemetryStatus();
      }),
      "telemetry.resetIdentity": () =>
        controlTryPromise(async () => {
        await options.serializeMutation(async () => {
          options.gatewayTelemetry?.flush();
          await options.daemonTelemetry?.flush();
          await options.daemonTelemetry?.shutdown();
          options.gatewayTelemetry?.discard();
          options.telemetry.resetIdentity(options.env);
          const result = options.telemetry.resolve(options.env);
          if (result.enabled && result.categories.adoption) {
            options.daemonTelemetry?.capture("routekit.telemetry_preference_changed", {
              action: "identity-reset",
              enabled: true,
              source: result.source,
              version: options.packageVersion
            });
          }
        });
        return options.telemetryStatus();
      }),
      "telemetry.schema": () => controlTry(() => options.schema),
      "telemetry.captureCommand": (params) =>
        controlTry(() => ({
          accepted: options.daemonTelemetry?.capture("routekit.command_completed", params) ?? false
        }))
    };
  }
}
