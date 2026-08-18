import type { RouteKitControlParams, RouteKitControlResults } from "@velum-labs/routekit-control";
import type { WorkloadJwtVerifierOptions } from "@velum-labs/routekit-gateway";
import type { DaemonBootstrapHostedOptions } from "./daemon-bootstrap-preflight.js";
import type { DaemonGenerationManagerOptions } from "./daemon-generations.js";
import type { TelemetryTransportFactory } from "./telemetry.js";

export type RouteKitDaemonOptions = {
  packageVersion: string;
  env?: NodeJS.ProcessEnv;
  stateHome?: string;
  configPath?: string;
  host?: string;
  port?: number;
  controlPort?: number;
  authToken?: string;
  authTokenFile?: string;
  workloadJwt?: WorkloadJwtVerifierOptions;
  portless?: boolean;
  drainGraceMs?: number;
  onShutdownRequested?: (reason: "stop" | "restart" | "upgrade") => void;
  onRollRequested?: (
    params: RouteKitControlParams["daemon.roll"]
  ) => Promise<RouteKitControlResults["daemon.roll"]>;
  hosted?: DaemonBootstrapHostedOptions;
  telemetryTransportFactory?: TelemetryTransportFactory;
  telemetryFlushIntervalMs?: number;
  onAccountTransactionPhase?: (
    phase: "prepared" | "credentials-written" | "router-swapped" | "committed"
  ) => void;
  onGenerationStage?: DaemonGenerationManagerOptions["onStage"];
};
