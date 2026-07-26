import { spawn } from "node:child_process";

import { CliError, contextFor } from "@velum-labs/routekit-cli-core";
import type { Command } from "commander";

import { INSTALLER_SCRIPT } from "../generated/shell-scripts.js";
import { validateInstallVersion } from "../remote-provision.js";
import { routekitVersion } from "../state.js";

async function runInstaller(args: readonly string[]): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  return await new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", INSTALLER_SCRIPT, "routekit-self-update", ...args], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode: code ?? 1
      });
    });
  });
}

export function registerSelfUpdate(program: Command): void {
  program
    .command("self-update")
    .description("install or upgrade the RouteKit CLI package")
    .option("--version <version>", "version to install (default: latest)", "latest")
    .option("--dry-run", "show what would be installed without changing anything")
    .action(
      async (
        options: { version?: string; dryRun?: boolean },
        command: Command
      ) => {
        const ctx = contextFor(command);
        const version = validateInstallVersion(options.version ?? "latest");
        const current = routekitVersion();
        const args = ["--version", version];
        if (options.dryRun === true) args.push("--dry-run");

        let result;
        try {
          result = await runInstaller(args);
        } catch (error) {
          throw new CliError({
            message: "failed to launch the RouteKit installer",
            details: [error instanceof Error ? error.message : String(error)]
          });
        }
        if (result.exitCode !== 0) {
          throw new CliError({
            message: `RouteKit self-update failed (exit ${result.exitCode})`,
            details: result.stderr
              .split("\n")
              .map((line) => line.trimEnd())
              .filter((line) => line.length > 0)
              .slice(-8)
          });
        }

        const installed =
          result.stdout.trim().split("\n").pop()?.trim() || version;
        const payload = {
          action: options.dryRun === true ? "planned" : "updated",
          from: current,
          to: installed,
          version
        };
        if (ctx.json) {
          ctx.emit(payload);
          return;
        }
        if (options.dryRun === true) {
          ctx.presenter.note(
            `would install @velum-labs/routekit@${version} (current ${current})`
          );
          return;
        }
        ctx.presenter.success(`RouteKit CLI is now v${installed}`);
        if (installed !== current) {
          ctx.presenter.note(
            "roll a running daemon into this CLI with `routekit upgrade`"
          );
        }
      }
    );
}
