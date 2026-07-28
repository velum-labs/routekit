import { CliError, contextFor } from "@velum-labs/routekit-cli-core";
import type { Command } from "commander";

import { validateInstallVersion } from "../remote-provision.js";
import { performSelfUpdate, SelfUpdateInspectionError } from "../self-update-inspector.js";
import { selectedRemoteMetadata } from "../target.js";

export function registerSelfUpdate(program: Command): void {
  program
    .command("self-update")
    .description("install or upgrade the RouteKit CLI package")
    .option("--version <version>", "version to install (default: latest)", "latest")
    .option("--dry-run", "show what would be installed without changing anything")
    .action(async (options: { version?: string; dryRun?: boolean }, command: Command) => {
      const ctx = contextFor(command);
      const version = validateInstallVersion(options.version ?? "latest");
      let result;
      try {
        result = await performSelfUpdate(version, options.dryRun === true);
      } catch (error) {
        if (error instanceof SelfUpdateInspectionError) {
          throw new CliError({
            message: error.message.split("\n", 1)[0]!,
            details: [...error.diagnostics],
            tryCommand: error.remediation.join(" "),
            tryArgv: error.remediation
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
        owner: {
          kind: result.owner.kind,
          executable: result.owner.executable,
          ...(result.owner.prefix !== undefined ? { prefix: result.owner.prefix } : {}),
          ...(result.owner.globalRoot !== undefined ? { globalRoot: result.owner.globalRoot } : {})
        },
        command: result.command
      };
      if (ctx.json) {
        ctx.emit(payload);
        return;
      }
      if (options.dryRun === true) {
        ctx.presenter.note(
          `would install @velum-labs/routekit@${version} with ${result.owner.kind} (current ${result.from})`
        );
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
