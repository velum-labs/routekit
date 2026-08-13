import type {
  DaemonStatus,
  RouteKitControlParams,
  RouteKitControlResults
} from "@velum-labs/routekit-control";
import type { EffectRouteKitControlHandlers } from "@velum-labs/routekit-control/effect";
import type { SwitchingGatewayProxy } from "@velum-labs/routekit-gateway";
import {
  CONTROL_PROTOCOL_VERSION,
  ControlError,
  type RunningControlServer,
  supervisorFromEnv
} from "@velum-labs/routekit-runtime";
import { durationBucket } from "@velum-labs/routekit-telemetry-core";
import { controlTry, controlTryPromise } from "./control-effect.js";
import type { DaemonRuntimeState } from "./daemon-runtime-state.js";
import { DAEMON_HOST_PROTOCOL_VERSION } from "./host-protocol.js";
import type { DaemonTelemetry } from "./telemetry.js";

type LifecycleHandlers = Pick<
  EffectRouteKitControlHandlers,
  "daemon.status" | "daemon.roll" | "daemon.prepareShutdown"
>;

export type DaemonLifecycleServiceOptions = {
  env: NodeJS.ProcessEnv;
  dataUrl: string;
  generation: number;
  startedAt: string;
  packageVersion: string;
  hosted:
    | { hostPid: number; hostStartedAt: string; rolling: () => boolean; dataUrl: () => string }
    | undefined;
  runtimeState: DaemonRuntimeState;
  proxy: () => SwitchingGatewayProxy | undefined;
  control: () => RunningControlServer | undefined;
  daemonTelemetry?: DaemonTelemetry;
  onShutdownRequested?: (reason: "stop" | "restart" | "upgrade") => void;
  onRollRequested?: (
    params: RouteKitControlParams["daemon.roll"]
  ) => Promise<RouteKitControlResults["daemon.roll"]>;
};

/** Owns daemon status, rolling replacement, and shutdown preparation. */
export class DaemonLifecycleService {
  constructor(private readonly options: DaemonLifecycleServiceOptions) {}

  handlers(): LifecycleHandlers {
    const options = this.options;
    return {
      "daemon.status": () =>
        controlTry(
          () =>
            ({
          pid: process.pid,
          workerPid: process.pid,
          hostPid: options.hosted?.hostPid ?? process.pid,
          hostStartedAt: options.hosted?.hostStartedAt ?? options.startedAt,
          startedAt: options.startedAt,
          packageVersion: options.packageVersion,
          protocolVersion: CONTROL_PROTOCOL_VERSION,
          hostProtocolVersion: options.hosted === undefined ? 0 : DAEMON_HOST_PROTOCOL_VERSION,
          generation: options.generation,
          configRevision: options.runtimeState.revisions.config,
          accountRevision: options.runtimeState.revisions.accounts,
          controlUrl: options.control()?.url ?? "",
          dataUrl: options.hosted?.dataUrl() ?? options.dataUrl,
          dataPort: options.proxy()?.port() ?? 0,
          supervisor: supervisorFromEnv(options.env),
          draining: options.runtimeState.draining,
          rolling: options.hosted?.rolling() ?? false
        }) satisfies DaemonStatus
        ),
      "daemon.roll": (params) =>
        controlTryPromise(async () => {
        if (options.onRollRequested === undefined) {
          throw new ControlError({
            code: "upgrade_required",
            message: "this daemon does not support rolling process replacement"
          });
        }
        const startedAt = Date.now();
        const supervisor = (["systemd", "launchd", "detached"] as const).includes(
          supervisorFromEnv(options.env) as never
        )
          ? (supervisorFromEnv(options.env) as "systemd" | "launchd" | "detached")
          : "unknown";
        const toVersion = params.candidate?.expectedVersion ?? options.packageVersion;
        options.daemonTelemetry?.capture("routekit.daemon_lifecycle", {
          action: "roll_started",
          outcome: "success",
          supervisor,
          version: options.packageVersion,
          reason: params.reason,
          from_version: options.packageVersion,
          to_version: toVersion
        });
        try {
          const result = await options.onRollRequested(params);
          options.daemonTelemetry?.capture("routekit.daemon_lifecycle", {
            action: "roll_committed",
            outcome: "success",
            supervisor,
            version: result.packageVersion,
            reason: params.reason,
            from_version: options.packageVersion,
            to_version: result.packageVersion,
            duration_bucket: durationBucket(Date.now() - startedAt)
          });
          return result;
        } catch (error) {
          options.daemonTelemetry?.capture("routekit.daemon_lifecycle", {
            action: "roll_failed",
            outcome: "error",
            supervisor,
            version: options.packageVersion,
            reason: params.reason,
            from_version: options.packageVersion,
            to_version: toVersion,
            rollback_stage: "candidate",
            duration_bucket: durationBucket(Date.now() - startedAt)
          });
          throw error;
        }
      }),
      "daemon.prepareShutdown": (params) =>
        controlTryPromise(async () => {
        if (
          options.runtimeState.lifecycle === "quiescing" ||
          options.runtimeState.lifecycle === "draining" ||
          options.runtimeState.lifecycle === "closed"
        ) {
          return { accepted: true };
        }
        options.runtimeState.beginRetire();
        await options.runtimeState.awaitMutations();
        queueMicrotask(() => options.onShutdownRequested?.(params.reason));
        return { accepted: true };
      })
    };
  }
}
