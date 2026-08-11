import {
  CliError,
  type CliRuntime,
  contextFor,
  processCliRuntime
} from "@velum-labs/routekit-cli-core";
import type { Command } from "commander";

import { validateInstallVersion } from "../remote-provision.js";
import { performSelfUpdate, SelfUpdateInspectionError } from "../self-update-inspector.js";
import { selectedRemoteMetadata } from "../target.js";

export function registerSelfUpdate(
  program: Command,
  runtime: CliRuntime = processCliRuntime
): void {
  program
    .command("self-update")
    .description("install or upgrade the RouteKit CLI package")
    .option("--version <version>", "version to install (default: latest)", "latest")
    .option("--dry-run", "show what would be installed without changing anything")
    .action(async (options: { version?: string; dryRun?: boolean }, command: Command) => {
      const ctx = contextFor(command, runtime);
      const version = validateInstallVersion(options.version ?? "latest");
      let result;
      try {
        result = await performSelfUpdate(version, options.dryRun === true);
      } catch (error) {
        if (error instanceof CliError) throw error;
        if (error instanceof SelfUpdateInspectionError) {
          throw new CliError({
            code: error.code,
            message: error.message,
            details: [...error.diagnostics],
            ...(error.hint !== undefined ? { hint: error.hint } : {}),
            ...(error.remediation !== undefined
              ? {
                  tryCommand: error.remediation.join(" "),
                  tryArgv: error.remediation
                }
              : {})
          });
        }
        throw new CliError({
          message: "RouteKit self-update failed",
          details: [error instanceof Error ? error.message : String(error)]
        });
      }

      const payload = {
        action: result.action,
        from: result.from,
        to: result.to,
        version,
        targetVersion: result.targetVersion,
        owner: {
          kind: result.owner.kind,
          provenance: result.owner.provenance,
          executable: result.owner.executable,
          contextId: result.owner.contextId,
          binDirectory: result.owner.binDirectory,
          ...(result.owner.kind === "npm" ? { prefix: result.owner.prefix } : {}),
          ...("globalRoot" in result.owner ? { globalRoot: result.owner.globalRoot } : {})
        },
        command: result.command
      };
      if (ctx.json) {
        ctx.emit(payload);
        return;
      }
      if (result.action === "skipped") {
        ctx.presenter.success(`RouteKit CLI is already v${result.targetVersion}`);
        if (options.dryRun === true) ctx.presenter.note("no changes would be made");
        return;
      }
      if (options.dryRun === true) {
        ctx.presenter.note(
          `would install @velum-labs/routekit@${result.targetVersion} with ${result.owner.kind} (current ${result.from})`
        );
        if (version === "latest")
          ctx.presenter.note(`resolved @velum-labs/routekit@latest to ${result.targetVersion}`);
        ctx.presenter.note(result.command.join(" "));
        return;
      }
      ctx.presenter.success(`RouteKit CLI is now v${result.to}`);
      if (result.to !== result.from) {
        const daemonCommand =
          selectedRemoteMetadata() === undefined
            ? "routekit daemon upgrade"
            : "routekit --local daemon upgrade";
        ctx.presenter.note(`roll a running daemon into this CLI with \`${daemonCommand}\``);
      }
    });
}
