import {
  type CliRuntime,
  contextForFlags,
  processCliRuntime
} from "@velum-labs/routekit-cli-core";
import { randomId } from "@velum-labs/routekit-runtime/timing";
import type { TelemetryCategory, TelemetryStatus } from "@velum-labs/routekit-telemetry-core";
import { Effect } from "effect";
import { Argument, Command } from "effect/unstable/cli";

import { withCliClient } from "../../cli-client.js";
import { routekitRoot } from "../root-command.js";

const renderStatus = (
  result: TelemetryStatus,
  runtime: CliRuntime
) =>
  Effect.gen(function* () {
    const ctx = contextForFlags(yield* routekitRoot, runtime);
    if (ctx.json) {
      ctx.emit(result);
      return;
    }
    ctx.presenter.status(
      result.enabled ? "ok" : "pending",
      "telemetry",
      `${result.enabled ? "on" : "off"} (${result.source})`
    );
    for (const [category, enabled] of Object.entries(result.categories)) {
      ctx.presenter.status(enabled ? "ok" : "pending", category, enabled ? "on" : "off");
    }
    ctx.presenter.status(
      result.destination.configured ? "ok" : "pending",
      "project token",
      result.destination.configured ? "configured" : "not configured"
    );
    ctx.presenter.status(
      "ok",
      "destination",
      `${result.destination.provider} ${result.destination.host}`
    );
  });

const status = (runtime: CliRuntime) =>
  Effect.gen(function* () {
    const result = yield* withCliClient((client) => client.call("telemetry.get", {}));
    yield* renderStatus(result, runtime);
  });

const mutate = (
  params: { enabled?: boolean; category?: TelemetryCategory; categoryEnabled?: boolean },
  key: string,
  runtime: CliRuntime
) =>
  Effect.gen(function* () {
    const result = yield* withCliClient((client) =>
      client.call("telemetry.set", params, {
        idempotencyKey: `${key}-${randomId(16)}`
      })
    );
    yield* renderStatus(result, runtime);
  });

export const makeTelemetryCommand = (
  runtime: CliRuntime = processCliRuntime
): Command.Command.Any => {
  const statusCommand = Command.make("status", {}, () => status(runtime));
  const on = Command.make("on", {}, () => mutate({ enabled: true }, "telemetry-on", runtime));
  const off = Command.make("off", {}, () =>
    mutate({ enabled: false }, "telemetry-off", runtime)
  );
  const category = Command.make(
    "category",
    {
      category: Argument.choice("category", ["usage", "reliability", "adoption"] as const),
      state: Argument.choice("state", ["on", "off"] as const)
    },
    ({ category, state }) =>
      mutate(
        { category, categoryEnabled: state === "on" },
        `telemetry-${category}-${state}`,
        runtime
      )
  ).pipe(Command.withDescription("enable or disable a telemetry category"));
  const schema = Command.make("schema", {}, () =>
    Effect.gen(function* () {
      const ctx = contextForFlags(yield* routekitRoot, runtime);
      const result = yield* withCliClient((client) => client.call("telemetry.schema", {}));
      if (ctx.json) ctx.emit(result);
      else runtime.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    })
  ).pipe(Command.withDescription("show the exact telemetry event inventory"));
  const reset = Command.make("reset", {}, () =>
    Effect.gen(function* () {
      const ctx = contextForFlags(yield* routekitRoot, runtime);
      const result = yield* withCliClient((client) =>
        client.call(
          "telemetry.resetIdentity",
          {},
          { idempotencyKey: `telemetry-reset-${randomId(16)}` }
        )
      );
      if (ctx.json) ctx.emit(result);
      else {
        ctx.presenter.success(
          result.installIdPresent
            ? "anonymous install identity reset"
            : "telemetry is disabled; no anonymous install identity is stored"
        );
      }
    })
  ).pipe(Command.withDescription("rotate the anonymous install identity"));

  return Command.make("telemetry", {}, () => status(runtime)).pipe(
    Command.withDescription("inspect and control anonymous telemetry"),
    Command.withSubcommands([statusCommand, on, off, category, schema, reset])
  );
};
