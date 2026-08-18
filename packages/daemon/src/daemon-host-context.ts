import type { RouteKitControlParams, RouteKitControlResults } from "@velum-labs/routekit-control";
import { Context, Effect } from "effect";

export type DaemonHostValue = {
  onShutdownRequested?: (
    reason: "stop" | "restart" | "upgrade"
  ) => Effect.Effect<void, never>;
  onRollRequested?: (
    params: RouteKitControlParams["daemon.roll"]
  ) => Effect.Effect<RouteKitControlResults["daemon.roll"], Error>;
  onAccountTransactionPhase?: (
    phase: "prepared" | "credentials-written" | "router-swapped" | "committed"
  ) => void;
};

export class DaemonHost extends Context.Service<DaemonHost, DaemonHostValue>()(
  "@velum-labs/routekit-daemon/DaemonHost"
) {}
