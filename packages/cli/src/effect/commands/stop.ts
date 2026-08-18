import {
  type CliRuntime,
  contextForFlags,
  processCliRuntime
} from "@velum-labs/routekit-cli-core";
import {
  acquireLifecycleLock,
  processAlive,
  stopDaemonProcess,
  supervisorController,
  supervisorOperationTimeoutMs,
  waitForProcessExit
} from "@velum-labs/routekit-runtime/service";
import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";

import { cliTryPromise } from "../../cli-session.js";
import { controlClientForRecord, daemonLifecycleLockPath, readDaemonRecord } from "../../client.js";
import { routekitRoot } from "../root-command.js";

export const makeStopCommand = (
  runtime: CliRuntime = processCliRuntime
): Command.Command.Any =>
  Command.make(
    "stop",
    {
      force: Flag.boolean("force").pipe(
        Flag.withDescription("SIGKILL a detached daemon if its control plane cannot drain")
      )
    },
    ({ force }) =>
      Effect.gen(function* () {
        const ctx = contextForFlags(yield* routekitRoot, runtime);
        const lock = yield* cliTryPromise(() => acquireLifecycleLock(daemonLifecycleLockPath()));
        yield* Effect.gen(function* () {
          const record = readDaemonRecord();
          if (record === undefined) {
            if (ctx.json) ctx.emit({ stopped: false });
            else ctx.presenter.note("RouteKit is not running");
            return;
          }
          let requested = false;
          if (record.supervisor === "systemd" || record.supervisor === "launchd") {
            yield* cliTryPromise(() =>
              supervisorController(record.supervisor as "systemd" | "launchd", "routekit", "daemon").stop({
                timeoutMs: supervisorOperationTimeoutMs(record.drainGraceMs)
              })
            );
            requested = true;
          } else {
            const request = yield* controlClientForRecord(record)
              .call(
                "daemon.prepareShutdown",
                { reason: "stop" },
                { idempotencyKey: `stop-${record.generation ?? record.pid}` }
              )
              .pipe(Effect.result);
            if (request._tag === "Success") requested = true;
            else if (!force) return yield* Effect.fail(request.failure);
          }
          let stopped = yield* cliTryPromise(() =>
            waitForProcessExit(
              record.pid,
              supervisorOperationTimeoutMs(record.drainGraceMs),
              record.processIdentity
            )
          );
          if (!stopped && force) {
            yield* cliTryPromise(() => stopDaemonProcess(record, { graceMs: 0 }));
            stopped = !processAlive(record.pid);
          }
          if (!stopped) {
            return yield* Effect.fail(
              new Error(`RouteKit daemon pid ${record.pid} did not stop`)
            );
          }
          if (ctx.json) ctx.emit({ stopped: true, requested, pid: record.pid });
          else ctx.presenter.success("stopped RouteKit");
        }).pipe(Effect.ensuring(Effect.sync(() => lock.release())));
      })
  ).pipe(Command.withDescription("gracefully stop RouteKit"));
