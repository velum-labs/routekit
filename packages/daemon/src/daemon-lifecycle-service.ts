import type { DaemonStatus } from "@velum-labs/routekit-control";
import type { EffectRouteKitControlHandlers } from "@velum-labs/routekit-control/effect";
import {
  CONTROL_PROTOCOL_VERSION,
  ControlError,
  supervisorFromEnv
} from "@velum-labs/routekit-runtime";
import { durationBucket } from "@velum-labs/routekit-telemetry-core";
import { Effect } from "effect";
import { controlTry, controlTryPromise } from "./control-effect.js";
import { ActiveGateway, DaemonEnv, DaemonHost, DaemonState, Telemetry } from "./effect/services.js";
import { DAEMON_HOST_PROTOCOL_VERSION } from "./host-protocol.js";

type LifecycleHandlers = Pick<
  EffectRouteKitControlHandlers,
  "daemon.status" | "daemon.roll" | "daemon.prepareShutdown"
>;

/** Owns daemon status, rolling replacement, and shutdown preparation. */
export class DaemonLifecycleService {
  handlers(): LifecycleHandlers {
    return {
      "daemon.status": () =>
        Effect.gen(function* () {
          const env = yield* DaemonEnv;
          const state = yield* DaemonState;
          const gateway = yield* ActiveGateway;
          return yield* controlTry(
            () =>
              ({
                pid: process.pid,
                workerPid: process.pid,
                hostPid: env.hosted?.hostPid ?? process.pid,
                hostStartedAt: env.hosted?.hostStartedAt ?? env.startedAt,
                startedAt: env.startedAt,
                packageVersion: env.packageVersion,
                protocolVersion: CONTROL_PROTOCOL_VERSION,
                hostProtocolVersion: env.hosted === undefined ? 0 : DAEMON_HOST_PROTOCOL_VERSION,
                generation: env.generation,
                configRevision: state.revisions.config,
                accountRevision: state.revisions.accounts,
                controlUrl: gateway.control()?.url ?? "",
                dataUrl: env.hosted?.dataUrl() ?? gateway.dataUrl() ?? "",
                dataPort: gateway.proxy()?.port() ?? 0,
                supervisor: supervisorFromEnv(env.env),
                draining: state.draining,
                rolling: env.hosted?.rolling() ?? false
              }) satisfies DaemonStatus
          );
        }),
      "daemon.roll": (params) =>
        Effect.gen(function* () {
          const env = yield* DaemonEnv;
          const telemetry = yield* Telemetry;
          const host = yield* DaemonHost;
          return yield* controlTryPromise(async () => {
            if (host.onRollRequested === undefined) {
              throw new ControlError({
                code: "upgrade_required",
                message: "this daemon does not support rolling process replacement"
              });
            }
            const startedAt = Date.now();
            const supervisor = (["systemd", "launchd", "detached"] as const).includes(
              supervisorFromEnv(env.env) as never
            )
              ? (supervisorFromEnv(env.env) as "systemd" | "launchd" | "detached")
              : "unknown";
            const toVersion = params.candidate?.expectedVersion ?? env.packageVersion;
            telemetry.daemon?.capture("routekit.daemon_lifecycle", {
              action: "roll_started",
              outcome: "success",
              supervisor,
              version: env.packageVersion,
              reason: params.reason,
              from_version: env.packageVersion,
              to_version: toVersion
            });
            try {
              const result = await host.onRollRequested(params);
              telemetry.daemon?.capture("routekit.daemon_lifecycle", {
                action: "roll_committed",
                outcome: "success",
                supervisor,
                version: result.packageVersion,
                reason: params.reason,
                from_version: env.packageVersion,
                to_version: result.packageVersion,
                duration_bucket: durationBucket(Date.now() - startedAt)
              });
              return result;
            } catch (error) {
              telemetry.daemon?.capture("routekit.daemon_lifecycle", {
                action: "roll_failed",
                outcome: "error",
                supervisor,
                version: env.packageVersion,
                reason: params.reason,
                from_version: env.packageVersion,
                to_version: toVersion,
                rollback_stage: "candidate",
                duration_bucket: durationBucket(Date.now() - startedAt)
              });
              throw error;
            }
          });
        }),
      "daemon.prepareShutdown": (params) =>
        Effect.gen(function* () {
          const state = yield* DaemonState;
          if (
            state.lifecycle === "quiescing" ||
            state.lifecycle === "draining" ||
            state.lifecycle === "closed"
          ) {
            return { accepted: true };
          }
          const host = yield* DaemonHost;
          state.beginRetire();
          yield* state.awaitMutations;
          queueMicrotask(() => host.onShutdownRequested?.(params.reason));
          return { accepted: true };
        })
    };
  }
}
