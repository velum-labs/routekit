import { createReadStream, statSync } from "node:fs";

import {
  CliError,
  type CliRuntime,
  contextForFlags,
  processCliRuntime
} from "@velum-labs/routekit-cli-core";
import type { SupervisorController } from "@velum-labs/routekit-runtime/service";
import {
  acquireLifecycleLock,
  detectSupervisor,
  readLogTail,
  supervisorController,
  supervisorOperationTimeoutMs,
  systemdUnitName,
  waitForProcessExitEffect,
  waitForServiceReadyEffect
} from "@velum-labs/routekit-runtime/service";
import { spawnTool } from "@velum-labs/routekit-runtime/process";
import { RouteKitFailure } from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";

import { cliTryPromise } from "../../cli-session.js";
import {
  controlClientForRecord,
  daemonLifecycleLockPath,
  daemonLogPath,
  daemonRecordHealthy,
  daemonServeArgs,
  ensureDaemon,
  ensureDaemonDataToken,
  readDaemonRecord
} from "../../client.js";
import { globalRouterConfigPath, loadRouterConfig, routekitHome } from "../../config.js";
import {
  daemonUnitSpec,
  missingServiceCredentialVariables,
  ROUTEKIT_PRODUCT,
  removeServiceEnvFile,
  serviceEnvironment
} from "../../daemon.js";
import { routekitRoot } from "../root-command.js";
import { gatewayServeFlags } from "./start.js";
import { drainGraceMs } from "../../commands/serve-options.js";

export function daemonSupervisorController(kind: "systemd" | "launchd"): SupervisorController {
  return supervisorController(kind, ROUTEKIT_PRODUCT, "daemon");
}

export async function platformSupervisor(): Promise<SupervisorController | undefined> {
  return await detectSupervisor(ROUTEKIT_PRODUCT, "daemon");
}

const makeInstallCommand = (runtime: CliRuntime): Command.Command.Any =>
  Command.make("install", gatewayServeFlags, (options) =>
    Effect.gen(function* () {
      const ctx = contextForFlags(yield* routekitRoot, runtime);
      const configPath = globalRouterConfigPath();
      const result = loadRouterConfig({ configPath });
      const missingCredentials = missingServiceCredentialVariables(result.config);
      if (missingCredentials.length > 0) {
        return yield* Effect.fail(
          new CliError({
            message:
              `cannot install the RouteKit daemon: set ` +
              `${missingCredentials.join(" or ")} for the configured provider`
          })
        );
      }
      const graceMs = drainGraceMs(options.drainGrace, runtime.env);
      const authTokenFile = ensureDaemonDataToken(options.authToken);
      const serveArgs = daemonServeArgs({
        configPath,
        host: options.host,
        port: Number.parseInt(options.port, 10),
        authTokenFile,
        portless: options.portless,
        drainGraceMs: graceMs
      });
      const controller = yield* cliTryPromise(() => platformSupervisor());
      const outcome =
        controller === undefined
          ? yield* Effect.gen(function* () {
              const started = yield* ensureDaemon({
                configPath,
                port: Number.parseInt(options.port, 10),
                ...(options.authToken !== undefined ? { authToken: options.authToken } : {}),
                portless: options.portless,
                drainGraceMs: graceMs
              });
              const status = yield* started.client.call("daemon.status", {});
              return { kind: "detached" as const, status };
            })
          : yield* Effect.gen(function* () {
              const lock = yield* cliTryPromise(() =>
                acquireLifecycleLock(daemonLifecycleLockPath(), {
                  timeoutMs: supervisorOperationTimeoutMs(graceMs)
                })
              );
              return yield* Effect.gen(function* () {
                const previous = readDaemonRecord();
                if (previous !== undefined && previous.supervisor === "detached") {
                  yield* controlClientForRecord(previous).call(
                    "daemon.prepareShutdown",
                    { reason: "restart" },
                    { idempotencyKey: `service-install-${previous.generation ?? previous.pid}` }
                  );
                  const drained = yield* waitForProcessExitEffect(
                    previous.pid,
                    supervisorOperationTimeoutMs(previous.drainGraceMs),
                    previous.processIdentity
                  );
                  if (!drained) {
                    return yield* new RouteKitFailure({
                      message: `RouteKit daemon pid ${previous.pid} did not drain`
                    });
                  }
                }
                const spec = daemonUnitSpec({
                  args: serveArgs,
                  supervisor: controller.kind,
                  env: serviceEnvironment(result.config),
                  drainGraceMs: graceMs
                });
                yield* cliTryPromise(() => controller.install(spec));
                const record = yield* waitForServiceReadyEffect({
                  home: routekitHome(),
                  product: ROUTEKIT_PRODUCT,
                  kind: "daemon",
                  timeoutMs: supervisorOperationTimeoutMs(graceMs),
                  ...(previous !== undefined ? { previousPid: previous.pid } : {}),
                  logFile: daemonLogPath(),
                  ready: daemonRecordHealthy
                });
                return { kind: "installed" as const, controller, record };
              }).pipe(Effect.ensuring(Effect.sync(() => lock.release())));
            });
      if (outcome.kind === "detached") {
        ctx.presenter.warn(
          "no OS supervisor is available; starting a detached daemon instead " +
            "(it will not restart after a crash or reboot)"
        );
        if (ctx.json) ctx.emit({ installed: false, fallback: "detached", ...outcome.status });
        else ctx.presenter.success(`RouteKit daemon started at ${outcome.status.dataUrl}`);
        return;
      }
      if (ctx.json) {
        ctx.emit({
          installed: true,
          supervisor: outcome.controller.kind,
          unit: outcome.controller.unitName,
          unitPath: outcome.controller.unitPath,
          url: outcome.record.dataUrl,
          pid: outcome.record.pid,
          version: outcome.record.version
        });
        return;
      }
      ctx.presenter.success(
        `RouteKit daemon installed as ${outcome.controller.unitName} (${outcome.controller.kind})`
      );
      ctx.presenter.line(`  listening at ${outcome.record.dataUrl} (pid ${outcome.record.pid})`);
      ctx.presenter.note(
        outcome.controller.kind === "systemd"
          ? `logs: journalctl --user -u ${outcome.controller.unitName} (or \`routekit daemon logs\`)`
          : `logs: ${daemonLogPath()} (or \`routekit daemon logs\`)`
      );
    })
  ).pipe(Command.withDescription("install the daemon as an OS-supervised service (systemd/launchd)"));

const makeUninstallCommand = (runtime: CliRuntime): Command.Command.Any =>
  Command.make("uninstall", {}, () =>
    Effect.gen(function* () {
      const ctx = contextForFlags(yield* routekitRoot, runtime);
      const lock = yield* cliTryPromise(() => acquireLifecycleLock(daemonLifecycleLockPath()));
      const { removed, stopped, pid } = yield* Effect.gen(function* () {
        const record = readDaemonRecord();
        const kind =
          record?.supervisor === "systemd" || record?.supervisor === "launchd"
            ? record.supervisor
            : undefined;
        const controller =
          kind !== undefined
            ? daemonSupervisorController(kind)
            : yield* cliTryPromise(() => platformSupervisor());
        let removed = false;
        let stopped = false;
        if (controller !== undefined) {
          removed = yield* cliTryPromise(() =>
            controller.uninstall({
              timeoutMs: supervisorOperationTimeoutMs(record?.drainGraceMs)
            })
          );
          if (
            removed &&
            record !== undefined &&
            (record.supervisor === "systemd" || record.supervisor === "launchd")
          ) {
            stopped = yield* waitForProcessExitEffect(
              record.pid,
              supervisorOperationTimeoutMs(record.drainGraceMs),
              record.processIdentity
            );
            if (!stopped) {
              return yield* new RouteKitFailure({
                message: `RouteKit daemon pid ${record.pid} did not stop`
              });
            }
          }
        }
        if (record !== undefined && record.supervisor === "detached") {
          yield* controlClientForRecord(record).call(
            "daemon.prepareShutdown",
            { reason: "stop" },
            { idempotencyKey: `service-uninstall-${record.generation ?? record.pid}` }
          );
          stopped = yield* waitForProcessExitEffect(
            record.pid,
            supervisorOperationTimeoutMs(record.drainGraceMs),
            record.processIdentity
          );
          if (!stopped) {
            return yield* new RouteKitFailure({
              message: `RouteKit daemon pid ${record.pid} did not stop`
            });
          }
        }
        if (removed || stopped) removeServiceEnvFile("daemon");
        return { removed, stopped, pid: record?.pid };
      }).pipe(Effect.ensuring(Effect.sync(() => lock.release())));
      if (ctx.json) {
        ctx.emit({ uninstalled: removed, service: { stopped, pid } });
        return;
      }
      if (removed) ctx.presenter.success("removed the RouteKit daemon service");
      else if (stopped) ctx.presenter.success("stopped the RouteKit daemon");
      else ctx.presenter.note("no RouteKit daemon service is installed");
    })
  ).pipe(Command.withDescription("stop the supervised daemon and remove its unit"));

const makeServiceStatusCommand = (runtime: CliRuntime): Command.Command.Any =>
  Command.make("status", {}, () =>
    Effect.gen(function* () {
      const ctx = contextForFlags(yield* routekitRoot, runtime);
      const record = readDaemonRecord();
      const kind =
        record?.supervisor === "systemd" || record?.supervisor === "launchd"
          ? record.supervisor
          : undefined;
      const controller =
        kind !== undefined
          ? daemonSupervisorController(kind)
          : yield* cliTryPromise(() => platformSupervisor());
      const status =
        controller === undefined ? undefined : yield* cliTryPromise(() => controller.status());
      const healthy = record !== undefined ? yield* daemonRecordHealthy(record) : false;
      if (ctx.json) {
        const publicRecord =
          record === undefined
            ? undefined
            : {
                product: record.product,
                kind: record.kind,
                pid: record.pid,
                dataUrl: record.dataUrl,
                dataPort: record.dataPort,
                startedAt: record.startedAt,
                version: record.version,
                protocolVersion: record.protocolVersion,
                generation: record.generation,
                supervisor: record.supervisor
              };
        ctx.emit({
          supervisor: controller?.kind,
          unit: controller?.unitName,
          unitPath: controller?.unitPath,
          installed: status?.installed ?? false,
          active: status?.active ?? false,
          healthy,
          record: publicRecord
        });
        return;
      }
      if (controller === undefined) {
        ctx.presenter.note("no OS supervisor is available on this system");
      } else {
        ctx.presenter.line(
          `${controller.unitName} (${controller.kind}): ` +
            `${status?.installed === true ? "installed" : "not installed"}, ` +
            `${status?.active === true ? "active" : "inactive"}`
        );
      }
      if (record !== undefined) {
        ctx.presenter.line(
          `daemon ${healthy ? "running" : "unhealthy"} at ${record.dataUrl ?? record.url} (pid ${record.pid}` +
            `${record.version !== undefined ? `, v${record.version}` : ""}` +
            `, ${record.supervisor ?? "detached"})`
        );
      } else {
        ctx.presenter.line("daemon is not running");
      }
    })
  ).pipe(Command.withDescription("show the OS supervisor state of the daemon"));

export const makeDaemonServiceCommand = (
  runtime: CliRuntime = processCliRuntime
): Command.Command.Any =>
  Command.make("service").pipe(
    Command.withDescription("manage the singleton daemon as a persistent OS service"),
    Command.withSubcommands([
      makeInstallCommand(runtime),
      makeUninstallCommand(runtime),
      makeServiceStatusCommand(runtime)
    ])
  );

function readAppendedLog(path: string, offset: number, size: number): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    createReadStream(path, { start: offset, end: size - 1, encoding: "utf8" })
      .on("data", (part: string | Buffer) => (data += part.toString()))
      .on("end", () => resolve(data))
      .on("error", () => resolve(data));
  });
}

export const makeLogsCommand = (
  runtime: CliRuntime = processCliRuntime
): Command.Command.Any =>
  Command.make(
    "logs",
    {
      lines: Flag.integer("lines").pipe(
        Flag.withAlias("n"),
        Flag.withDefault(50),
        Flag.withDescription("number of trailing lines")
      ),
      follow: Flag.boolean("follow").pipe(
        Flag.withAlias("f"),
        Flag.withDescription("keep printing new log lines")
      )
    },
    ({ follow, lines }) =>
      Effect.gen(function* () {
        const ctx = contextForFlags(yield* routekitRoot, runtime);
        if (ctx.json) {
          return yield* Effect.fail(
            new CliError({
              message: "`daemon logs` is a live human view and cannot be combined with --json"
            })
          );
        }
        if (lines <= 0) {
          return yield* Effect.fail(new CliError({ message: "--lines must be a positive integer" }));
        }
        const record = readDaemonRecord();
        if (record?.supervisor === "systemd") {
          const args = [
            "--user",
            "-u",
            systemdUnitName(ROUTEKIT_PRODUCT, "daemon"),
            "-n",
            String(lines)
          ];
          if (follow) args.push("-f");
          process.exitCode = yield* cliTryPromise(() => spawnTool("journalctl", args, {}));
          return;
        }
        const path = daemonLogPath();
        const tail = readLogTail(path);
        if (tail.length === 0) {
          ctx.presenter.note(`no logs at ${path}`);
          if (!follow) return;
        }
        const trailing = tail
          .split("\n")
          .filter((line) => line.length > 0)
          .slice(-lines);
        if (trailing.length > 0) runtime.stdout.write(`${trailing.join("\n")}\n`);
        if (!follow) return;
        let offset = (() => {
          try {
            return statSync(path).size;
          } catch {
            return 0;
          }
        })();
        yield* Effect.forever(
          Effect.gen(function* () {
            yield* Effect.sleep("500 millis");
            let size: number;
            try {
              size = statSync(path).size;
            } catch {
              return;
            }
            if (size < offset) offset = 0;
            if (size === offset) return;
            const chunk = yield* cliTryPromise(() => readAppendedLog(path, offset, size));
            offset = size;
            runtime.stdout.write(chunk);
          })
        );
      })
  ).pipe(Command.withDescription("show the singleton daemon logs"));
