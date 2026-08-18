import {
  CliError,
  type CliRuntime,
  contextForFlags,
  processCliRuntime
} from "@velum-labs/routekit-cli-core";
import { Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";

import { cliTryPromise } from "../../cli-session.js";
import { validateInstallVersion } from "../../remote-provision.js";
import { performSelfUpdate, SelfUpdateInspectionError } from "../../self-update-inspector.js";
import { selectedRemoteMetadata } from "../../target.js";
import { routekitRoot } from "../root-command.js";

const optionalString = (name: string) =>
  Flag.string(name).pipe(
    Flag.optional,
    Flag.map(Option.getOrUndefined)
  );

export const makeSelfUpdateCommand = (
  runtime: CliRuntime = processCliRuntime
): Command.Command.Any =>
  Command.make(
    "self-update",
    {
      version: optionalString("version").pipe(
        Flag.withDefault("latest"),
        Flag.withDescription("version to install (default: latest)")
      ),
      dryRun: Flag.boolean("dry-run").pipe(
        Flag.withDescription("show what would be installed without changing anything")
      )
    },
    ({ dryRun, version: versionInput }) =>
      Effect.gen(function* () {
        const ctx = contextForFlags(yield* routekitRoot, runtime);
        const version = validateInstallVersion(versionInput ?? "latest");
        const result = yield* cliTryPromise(async () => {
          try {
            return await performSelfUpdate(version, dryRun);
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
        });

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
          if (dryRun) ctx.presenter.note("no changes would be made");
          return;
        }
        if (dryRun) {
          ctx.presenter.note(
            `would install @velum-labs/routekit@${result.targetVersion} with ${result.owner.kind} (current ${result.from})`
          );
          if (version === "latest") {
            ctx.presenter.note(`resolved @velum-labs/routekit@latest to ${result.targetVersion}`);
          }
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
      })
  ).pipe(Command.withDescription("install or upgrade the RouteKit CLI package"));
