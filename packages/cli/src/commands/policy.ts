import { type CliRuntime, contextFor, processCliRuntime } from "@velum-labs/routekit-cli-core";
import type { Command } from "commander";
import { activeCliSession } from "../cli-session.js";
import { policyShowCommand } from "../effect/eval-cli.js";

export function registerPolicy(program: Command, runtime: CliRuntime = processCliRuntime): void {
  program
    .command("policy")
    .description("show the evaluation policy that keeps eval off the online request path")
    .command("show", { isDefault: true })
    .description("print the eval isolation policy")
    .action(async (_options: unknown, command: Command) => {
      const ctx = contextFor(command, runtime);
      const policy = await activeCliSession().effectRuntime.runPromise(policyShowCommand());
      if (ctx.json) ctx.emit(policy);
      else {
        ctx.presenter.status("ok", "dedicated token", "required");
        ctx.presenter.status("ok", "explicit model IDs", "required");
        ctx.presenter.status("ok", "auto-router", "forbidden");
        ctx.presenter.status("ok", "online request path", "isolated");
      }
    });
}
