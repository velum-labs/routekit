import type { RouteKitControlParams, RouteKitControlResults } from "@velum-labs/routekit-control";
import { Context } from "effect";

export type DaemonHostValue = {
  onShutdownRequested?: (reason: "stop" | "restart" | "upgrade") => void;
  onRollRequested?: (
    params: RouteKitControlParams["daemon.roll"]
  ) => Promise<RouteKitControlResults["daemon.roll"]>;
  onAccountTransactionPhase?: (
    phase: "prepared" | "credentials-written" | "router-swapped" | "committed"
  ) => void;
};

export class DaemonHost extends Context.Service<DaemonHost, DaemonHostValue>()(
  "@velum-labs/routekit-daemon/DaemonHost"
) {}
