import type { DaemonStatus } from "@velum-labs/routekit-control";
import type { EffectRouteKitControlHandlers } from "@velum-labs/routekit-control/effect";
import { CONTROL_PROTOCOL_VERSION, ControlError } from "@velum-labs/routekit-runtime/control";
import { supervisorFromEnv } from "@velum-labs/routekit-runtime/service";
import { durationBucket } from "@velum-labs/routekit-telemetry-core";
import { Clock, Effect } from "effect";
import { DAEMON_HOST_PROTOCOL_VERSION } from "./host-protocol.js";
import { ActiveGateway } from "./services/active-gateway/service.js";
import { DaemonEnv } from "./daemon-env-context.js";
import { DaemonHost } from "./daemon-host-context.js";
import { DaemonState } from "./daemon-state-context.js";
import { Telemetry } from "./services/telemetry/service.js";

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
          return {
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
          } satisfies DaemonStatus;
        }),
      "daemon.roll": (params) =>
        Effect.gen(function* () {
          const env = yield* DaemonEnv;
          const telemetry = yield* Telemetry;
          const host = yield* DaemonHost;
          if (host.onRollRequested === undefined) {
            return yield* Effect.fail(
              new ControlError({
                code: "upgrade_required",
                message: "this daemon does not support rolling process replacement"
              })
            );
          }
          const startedAt = yield* Clock.currentTimeMillis;
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
          return yield* host.onRollRequested(params).pipe(
            Effect.tap((result) =>
              Effect.gen(function* () {
                const finishedAt = yield* Clock.currentTimeMillis;
                telemetry.daemon?.capture("routekit.daemon_lifecycle", {
                  action: "roll_committed",
                  outcome: "success",
                  supervisor,
                  version: result.packageVersion,
                  reason: params.reason,
                  from_version: env.packageVersion,
                  to_version: result.packageVersion,
                  duration_bucket: durationBucket(finishedAt - startedAt)
                });
              })
            ),
            Effect.tapError(() =>
              Effect.gen(function* () {
                const finishedAt = yield* Clock.currentTimeMillis;
                telemetry.daemon?.capture("routekit.daemon_lifecycle", {
                  action: "roll_failed",
                  outcome: "error",
                  supervisor,
                  version: env.packageVersion,
                  reason: params.reason,
                  from_version: env.packageVersion,
                  to_version: toVersion,
                  rollback_stage: "candidate",
                  duration_bucket: durationBucket(finishedAt - startedAt)
                });
              })
            )
          );
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
          if (host.onShutdownRequested !== undefined) {
            yield* host.onShutdownRequested(params.reason).pipe(Effect.forkDetach);
          }
          return { accepted: true };
        })
    };
  }
}
