import { Context } from "effect";

import type { DaemonTelemetry, GatewayTelemetryAggregator } from "../../telemetry.js";

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
};

export class Telemetry extends Context.Service<Telemetry, TelemetryServiceValue>()(
  "@velum-labs/routekit-daemon/Telemetry"
) {}
