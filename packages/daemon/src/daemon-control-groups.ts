import type { RouteKitControlHandlers } from "@velum-labs/routekit-control";
import type { TokenStore } from "@velum-labs/routekit-runtime";
import { ControlError, encodeJoinCredential } from "@velum-labs/routekit-runtime";
import type {
  TelemetryCategory,
  TelemetrySchemaInventory,
  TelemetryStatus
} from "@velum-labs/routekit-telemetry-core";
import { daemonPublicRecordPath } from "./daemon-state.js";
import type { DaemonTelemetry, GatewayTelemetryAggregator } from "./telemetry.js";

type TokenControlHandlers = Pick<
  RouteKitControlHandlers,
  "tokens.issue" | "tokens.list" | "tokens.revoke"
>;

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

type TelemetryControlHandlers = Pick<
  RouteKitControlHandlers,
  | "telemetry.get"
  | "telemetry.set"
  | "telemetry.resetIdentity"
  | "telemetry.schema"
  | "telemetry.captureCommand"
>;

export function createTokenControlHandlers(input: {
  home: string;
  tokens: TokenStore;
  dataTokenCache: Map<string, string>;
}): TokenControlHandlers {
  return {
    "tokens.issue": async (params, context) => {
      try {
        const issued = input.tokens.issue({
          label: params.label,
          plane: params.plane,
          role: "admin",
          createdBy: params.createdBy ?? context.principal?.label ?? "control"
        });
        if (issued.plane === "data") input.dataTokenCache.set(issued.label, issued.token);
        return {
          id: issued.id,
          label: issued.label,
          plane: issued.plane,
          role: issued.role,
          token: issued.token,
          ...(issued.plane === "control"
            ? {
                joinCredential: encodeJoinCredential({
                  publicRecordPath: daemonPublicRecordPath(input.home),
                  token: issued.token
                })
              }
            : {})
        };
      } catch (error) {
        throw new ControlError({
          code: "bad_request",
          message: error instanceof Error ? error.message : String(error)
        });
      }
    },
    "tokens.list": async (params) => ({
      tokens: input.tokens.list(params.plane)
    }),
    "tokens.revoke": async (params) => {
      try {
        const revoked = input.tokens.revoke(params.id);
        if (revoked.plane === "data") input.dataTokenCache.delete(revoked.label);
        return revoked;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new ControlError({
          code: message.startsWith("unknown token") ? "not_found" : "bad_request",
          message
        });
      }
    }
  };
}

export function createTelemetryControlHandlers(input: {
  env: NodeJS.ProcessEnv;
  packageVersion: string;
  telemetry: TelemetryConsentManager;
  telemetryStatus(): TelemetryStatus;
  schema: TelemetrySchemaInventory;
  serializeMutation<T>(operation: () => Promise<T>): Promise<T>;
  daemonTelemetry?: DaemonTelemetry;
  gatewayTelemetry?: GatewayTelemetryAggregator;
}): TelemetryControlHandlers {
  return {
    "telemetry.get": async () => input.telemetryStatus(),
    "telemetry.set": async (params) => {
      await input.serializeMutation(async () => {
        if (params.enabled === false) {
          if (input.telemetry.resolve(input.env).enabled) {
            input.gatewayTelemetry?.flush();
            await input.daemonTelemetry?.flush();
            await input.daemonTelemetry?.shutdown();
          } else {
            await input.daemonTelemetry?.discard();
          }
          input.gatewayTelemetry?.discard();
        }
        if (params.enabled !== undefined) {
          if (params.enabled) input.telemetry.enable();
          else input.telemetry.disable();
        }
        if (params.category !== undefined && params.categoryEnabled !== undefined) {
          if (
            !params.categoryEnabled &&
            (params.category === "usage" || params.category === "reliability")
          ) {
            input.gatewayTelemetry?.discard(params.category);
          }
          input.telemetry.setCategory(params.category, params.categoryEnabled);
        }
        const result = input.telemetry.resolve(input.env);
        if (result.enabled && result.categories.adoption) {
          input.daemonTelemetry?.capture("routekit.telemetry_preference_changed", {
            action: params.enabled !== undefined ? "master" : "category",
            ...(params.category !== undefined ? { category: params.category } : {}),
            enabled: params.enabled ?? params.categoryEnabled!,
            source: result.source,
            version: input.packageVersion
          });
        }
      });
      return input.telemetryStatus();
    },
    "telemetry.resetIdentity": async () => {
      await input.serializeMutation(async () => {
        input.gatewayTelemetry?.flush();
        await input.daemonTelemetry?.flush();
        await input.daemonTelemetry?.shutdown();
        input.gatewayTelemetry?.discard();
        input.telemetry.resetIdentity(input.env);
        const result = input.telemetry.resolve(input.env);
        if (result.enabled && result.categories.adoption) {
          input.daemonTelemetry?.capture("routekit.telemetry_preference_changed", {
            action: "identity-reset",
            enabled: true,
            source: result.source,
            version: input.packageVersion
          });
        }
      });
      return input.telemetryStatus();
    },
    "telemetry.schema": async () => input.schema,
    "telemetry.captureCommand": async (params) => ({
      accepted: input.daemonTelemetry?.capture("routekit.command_completed", params) ?? false
    })
  };
}
