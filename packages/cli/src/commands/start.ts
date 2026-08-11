import {
  CliError,
  type CliRuntime,
  contextFor,
  processCliRuntime
} from "@velum-labs/routekit-cli-core";
import type { ServiceRecord } from "@velum-labs/routekit-runtime";
import {
  acquireLifecycleLock,
  supervisorOperationTimeoutMs,
  waitForProcessExit,
  waitForServiceReady
} from "@velum-labs/routekit-runtime";
import type { Command } from "commander";

import {
  controlClientForRecord,
  daemonLifecycleLockPath,
  daemonLogPath,
  daemonRecordHealthy,
  ensureDaemon,
  readDaemonRecord
} from "../client.js";
import { routekitHome } from "../config.js";
import { daemonSupervisorController } from "./gateway-service.js";
import type { GatewayServeCliOptions } from "./serve-options.js";
import { attachServeOptions, drainGraceMs } from "./serve-options.js";

async function waitForRolledRecord(input: {
  hostPid: number;
  previousWorkerPid: number;
  generation: number;
  dataUrl?: string;
  timeoutMs?: number;
}): Promise<ServiceRecord> {
  const deadline = Date.now() + (input.timeoutMs ?? 10_000);
  for (;;) {
    const record = readDaemonRecord();
    if (
      record !== undefined &&
      record.pid === input.hostPid &&
      record.workerPid !== undefined &&
      record.workerPid !== input.previousWorkerPid &&
      record.generation === input.generation &&
      (input.dataUrl === undefined || record.dataUrl === input.dataUrl)
    ) {
      return record;
    }
    if (Date.now() >= deadline) {
      throw new Error("RouteKit daemon roll did not publish the expected worker generation");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
}

export function registerStart(program: Command, runtime: CliRuntime = processCliRuntime): void {
  attachServeOptions(program.command("start").description("start RouteKit")).action(
    async (options: GatewayServeCliOptions, command: Command) => {
      const ctx = contextFor(command, runtime);
      const running = await ensureDaemon({
        host: options.host,
        port: Number.parseInt(options.port, 10),
        ...(options.authToken !== undefined ? { authToken: options.authToken } : {}),
        ...(options.portless !== undefined ? { portless: options.portless } : {}),
        ...(options.drainGrace !== undefined || runtime.env.ROUTEKIT_DRAIN_GRACE !== undefined
          ? { drainGraceMs: drainGraceMs(options.drainGrace, runtime.env) }
          : {})
      });
      const status = await running.client.call("daemon.status", {});
      const result = {
        alreadyRunning: running.start?.alreadyRunning ?? true,
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
    }
  );
}

export function registerRestart(program: Command, runtime: CliRuntime = processCliRuntime): void {
  program
    .command("restart")
    .description("roll the singleton daemon worker without interrupting the gateway")
    .option(
      "--drain-grace <seconds>",
      "grace for in-flight requests (default: $ROUTEKIT_DRAIN_GRACE or 30)"
    )
    .action(async (options: { drainGrace?: string }, command: Command) => {
      const ctx = contextFor(command, runtime);
      const initial = readDaemonRecord();
      if (initial === undefined) {
        throw new CliError({
          message: "RouteKit daemon is not running",
          tryCommand: "routekit start"
        });
      }
      const requestedGrace =
        options.drainGrace === undefined
          ? initial.drainGraceMs
          : drainGraceMs(options.drainGrace, runtime.env);
      if (
        options.drainGrace !== undefined &&
        requestedGrace !== undefined &&
        requestedGrace !== initial.drainGraceMs
      ) {
        throw new CliError({
          message: "changing daemon drain grace requires a hard service reinstall",
          tryCommand: `routekit daemon service install --drain-grace ${options.drainGrace}`
        });
      }
      const lock = await acquireLifecycleLock(daemonLifecycleLockPath());
      try {
        const record = readDaemonRecord();
        if (record === undefined) throw new Error("RouteKit daemon stopped during restart");
        if (
          (record.hostProtocolVersion ?? 0) >= 1 &&
          record.workerPid !== undefined &&
          record.generation !== undefined
        ) {
          const result = await controlClientForRecord(record).call(
            "daemon.roll",
            { reason: "restart", expectedGeneration: record.generation },
            { idempotencyKey: `restart-${record.generation}` }
          );
          const rolled = await waitForRolledRecord({
            hostPid: record.pid,
            previousWorkerPid: record.workerPid,
            generation: result.generation,
            dataUrl: record.dataUrl
          });
          const output = {
            restarted: true,
            rolling: true,
            url: rolled.dataUrl,
            pid: result.workerPid,
            hostPid: rolled.pid,
            previousWorkerPid: result.previousWorkerPid,
            workerPid: result.workerPid,
            generation: result.generation
          };
          if (ctx.json) ctx.emit(output);
          else {
            ctx.presenter.success(`RouteKit daemon worker restarted at ${rolled.dataUrl}`);
            ctx.presenter.note(
              `host pid ${rolled.pid} · worker ${result.previousWorkerPid} → ${result.workerPid}`
            );
          }
          return;
        }

        let restarted;
        if (record.supervisor === "systemd" || record.supervisor === "launchd") {
          const timeoutMs = supervisorOperationTimeoutMs(record.drainGraceMs);
          await daemonSupervisorController(record.supervisor).restart({ timeoutMs });
          const supervisedRecord = await waitForServiceReady({
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
          await controlClientForRecord(record).call(
            "daemon.prepareShutdown",
            { reason: "restart" },
            { idempotencyKey: `restart-${record.generation ?? record.pid}` }
          );
          if (
            !(await waitForProcessExit(
              record.pid,
              supervisorOperationTimeoutMs(record.drainGraceMs),
              record.processIdentity
            ))
          ) {
            throw new Error(`RouteKit daemon pid ${record.pid} did not drain`);
          }
          restarted = await ensureDaemon({
            ...(record.host !== undefined ? { host: record.host } : {}),
            port: record.dataPort ?? 8080,
            ...(record.portless !== undefined ? { portless: record.portless } : {}),
            ...(requestedGrace !== undefined ? { drainGraceMs: requestedGrace } : {}),
            lifecycleLockHeld: true
          });
        }
        const status = await restarted.client.call("daemon.status", {});
        const output = {
          restarted: true,
          rolling: false,
          url: status.dataUrl,
          pid: status.workerPid,
          hostPid: status.hostPid,
          previousWorkerPid: record.workerPid ?? record.pid,
          workerPid: status.workerPid,
          generation: status.generation
        };
        if (ctx.json) ctx.emit(output);
        else ctx.presenter.success(`RouteKit daemon restarted at ${status.dataUrl}`);
      } finally {
        lock.release();
      }
    });
}
