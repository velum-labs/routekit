import {
  CliError,
  type CliRuntime,
  contextForFlags,
  processCliRuntime
} from "@velum-labs/routekit-cli-core";
import type { ServiceRecord } from "@velum-labs/routekit-runtime/service";
import {
  acquireLifecycleLock,
  supervisorOperationTimeoutMs,
  waitForProcessExit,
  waitForServiceReadyEffect
} from "@velum-labs/routekit-runtime/service";
import { RouteKitFailure } from "@velum-labs/routekit-runtime/effect";
import { Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";

import { cliTry, cliTryPromise } from "../../cli-session.js";
import {
  controlClientForRecord,
  daemonLifecycleLockPath,
  daemonLogPath,
  daemonRecordHealthy,
  ensureDaemon,
  readDaemonRecord
} from "../../client.js";
import { routekitHome } from "../../config.js";
import { daemonSupervisorController } from "../../commands/gateway-service.js";
import { drainGraceMs } from "../../commands/serve-options.js";
import { routekitRoot } from "../root-command.js";

const optionalString = (name: string) =>
  Flag.string(name).pipe(Flag.optional, Flag.map(Option.getOrUndefined));

export const gatewayServeFlags = {
  host: Flag.string("host").pipe(Flag.withDefault("127.0.0.1"), Flag.withDescription("bind host")),
  port: Flag.string("port").pipe(Flag.withDefault("8080"), Flag.withDescription("bind port")),
  authToken: optionalString("auth-token").pipe(
    Flag.withDescription("authentication token (required for non-loopback hosts)")
  ),
  portless: Flag.boolean("portless").pipe(
    Flag.withDefault(true),
    Flag.withDescription("enable the stable local route")
  ),
  drainGrace: optionalString("drain-grace").pipe(
    Flag.withDescription(
      "grace for in-flight requests on shutdown/upgrade (default: $ROUTEKIT_DRAIN_GRACE or 30)"
    )
  )
};

function waitForRolledRecord(input: {
  hostPid: number;
  previousWorkerPid: number;
  generation: number;
  dataUrl?: string;
  timeoutMs?: number;
}): Promise<ServiceRecord> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + (input.timeoutMs ?? 10_000);
    const poll = (): void => {
      const record = readDaemonRecord();
      if (
        record !== undefined &&
        record.pid === input.hostPid &&
        record.workerPid !== undefined &&
        record.workerPid !== input.previousWorkerPid &&
        record.generation === input.generation &&
        (input.dataUrl === undefined || record.dataUrl === input.dataUrl)
      ) {
        resolve(record);
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error("RouteKit daemon roll did not publish the expected worker generation"));
        return;
      }
      setTimeout(poll, 50);
    };
    poll();
  });
}

export const makeStartCommand = (
  runtime: CliRuntime = processCliRuntime
): Command.Command.Any =>
  Command.make("start", gatewayServeFlags, (options) =>
    Effect.gen(function* () {
      const ctx = contextForFlags(yield* routekitRoot, runtime);
      const started = yield* ensureDaemon({
        host: options.host,
        port: Number.parseInt(options.port, 10),
        ...(options.authToken !== undefined ? { authToken: options.authToken } : {}),
        portless: options.portless,
        ...(options.drainGrace !== undefined || runtime.env.ROUTEKIT_DRAIN_GRACE !== undefined
          ? { drainGraceMs: drainGraceMs(options.drainGrace, runtime.env) }
          : {})
      });
      const status = yield* started.client.call("daemon.status", {});
      const result = {
        alreadyRunning: started.start?.alreadyRunning ?? true,
        url: status.dataUrl,
        port: status.dataPort,
        pid: status.pid,
        workerPid: status.workerPid,
        hostPid: status.hostPid,
        version: status.packageVersion,
        supervisor: status.supervisor,
        logFile: daemonLogPath()
      };
      if (ctx.json) ctx.emit(result);
      else {
        ctx.presenter.success(
          `${result.alreadyRunning ? "RouteKit already running" : "RouteKit started"} at ${result.url}`
        );
        ctx.presenter.note(
          `host pid ${result.pid} · worker pid ${result.workerPid} · logs: ${result.logFile}`
        );
      }
    })
  ).pipe(Command.withDescription("start RouteKit"));

export const makeRestartCommand = (
  runtime: CliRuntime = processCliRuntime
): Command.Command.Any =>
  Command.make(
    "restart",
    {
      drainGrace: optionalString("drain-grace").pipe(
        Flag.withDescription(
          "grace for in-flight requests (default: $ROUTEKIT_DRAIN_GRACE or 30)"
        )
      )
    },
    ({ drainGrace }) =>
      Effect.gen(function* () {
        const ctx = contextForFlags(yield* routekitRoot, runtime);
        const initial = readDaemonRecord();
        if (initial === undefined) {
          return yield* Effect.fail(
            new CliError({
              message: "RouteKit daemon is not running",
              tryCommand: "routekit start"
            })
          );
        }
        const requestedGrace =
          drainGrace === undefined
            ? initial.drainGraceMs
            : drainGraceMs(drainGrace, runtime.env);
        if (
          drainGrace !== undefined &&
          requestedGrace !== undefined &&
          requestedGrace !== initial.drainGraceMs
        ) {
          return yield* Effect.fail(
            new CliError({
              message: "changing daemon drain grace requires a hard service reinstall",
              tryCommand: `routekit daemon service install --drain-grace ${drainGrace}`
            })
          );
        }
        const lock = yield* cliTryPromise(() => acquireLifecycleLock(daemonLifecycleLockPath()));
        const output = yield* Effect.gen(function* () {
          const record = yield* cliTry(() => {
            const current = readDaemonRecord();
            if (current === undefined) throw new Error("RouteKit daemon stopped during restart");
            return current;
          });
          if (
            (record.hostProtocolVersion ?? 0) >= 1 &&
            record.workerPid !== undefined &&
            record.generation !== undefined
          ) {
            const result = yield* controlClientForRecord(record).call(
              "daemon.roll",
              { reason: "restart", expectedGeneration: record.generation },
              { idempotencyKey: `restart-${record.generation}` }
            );
            const rolled = yield* cliTryPromise(() =>
              waitForRolledRecord({
                hostPid: record.pid,
                previousWorkerPid: record.workerPid!,
                generation: result.generation,
                dataUrl: record.dataUrl
              })
            );
            return {
              restarted: true,
              rolling: true,
              url: rolled.dataUrl,
              pid: result.workerPid,
              hostPid: rolled.pid,
              previousWorkerPid: result.previousWorkerPid,
              workerPid: result.workerPid,
              generation: result.generation
            };
          }

          let restarted;
          if (record.supervisor === "systemd" || record.supervisor === "launchd") {
            const timeoutMs = supervisorOperationTimeoutMs(record.drainGraceMs);
            yield* cliTryPromise(() =>
              daemonSupervisorController(record.supervisor as "systemd" | "launchd").restart({
                timeoutMs
              })
            );
            const supervisedRecord = yield* waitForServiceReadyEffect({
              home: routekitHome(),
              product: "routekit",
              kind: "daemon",
              previousPid: record.pid,
              timeoutMs,
              logFile: daemonLogPath(),
              ready: daemonRecordHealthy
            });
            restarted = {
              record: supervisedRecord,
              client: controlClientForRecord(supervisedRecord)
            };
          } else {
            yield* controlClientForRecord(record).call(
              "daemon.prepareShutdown",
              { reason: "restart" },
              { idempotencyKey: `restart-${record.generation ?? record.pid}` }
            );
            const drained = yield* cliTryPromise(() =>
              waitForProcessExit(
                record.pid,
                supervisorOperationTimeoutMs(record.drainGraceMs),
                record.processIdentity
              )
            );
            if (!drained) {
              return yield* new RouteKitFailure({
                message: `RouteKit daemon pid ${record.pid} did not drain`
              });
            }
            restarted = yield* ensureDaemon({
              ...(record.host !== undefined ? { host: record.host } : {}),
              port: record.dataPort ?? 8080,
              ...(record.portless !== undefined ? { portless: record.portless } : {}),
              ...(requestedGrace !== undefined ? { drainGraceMs: requestedGrace } : {}),
              lifecycleLockHeld: true
            });
          }
          const status = yield* restarted.client.call("daemon.status", {});
          return {
            restarted: true,
            rolling: false,
            url: status.dataUrl,
            pid: status.workerPid,
            hostPid: status.hostPid,
            previousWorkerPid: record.workerPid ?? record.pid,
            workerPid: status.workerPid,
            generation: status.generation
          };
        }).pipe(Effect.ensuring(Effect.sync(() => lock.release())));
        if (ctx.json) ctx.emit(output);
        else if (output.rolling) {
          ctx.presenter.success(`RouteKit daemon worker restarted at ${output.url}`);
          ctx.presenter.note(
            `host pid ${output.hostPid} · worker ${output.previousWorkerPid} → ${output.workerPid}`
          );
        } else ctx.presenter.success(`RouteKit daemon restarted at ${output.url}`);
      })
  ).pipe(
    Command.withDescription("roll the singleton daemon worker without interrupting the gateway")
  );
