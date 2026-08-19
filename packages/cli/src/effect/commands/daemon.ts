import { readFileSync } from "node:fs";

import {
  type CliRuntime,
  contextForFlags,
  parsePort,
  processCliRuntime
} from "@velum-labs/routekit-cli-core";
import {
  ROUTEKIT_DAEMON_WORKER_ENV,
  runRouteKitDaemonWorker,
  startRouteKitDaemonHost
} from "@velum-labs/routekit-daemon";
import { sanitizeServiceEnvironment } from "@velum-labs/routekit-runtime/environment";
import { Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";

import { readControlRelayStdin, relayLocalControl } from "../../adapters/control-relay.js";
import { cliFailure, cliTryPromise } from "../../cli-session.js";
import { daemonDataTokenPath, ensureDaemon } from "../../client.js";
import { routekitVersion } from "../../state.js";
import { routekitRoot } from "../root-command.js";
import { makeDaemonServiceCommand, makeLogsCommand } from "./daemon-service.js";
import { makeRestartCommand } from "./start.js";
import { makeUpgradeCommand } from "./upgrade.js";

const optionalString = (name: string) =>
  Flag.string(name).pipe(Flag.optional, Flag.map(Option.getOrUndefined));

const makeRunCommand = (runtime: CliRuntime): Command.Command.Any =>
  Command.make(
    "run",
    {
      configPath: Flag.string("config-path").pipe(
        Flag.withDescription("canonical global router config")
      ),
      host: Flag.string("host").pipe(
        Flag.withDefault("127.0.0.1"),
        Flag.withDescription("data-plane bind host")
      ),
      port: Flag.string("port").pipe(
        Flag.withDefault("8080"),
        Flag.withDescription("data-plane bind port")
      ),
      authTokenFile: optionalString("auth-token-file").pipe(
        Flag.withDescription("private data-plane token file")
      ),
      portless: Flag.boolean("no-portless").pipe(
        Flag.map((disabled) => !disabled),
        Flag.withDescription("disable the stable local route")
      ),
      drainGraceMs: Flag.string("drain-grace-ms").pipe(
        Flag.withDefault("30000"),
        Flag.withDescription("in-flight drain grace in milliseconds")
      )
    },
    (options) =>
      Effect.gen(function* () {
        sanitizeServiceEnvironment();
        const ctx = contextForFlags(yield* routekitRoot, runtime);
        const daemonOptions = {
          packageVersion: routekitVersion(),
          configPath: options.configPath,
          host: options.host,
          port: parsePort(options.port, 8080),
          ...(options.authTokenFile !== undefined ? { authTokenFile: options.authTokenFile } : {}),
          portless: options.portless,
          drainGraceMs: Number.parseInt(options.drainGraceMs, 10)
        };
        if (runtime.env[ROUTEKIT_DAEMON_WORKER_ENV] === "1") {
          return yield* cliTryPromise(() => runRouteKitDaemonWorker(daemonOptions));
        }
        const entryPath = process.argv[1];
        if (entryPath === undefined) {
          return yield* cliFailure("RouteKit daemon entrypoint is unavailable");
        }
        const running = yield* Effect.acquireRelease(
          cliTryPromise(() => startRouteKitDaemonHost({ ...daemonOptions, entryPath })),
          (application) => cliTryPromise(() => application.close()).pipe(Effect.orElseSucceed(() => undefined))
        );
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
        return yield* Effect.never;
      }).pipe(Effect.scoped)
  ).pipe(
    Command.withDescription("run the singleton RouteKit daemon in the foreground (internal)"),
    Command.unlisted
  );

const makeReloadCommand = (runtime: CliRuntime): Command.Command.Any =>
  Command.make("reload", {}, () =>
    Effect.gen(function* () {
      const ctx = contextForFlags(yield* routekitRoot, runtime);
      const { client } = yield* ensureDaemon();
      const result = yield* client.call(
        "daemon.reload",
        {},
        { idempotencyKey: `reload-${Date.now()}` }
      );
      if (ctx.json) ctx.emit(result);
      else {
        ctx.presenter.success(
          `RouteKit daemon reloaded (config revision ${result.configRevision})`
        );
      }
    })
  ).pipe(Command.withDescription("transactionally reload the canonical config and accounts"));

const makeAuthCommand = (runtime: CliRuntime): Command.Command.Any => {
  const show = Command.make("show", {}, () =>
    Effect.gen(function* () {
      const ctx = contextForFlags(yield* routekitRoot, runtime);
      const token = readFileSync(daemonDataTokenPath(), "utf8").trim();
      if (ctx.json) ctx.emit({ token });
      else runtime.stdout.write(`${token}\n`);
    })
  ).pipe(Command.withDescription("explicitly print the private data-plane token"));
  return Command.make("auth").pipe(
    Command.withDescription("manage daemon data-plane authentication"),
    Command.withSubcommands([show])
  );
};

const makeExecCommand = (runtime: CliRuntime): Command.Command.Any =>
  Command.make("exec", {}, () =>
    Effect.gen(function* () {
      const envelope = yield* cliTryPromise(() => readControlRelayStdin());
      const result = yield* relayLocalControl(envelope);
      runtime.stdout.write(`${JSON.stringify(result)}\n`);
    })
  ).pipe(
    Command.withDescription("relay one control request to the loopback daemon (internal)"),
    Command.unlisted
  );

export const makeDaemonCommand = (
  runtime: CliRuntime = processCliRuntime
): Command.Command.Any =>
  Command.make("daemon").pipe(
    Command.withDescription("manage the singleton RouteKit daemon"),
    Command.withSubcommands([
      makeRunCommand(runtime),
      makeExecCommand(runtime),
      makeRestartCommand(runtime),
      makeUpgradeCommand(runtime),
      makeReloadCommand(runtime),
      makeAuthCommand(runtime),
      makeLogsCommand(runtime),
      makeDaemonServiceCommand(runtime)
    ]),
    Command.unlisted
  );
