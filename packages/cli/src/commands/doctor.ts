import {
  type CliRuntime,
  contextFor,
  probeBinaryVersion,
  processCliRuntime
} from "@velum-labs/routekit-cli-core";
import { commandOnPath } from "@velum-labs/routekit-runtime";
import type { Command } from "commander";
import { Effect } from "effect";
import { runCliClient } from "../cli-client.js";
import { readDaemonRecord } from "../client.js";
import { serviceEnvironmentContractInstalled } from "../daemon.js";
import { routekitToolRegistry } from "../launch.js";
import { isLaunchToolId } from "../launch-support.js";

function installCommand(binary: string): string {
  switch (binary) {
    case "codex":
      return "npm install -g @openai/codex";
    case "claude":
      return "npm install -g @anthropic-ai/claude-code";
    default:
      return `command -v ${binary}`;
  }
}

export function registerDoctor(program: Command, runtime: CliRuntime = processCliRuntime): void {
  program
    .command("doctor")
    .description("check config, credentials, and coding-agent binaries")
    .action(async (_options: unknown, command: Command) => {
      const ctx = contextFor(command, runtime);
      const checks: Array<{
        label: string;
        ok: boolean;
        warning?: boolean;
        detail?: string;
        tryCommand?: string;
      }> = [];
      try {
        const { daemon, providers } = await runCliClient((client) =>
          Effect.gen(function* () {
            const daemon = yield* client.call("doctor.run", {});
            const providers = yield* client.call("providers.status", { live: true });
            return { daemon, providers };
          })
        );
        for (const check of daemon.checks) {
          checks.push({
            label: check.name,
            ok: check.ok,
            ...(check.detail !== undefined ? { detail: check.detail } : {})
          });
        }
        for (const provider of providers.providers) {
          checks.push({
            label: `${provider.provider} provider`,
            ok: provider.credentialAvailable && provider.error === undefined,
            detail:
              provider.error ??
              `${provider.models?.length ?? 0} model(s); ` +
                (provider.credentialAvailable ? "credential available" : "credential missing")
          });
        }
      } catch (error) {
        checks.push({
          label: "RouteKit daemon",
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
          tryCommand: "routekit status"
        });
      }
      const record = readDaemonRecord();
      if (
        (record?.supervisor === "systemd" || record?.supervisor === "launchd") &&
        !serviceEnvironmentContractInstalled(record.supervisor)
      ) {
        checks.push({
          label: "daemon service environment",
          ok: true,
          warning: true,
          detail: "service may inherit provider variables from the supervisor",
          tryCommand: "routekit daemon service install"
        });
      }
      for (const tool of routekitToolRegistry.list().filter((entry) => isLaunchToolId(entry.id))) {
        if (tool.binary === undefined) continue;
        const ok = commandOnPath(tool.binary);
        checks.push({
          label: tool.binary,
          ok,
          ...(ok
            ? { detail: probeBinaryVersion(tool.binary) ?? "installed" }
            : { tryCommand: installCommand(tool.binary) })
        });
      }
      for (const check of checks) {
        if (!check.ok && check.tryCommand === undefined) {
          check.tryCommand =
            check.label === "router config"
              ? "routekit config init"
              : check.label.endsWith("_API_KEY")
                ? `export ${check.label}='your-key'`
                : "routekit doctor";
        }
      }
      const summary = {
        ok: checks.filter((check) => check.ok && check.warning !== true).length,
        warn: checks.filter((check) => check.warning === true).length,
        fail: checks.filter((check) => !check.ok).length
      };
      if (ctx.json) ctx.emit({ ready: summary.fail === 0, summary, checks });
      else {
        for (const check of checks) {
          ctx.presenter.status(
            check.warning === true ? "warn" : check.ok ? "ok" : "fail",
            check.label,
            check.detail,
            check.warning === true ? check.tryCommand : undefined
          );
          if (!check.ok) {
            ctx.presenter.errorPanel({
              title: check.label,
              message: check.detail ?? `${check.label} failed`,
              tryCommand: check.tryCommand
            });
          }
        }
        ctx.presenter.box("doctor summary", [
          `${summary.ok} ok · ${summary.warn} warn · ${summary.fail} fail`
        ]);
      }
      if (checks.some((check) => !check.ok)) process.exitCode = 1;
    });
}
