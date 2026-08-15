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
  waitForServiceReadyEffect
} from "@velum-labs/routekit-runtime";
import { RouteKitFailure } from "@velum-labs/routekit-runtime/effect";
import type { Command } from "commander";
import { Effect } from "effect";
import { cliTry, cliTryPromise, runCliEffect } from "../cli-session.js";
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
      try {
        const output = await runCliEffect(
          Effect.gen(function* () {
            if (
              (record.hostProtocolVersion ?? 0) >= 1 &&
              record.workerPid !== undefined &&
              record.generation !== undefined
            ) {
              if (currentBin === undefined) {
                return yield* new RouteKitFailure({
                  message: "installed RouteKit entrypoint is unavailable"
                });
              }
              const result = yield* controlClientForRecord(record).call(
                "daemon.roll",
                {
                  reason: "upgrade",
                  expectedGeneration: record.generation,
                  candidate: { binPath: currentBin, expectedVersion: version }
                },
                { idempotencyKey: `upgrade-${record.generation}-${version}` }
              );
              const committed = yield* cliTry(() => {
                const next = readDaemonRecord();
                if (
                  next === undefined ||
                  next.pid !== record.pid ||
                  next.dataUrl !== record.dataUrl ||
                  next.generation !== result.generation ||
                  next.workerPid !== result.workerPid ||
                  next.version !== version
                ) {
                  throw new Error(
                    "RouteKit daemon upgrade did not publish the expected worker generation"
                  );
                }
                return next;
              });
              return {
                action: "rolling-upgrade" as const,
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
            }
            let replacement;
            if (record.supervisor === "systemd" || record.supervisor === "launchd") {
              const timeoutMs = supervisorOperationTimeoutMs(requestedGrace);
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
              replacement = {
                record: supervisedRecord,
                client: controlClientForRecord(supervisedRecord)
              };
            } else {
              yield* controlClientForRecord(record).call(
                "daemon.prepareShutdown",
                { reason: "upgrade" },
                { idempotencyKey: `upgrade-${record.generation ?? record.pid}` }
              );
              const drained = yield* cliTryPromise(() =>
                waitForProcessExit(
                  record.pid,
                  supervisorOperationTimeoutMs(requestedGrace),
                  record.processIdentity
                )
              );
              if (!drained) {
                return yield* new RouteKitFailure({
                  message: `RouteKit daemon pid ${record.pid} did not drain`
                });
              }
              replacement = yield* ensureDaemon({
                ...(record.host !== undefined ? { host: record.host } : {}),
                port: record.dataPort ?? 8080,
                ...(record.portless !== undefined ? { portless: record.portless } : {}),
                ...(requestedGrace !== undefined ? { drainGraceMs: requestedGrace } : {}),
                lifecycleLockHeld: true
              });
            }
            const status = yield* replacement.client.call("daemon.status", {});
            return {
              action:
                record.supervisor === "systemd" || record.supervisor === "launchd"
                  ? ("supervisor-restart" as const)
                  : ("drain-restart" as const),
              url: status.dataUrl,
              pid: status.pid,
              previousPid: record.pid,
              from: record.version,
              to: status.packageVersion
            };
          })
        );
        if (ctx.json) {
          ctx.emit(output);
          return;
        }
        if (output.action === "rolling-upgrade") {
          ctx.presenter.success(`RouteKit daemon upgraded to v${output.to} (rolling-upgrade)`);
          ctx.presenter.note(
            `host pid ${output.hostPid} · worker ${output.previousWorkerPid} → ${output.workerPid} · url ${output.url}`
          );
          return;
        }
        ctx.presenter.success(`RouteKit daemon upgraded to v${output.to} (${output.action})`);
        ctx.presenter.note(`pid ${output.pid} · url ${output.url}`);
      } finally {
        lock.release();
      }
    });
}
