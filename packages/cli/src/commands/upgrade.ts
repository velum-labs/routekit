import {
  CliError,
  type CliRuntime,
  contextFor,
  processCliRuntime
} from "@velum-labs/routekit-cli-core";
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
import { routekitVersion } from "../state.js";
import { daemonSupervisorController } from "./gateway-service.js";
import { drainGraceMs } from "./serve-options.js";

/**
 * Rebuild the recorded serve argv with a different `--port` value: a
 * blue-green replacement must bind a fresh ephemeral port (0) while the
 * stable route is re-pointed to it.
 */
export function argsWithPort(args: readonly string[], port: string): string[] {
  const rebuilt = [...args];
  const index = rebuilt.indexOf("--port");
  if (index >= 0 && index + 1 < rebuilt.length) rebuilt[index + 1] = port;
  else rebuilt.push("--port", port);
  return rebuilt;
}

export function registerUpgrade(program: Command, runtime: CliRuntime = processCliRuntime): void {
  program
    .command("upgrade")
    .description("upgrade the running daemon to the installed CLI version")
    .option("--force", "restart even when versions already match (e.g. after a config change)")
    .option(
      "--drain-grace <seconds>",
      "grace for in-flight requests (default: $ROUTEKIT_DRAIN_GRACE or 30)"
    )
    .action(async (options: { force?: boolean; drainGrace?: string }, command: Command) => {
      const ctx = contextFor(command, runtime);
      const version = routekitVersion();
      const record = readDaemonRecord();
      const requestedGrace =
        options.drainGrace === undefined
          ? record?.drainGraceMs
          : drainGraceMs(options.drainGrace, runtime.env);
      if (record === undefined) {
        throw new CliError({
          message: "RouteKit daemon is not running",
          tryCommand: "routekit start"
        });
      }
      if (
        options.drainGrace !== undefined &&
        (record.supervisor === "systemd" || record.supervisor === "launchd")
      ) {
        throw new CliError({
          message: "changing drain grace for a supervised daemon requires reinstalling its unit",
          tryCommand: `routekit daemon service install --drain-grace ${options.drainGrace}`
        });
      }
      if (record.version === version && options.force !== true) {
        if (ctx.json) ctx.emit({ action: "up-to-date", version, pid: record?.pid });
        else ctx.presenter.success(`RouteKit daemon is already running v${version}`);
        return;
      }
      const currentBin = process.argv[1];
      if (
        record.binPath !== undefined &&
        currentBin !== undefined &&
        record.binPath !== currentBin &&
        (record.supervisor === "systemd" || record.supervisor === "launchd")
      ) {
        throw new CliError({
          message: `the installed CLI (${currentBin}) is not the binary the daemon unit runs (${record.binPath})`,
          hint: "re-run `routekit daemon service install` to rewrite the unit"
        });
      }
      const lock = await acquireLifecycleLock(daemonLifecycleLockPath());
      let replacement;
      try {
        if (
          (record.hostProtocolVersion ?? 0) >= 1 &&
          record.workerPid !== undefined &&
          record.generation !== undefined
        ) {
          if (currentBin === undefined)
            throw new Error("installed RouteKit entrypoint is unavailable");
          const result = await controlClientForRecord(record).call(
            "daemon.roll",
            {
              reason: "upgrade",
              expectedGeneration: record.generation,
              candidate: { binPath: currentBin, expectedVersion: version }
            },
            { idempotencyKey: `upgrade-${record.generation}-${version}` }
          );
          const committed = readDaemonRecord();
          if (
            committed === undefined ||
            committed.pid !== record.pid ||
            committed.dataUrl !== record.dataUrl ||
            committed.generation !== result.generation ||
            committed.workerPid !== result.workerPid ||
            committed.version !== version
          ) {
            throw new Error(
              "RouteKit daemon upgrade did not publish the expected worker generation"
            );
          }
          const output = {
            action: "rolling-upgrade",
            url: committed.dataUrl,
            pid: result.workerPid,
            hostPid: committed.pid,
            previousPid: result.previousWorkerPid,
            previousWorkerPid: result.previousWorkerPid,
            workerPid: result.workerPid,
            generation: result.generation,
            from: record.version,
            to: result.packageVersion
          };
          if (ctx.json) ctx.emit(output);
          else {
            ctx.presenter.success(
              `RouteKit daemon upgraded to v${result.packageVersion} (rolling-upgrade)`
            );
            ctx.presenter.note(
              `host pid ${committed.pid} · worker ${result.previousWorkerPid} → ${result.workerPid} · url ${committed.dataUrl}`
            );
          }
          return;
        }
        if (record.supervisor === "systemd" || record.supervisor === "launchd") {
          const timeoutMs = supervisorOperationTimeoutMs(requestedGrace);
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
          replacement = {
            record: supervisedRecord,
            client: controlClientForRecord(supervisedRecord)
          };
        } else {
          await controlClientForRecord(record).call(
            "daemon.prepareShutdown",
            { reason: "upgrade" },
            { idempotencyKey: `upgrade-${record.generation ?? record.pid}` }
          );
          if (
            !(await waitForProcessExit(
              record.pid,
              supervisorOperationTimeoutMs(requestedGrace),
              record.processIdentity
            ))
          ) {
            throw new Error(`RouteKit daemon pid ${record.pid} did not drain`);
          }
          replacement = await ensureDaemon({
            ...(record.host !== undefined ? { host: record.host } : {}),
            port: record.dataPort ?? 8080,
            ...(record.portless !== undefined ? { portless: record.portless } : {}),
            ...(requestedGrace !== undefined ? { drainGraceMs: requestedGrace } : {}),
            lifecycleLockHeld: true
          });
        }
      } finally {
        lock.release();
      }
      if (replacement === undefined)
        throw new Error("RouteKit daemon upgrade did not produce a successor");
      const status = await replacement.client.call("daemon.status", {});
      const result = {
        action:
          record.supervisor === "systemd" || record.supervisor === "launchd"
            ? "supervisor-restart"
            : "drain-restart",
        url: status.dataUrl,
        pid: status.pid,
        previousPid: record.pid,
        from: record.version,
        to: status.packageVersion
      };
      if (ctx.json) {
        ctx.emit(result);
        return;
      }
      ctx.presenter.success(
        `RouteKit daemon upgraded to v${status.packageVersion} (${result.action})`
      );
      ctx.presenter.note(`pid ${status.pid} · url ${status.dataUrl}`);
    });
}
