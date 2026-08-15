import { type CliRuntime, contextFor, processCliRuntime } from "@velum-labs/routekit-cli-core";
import type {
  SetupAnswerResult,
  SetupRunResult,
  SetupStatus
} from "@velum-labs/routekit-eval-setup";
import type { Command } from "commander";

import { runCliEffect } from "../cli-session.js";
import {
  type EvalWorkflowCliInput,
  evalAnswerCommand,
  evalEstimateCommand,
  evalPrepareCommand,
  evalPublishCommand,
  evalRunCommand,
  evalStatusCommand,
  evalValidateCommand
} from "../effect/eval-cli.js";

type CommonOptions = {
  readonly profile: string;
  readonly repository?: string;
  readonly url?: string;
  readonly token?: string;
};

function workflowInput(options: CommonOptions, runtime: CliRuntime): EvalWorkflowCliInput {
  return {
    profileId: options.profile,
    ...(options.repository === undefined ? {} : { repositoryRoot: options.repository }),
    ...(options.url === undefined ? {} : { gatewayUrl: options.url }),
    ...(options.token === undefined ? {} : { token: options.token }),
    env: runtime.env as NodeJS.ProcessEnv
  };
}

function addIdentityOptions(command: Command): Command {
  return command
    .requiredOption("--profile <id>", "routing profile id")
    .option("--repository <path>", "repository root", ".");
}

function addGatewayOptions(command: Command, required: boolean): Command {
  addIdentityOptions(command);
  if (required) command.requiredOption("--url <gateway>", "OpenAI-compatible gateway URL");
  else command.option("--url <gateway>", "OpenAI-compatible gateway URL");
  return command;
}

function addExecutionOptions(command: Command): Command {
  addGatewayOptions(command, true);
  return command.requiredOption("--token <token>", "dedicated eval data-plane token");
}

function presentStatus(
  ctx: ReturnType<typeof contextFor>,
  result: SetupStatus | SetupAnswerResult | SetupRunResult | undefined
): void {
  if (ctx.json) {
    ctx.emit(result ?? null);
    return;
  }
  if (result === undefined) {
    ctx.presenter.status("warn", "setup", "not found");
    return;
  }
  ctx.presenter.status("ok", "profile", result.state.profileId);
  ctx.presenter.status("ok", "stage", result.state.stage);
  if (result.question !== undefined) {
    ctx.presenter.heading(result.question.prompt);
    result.question.options.forEach((option, index) => {
      ctx.presenter.line(`${String(index + 1)}. ${option}`);
    });
  }
}

export function registerEval(program: Command, runtime: CliRuntime = processCliRuntime): void {
  const evalCommand = program
    .command("eval")
    .description("create, run, and publish eval-driven model routes");

  addIdentityOptions(
    evalCommand.command("prepare").description("start or resume the setup interview")
  ).action(async (options: CommonOptions, command: Command) => {
    const ctx = contextFor(command, runtime);
    presentStatus(ctx, await runCliEffect(evalPrepareCommand(workflowInput(options, runtime))));
  });

  addIdentityOptions(
    evalCommand.command("status").description("show the durable setup state and open question")
  ).action(async (options: CommonOptions, command: Command) => {
    const ctx = contextFor(command, runtime);
    presentStatus(ctx, await runCliEffect(evalStatusCommand(workflowInput(options, runtime))));
  });

  addIdentityOptions(
    evalCommand
      .command("answer")
      .description("answer exactly one setup question")
      .requiredOption("--answer <text>", "answer to the current question")
  ).action(async (options: CommonOptions & { answer: string }, command: Command) => {
    const ctx = contextFor(command, runtime);
    presentStatus(
      ctx,
      await runCliEffect(
        evalAnswerCommand({ ...workflowInput(options, runtime), answer: options.answer })
      )
    );
  });

  addIdentityOptions(
    evalCommand.command("validate").description("dry-load the generated *.eval.ts suite")
  ).action(async (options: CommonOptions, command: Command) => {
    const ctx = contextFor(command, runtime);
    presentStatus(ctx, await runCliEffect(evalValidateCommand(workflowInput(options, runtime))));
  });

  addIdentityOptions(
    evalCommand
      .command("estimate")
      .description("estimate candidate and judge calls before spending")
      .option("--mode <mode>", "pilot or full", "pilot")
  ).action(async (options: CommonOptions & { mode: string }, command: Command) => {
    if (options.mode !== "pilot" && options.mode !== "full") {
      throw new Error('--mode must be "pilot" or "full"');
    }
    const ctx = contextFor(command, runtime);
    const result = await runCliEffect(
      evalEstimateCommand({ ...workflowInput(options, runtime), mode: options.mode })
    );
    if (ctx.json) ctx.emit(result);
    else {
      ctx.presenter.status("ok", "calls", String(result.callCount));
      ctx.presenter.status(
        result.pricingKnown ? "ok" : "warn",
        "maximum cost",
        result.maximumCostUsd === undefined ? "unmeasured" : `$${result.maximumCostUsd.toFixed(6)}`
      );
    }
  });

  addExecutionOptions(
    evalCommand.command("run").description("run the approved *.eval.ts comparison")
  ).action(async (options: CommonOptions, command: Command) => {
    const ctx = contextFor(command, runtime);
    presentStatus(ctx, await runCliEffect(evalRunCommand(workflowInput(options, runtime))));
  });

  addIdentityOptions(
    evalCommand
      .command("publish")
      .description("publish the approved winner to RouteKit's routing snapshot")
  ).action(async (options: CommonOptions, command: Command) => {
    const ctx = contextFor(command, runtime);
    presentStatus(ctx, await runCliEffect(evalPublishCommand(workflowInput(options, runtime))));
  });
}
