import { type CliRuntime, contextFor, processCliRuntime } from "@velum-labs/routekit-cli-core";
import { randomId } from "@velum-labs/routekit-runtime";
import type { TelemetryCategory, TelemetryStatus } from "@velum-labs/routekit-telemetry-core";
import type { Command } from "commander";
import { runCliClient } from "../cli-session.js";

function renderStatus(command: Command, result: TelemetryStatus, runtime: CliRuntime): void {
  const ctx = contextFor(command, runtime);
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
}

async function mutate(
  command: Command,
  params: { enabled?: boolean; category?: TelemetryCategory; categoryEnabled?: boolean },
  key: string,
  runtime: CliRuntime
): Promise<void> {
  const result = await runCliClient((client) =>
    client.call("telemetry.set", params, {
      idempotencyKey: `${key}-${randomId(16)}`
    })
  );
  renderStatus(command, result, runtime);
}

export function registerTelemetry(program: Command, runtime: CliRuntime = processCliRuntime): void {
  const telemetry = program
    .command("telemetry")
    .description("inspect and control anonymous telemetry");
  telemetry
    .command("status", { isDefault: true })
    .action(async (_options: unknown, command: Command) => {
      renderStatus(
        command,
        await runCliClient((client) => client.call("telemetry.get", {})),
        runtime
      );
    });
  telemetry.command("on").action(async (_options: unknown, command: Command) => {
    await mutate(command, { enabled: true }, "telemetry-on", runtime);
  });
  telemetry.command("off").action(async (_options: unknown, command: Command) => {
    await mutate(command, { enabled: false }, "telemetry-off", runtime);
  });
  telemetry
    .command("category <category> <state>")
    .description("enable or disable a telemetry category")
    .action(async (rawCategory: string, rawState: string, _options: unknown, command: Command) => {
      if (!["usage", "reliability", "adoption"].includes(rawCategory)) {
        throw new Error("category must be one of: usage, reliability, adoption");
      }
      if (!["on", "off"].includes(rawState)) throw new Error("state must be one of: on, off");
      const category = rawCategory as TelemetryCategory;
      const state = rawState as "on" | "off";
      await mutate(
        command,
        { category, categoryEnabled: state === "on" },
        `telemetry-${category}-${state}`,
        runtime
      );
    });
  telemetry
    .command("schema")
    .description("show the exact telemetry event inventory")
    .action(async (_options: unknown, command: Command) => {
      const ctx = contextFor(command, runtime);
      const schema = await runCliClient((client) => client.call("telemetry.schema", {}));
      if (ctx.json) ctx.emit(schema);
      else runtime.stdout.write(`${JSON.stringify(schema, null, 2)}\n`);
    });
  telemetry
    .command("reset")
    .description("rotate the anonymous install identity")
    .action(async (_options: unknown, command: Command) => {
      const ctx = contextFor(command, runtime);
      const result = await runCliClient((client) =>
        client.call(
          "telemetry.resetIdentity",
          {},
          {
            idempotencyKey: `telemetry-reset-${randomId(16)}`
          }
        )
      );
      if (ctx.json) ctx.emit(result);
      else
        ctx.presenter.success(
          result.installIdPresent
            ? "anonymous install identity reset"
            : "telemetry is disabled; no anonymous install identity is stored"
        );
    });
}
