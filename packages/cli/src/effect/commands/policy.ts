import {
  type CliRuntime,
  contextForFlags,
  processCliRuntime
} from "@velum-labs/routekit-cli-core";
import { Effect } from "effect";
import { Command } from "effect/unstable/cli";

import { policyShowCommand } from "../eval-cli.js";
import { routekitRoot } from "../root-command.js";

const showPolicy = (runtime: CliRuntime) =>
  Effect.gen(function* () {
    const ctx = contextForFlags(yield* routekitRoot, runtime);
    const policy = yield* policyShowCommand;
    if (ctx.json) ctx.emit(policy);
    else {
      ctx.presenter.status("ok", "dedicated token", "required");
      ctx.presenter.status("ok", "explicit model IDs", "required");
      ctx.presenter.status("ok", "auto-router", "forbidden");
      ctx.presenter.status("ok", "online request path", "isolated");
    }
  });

export const makePolicyCommand = (
  runtime: CliRuntime = processCliRuntime
): Command.Command.Any => {
  const show = Command.make("show", {}, () => showPolicy(runtime)).pipe(
    Command.withDescription("print the eval isolation policy")
  );
  return Command.make("policy", {}, () => showPolicy(runtime)).pipe(
    Command.withDescription("show the evaluation policy that keeps eval off the online request path"),
    Command.withSubcommands([show])
  );
};
