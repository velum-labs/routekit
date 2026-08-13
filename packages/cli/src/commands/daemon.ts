import { readFileSync } from "node:fs";

import {
  type CliRuntime,
  contextFor,
  parsePort,
  processCliRuntime
} from "@velum-labs/routekit-cli-core";
import {
  ROUTEKIT_DAEMON_WORKER_ENV,
  runRouteKitDaemonWorker,
  startRouteKitDaemonHost
} from "@velum-labs/routekit-daemon";
import { sanitizeServiceEnvironment } from "@velum-labs/routekit-runtime";
import { Command } from "commander";
import { runCliEffect } from "../cli-session.js";
import { daemonDataTokenPath, ensureDaemon } from "../client.js";
import { readControlRelayStdin, relayLocalControl } from "../control-relay.js";
import { routekitVersion } from "../state.js";
import { registerDaemonService, registerLogs } from "./gateway-service.js";
import { registerRestart } from "./start.js";
import { registerUpgrade } from "./upgrade.js";

function registerRun(group: Command, runtime: CliRuntime): void {
  const run = new Command("run")
    .description("run the singleton RouteKit daemon in the foreground (internal)")
    .requiredOption("--config-path <path>", "canonical global router config")
    .option("--host <host>", "data-plane bind host", "127.0.0.1")
    .option("--port <port>", "data-plane bind port", "8080")
    .option("--auth-token-file <path>", "private data-plane token file")
    .option("--no-portless", "disable the stable local route")
    .option("--drain-grace-ms <ms>", "in-flight drain grace in milliseconds", "30000")
    .action(
      async (
        options: {
          configPath: string;
          host: string;
          port: string;
          authTokenFile?: string;
          portless?: boolean;
          drainGraceMs: string;
        },
        command: Command
      ) => {
        sanitizeServiceEnvironment();
        const ctx = contextFor(command, runtime);
        const daemonOptions = {
          packageVersion: routekitVersion(),
          configPath: options.configPath,
          host: options.host,
          port: parsePort(options.port, 8080),
          ...(options.authTokenFile !== undefined ? { authTokenFile: options.authTokenFile } : {}),
          ...(options.portless !== undefined ? { portless: options.portless } : {}),
          drainGraceMs: Number.parseInt(options.drainGraceMs, 10)
        };
        if (runtime.env[ROUTEKIT_DAEMON_WORKER_ENV] === "1") {
          await runRouteKitDaemonWorker(daemonOptions);
          return;
        }
        const entryPath = process.argv[1];
        if (entryPath === undefined) throw new Error("RouteKit daemon entrypoint is unavailable");
        const running = await startRouteKitDaemonHost({ ...daemonOptions, entryPath });
        if (ctx.json) {
          ctx.emit({
            event: "listening",
            controlUrl: running.controlUrl,
            dataUrl: running.dataUrl,
            pid: running.record.pid,
            workerPid: running.record.workerPid,
            generation: running.record.generation
          });
        } else {
          ctx.presenter.success(`RouteKit daemon listening at ${running.dataUrl}`);
          ctx.presenter.note(
            `control: ${running.controlUrl} · host pid ${running.record.pid} · worker pid ${running.record.workerPid}`
          );
          ctx.presenter.note("Press Ctrl+C to stop.");
        }
        await new Promise<never>(() => undefined);
      }
    );
  group.addCommand(run, { hidden: true });
}

function registerReload(group: Command, runtime: CliRuntime): void {
  group
    .command("reload")
    .description("transactionally reload the canonical config and accounts")
    .action(async (_options: unknown, command: Command) => {
      const ctx = contextFor(command, runtime);
      const { client } = await ensureDaemon();
      const result = await runCliEffect(
        client.call("daemon.reload", {}, { idempotencyKey: `reload-${Date.now()}` })
      );
      if (ctx.json) ctx.emit(result);
      else {
        ctx.presenter.success(
          `RouteKit daemon reloaded (config revision ${result.configRevision})`
        );
      }
    });
}

function registerAuth(group: Command, runtime: CliRuntime): void {
  const auth = group.command("auth").description("manage daemon data-plane authentication");
  auth
    .command("show")
    .description("explicitly print the private data-plane token")
    .action((_options: unknown, command: Command) => {
      const ctx = contextFor(command, runtime);
      const token = readFileSync(daemonDataTokenPath(), "utf8").trim();
      if (ctx.json) ctx.emit({ token });
      else runtime.stdout.write(`${token}\n`);
    });
}

function registerExec(group: Command, runtime: CliRuntime): void {
  group
    .command("exec", { hidden: true })
    .description("relay one control request to the loopback daemon (internal)")
    .action(async () => {
      const result = await relayLocalControl(await readControlRelayStdin());
      runtime.stdout.write(`${JSON.stringify(result)}\n`);
    });
}

export function registerDaemon(program: Command, runtime: CliRuntime = processCliRuntime): void {
  const group = new Command("daemon").description("manage the singleton RouteKit daemon");
  registerRun(group, runtime);
  registerExec(group, runtime);
  registerRestart(group, runtime);
  registerUpgrade(group, runtime);
  registerReload(group, runtime);
  registerAuth(group, runtime);
  registerLogs(group, runtime);
  registerDaemonService(group, runtime);
  program.addCommand(group, { hidden: true });
}
