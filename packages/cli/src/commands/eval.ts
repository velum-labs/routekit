import { type CliRuntime, contextFor, processCliRuntime } from "@velum-labs/routekit-cli-core";
import type { EvalExecutionPlan, EvalProjectStatus } from "@velum-labs/routekit-eval-setup";
import type { Command } from "commander";

import { runCliEffect } from "../cli-session.js";
import {
  type EvalWorkflowCliInput,
  evalAnswerCommand,
  evalApproveDimensionsCommand,
  evalApproveEvaluationsCommand,
  evalEstimateCommand,
  evalProposeDimensionsCommand,
  evalProposeEvaluationsCommand,
  evalPublishCommand,
  evalResultsCommand,
  evalRunCommand,
  evalSetupCommand,
  evalStatusCommand,
  evalValidateCommand
} from "../effect/eval-cli.js";

type RepositoryOptions = {
  readonly repository?: string;
};

const workflowInput = (options: RepositoryOptions): EvalWorkflowCliInput => ({
  ...(options.repository === undefined ? {} : { repositoryRoot: options.repository })
});

function withRepository(command: Command): Command {
  return command.option("--repository <path>", "repository root", ".");
}

function presentStatus(
  ctx: ReturnType<typeof contextFor>,
  result: EvalProjectStatus | undefined
): void {
  if (ctx.json) {
    ctx.emit(result ?? null);
    return;
  }
  if (result === undefined) {
    ctx.presenter.status("warn", "eval project", "not found");
    ctx.presenter.line("Run `routekit eval setup` from the repository root.");
    return;
  }
  ctx.presenter.status("ok", "project", result.state.projectId);
  ctx.presenter.status("ok", "stage", result.state.stage);
  ctx.presenter.status("ok", "next action", result.nextAction);
  if (result.artifacts !== undefined) {
    ctx.presenter.status(
      result.artifacts.basisApproved ? "ok" : "warn",
      "routing basis",
      result.artifacts.basisProposalDigest ?? "not proposed"
    );
    ctx.presenter.status(
      result.artifacts.evaluationsApproved ? "ok" : "warn",
      "evaluations",
      result.artifacts.evaluationProposalDigest ?? "not proposed"
    );
  }
  if (result.question !== undefined) {
    ctx.presenter.heading(result.question.prompt);
    result.question.options.forEach((option, index) => {
      ctx.presenter.line(`${String(index + 1)}. ${option}`);
    });
  }
}

function presentPlan(ctx: ReturnType<typeof contextFor>, plan: EvalExecutionPlan): void {
  if (ctx.json) {
    ctx.emit(plan);
    return;
  }
  ctx.presenter.status("ok", "plan", plan.planId);
  ctx.presenter.status("ok", "scope", plan.scope);
  ctx.presenter.status("ok", "candidate calls", String(plan.expectedCandidateCalls));
  ctx.presenter.status("ok", "judge calls", String(plan.expectedJudgeCalls));
  ctx.presenter.status("ok", "total calls", String(plan.expectedCallCount));
  ctx.presenter.status(
    "ok",
    "maximum output per call",
    `${String(plan.maximumOutputTokens)} tokens`
  );
  ctx.presenter.status("warn", "estimated USD", "unknown");
  ctx.presenter.line(
    "Dollar failsafes are unavailable for unpriced calls; call, token, output, and wall-time limits remain active."
  );
}

export function registerEval(program: Command, runtime: CliRuntime = processCliRuntime): void {
  const evalCommand = program
    .command("eval")
    .description("build and activate compositional eval-driven routing");

  withRepository(
    evalCommand.command("setup").description("initialize or resume an eval project")
  ).action(async (options: RepositoryOptions, command: Command) => {
    const ctx = contextFor(command, runtime);
    presentStatus(ctx, await runCliEffect(evalSetupCommand(workflowInput(options))));
  });

  withRepository(
    evalCommand.command("status").description("show durable eval project state")
  ).action(async (options: RepositoryOptions, command: Command) => {
    const ctx = contextFor(command, runtime);
    presentStatus(ctx, await runCliEffect(evalStatusCommand(workflowInput(options))));
  });

  withRepository(
    evalCommand
      .command("answer")
      .description("answer exactly one setup question")
      .option("--answer <text>", "answer to the current question")
      .option("--answer-file <path>", "file containing the answer to the current question")
  ).action(
    async (options: RepositoryOptions & { answer?: string; answerFile?: string }, command) => {
      if ((options.answer === undefined) === (options.answerFile === undefined)) {
        throw new Error("provide exactly one of --answer or --answer-file");
      }
      const ctx = contextFor(command, runtime);
      presentStatus(
        ctx,
        await runCliEffect(
          evalAnswerCommand({
            ...workflowInput(options),
            ...(options.answer === undefined ? {} : { answer: options.answer }),
            ...(options.answerFile === undefined ? {} : { answerFile: options.answerFile })
          })
        )
      );
    }
  );

  const propose = evalCommand.command("propose").description("create reviewable eval artifacts");
  withRepository(
    propose
      .command("dimensions")
      .description("author a proposed routing basis on the configured RouteKit target")
      .option("--file <path>", "import a reviewed JSON workload-dimension proposal")
  ).action(async (options: RepositoryOptions & { file?: string }, command) => {
    const ctx = contextFor(command, runtime);
    presentStatus(
      ctx,
      await runCliEffect(
        evalProposeDimensionsCommand({
          ...workflowInput(options),
          ...(options.file === undefined ? {} : { file: options.file })
        })
      )
    );
  });
  withRepository(
    propose
      .command("evaluations")
      .description("author proposed dimension suites on the configured RouteKit target")
      .option("--file <path>", "import a reviewed JSON evaluation proposal")
  ).action(async (options: RepositoryOptions & { file?: string }, command) => {
    const ctx = contextFor(command, runtime);
    presentStatus(
      ctx,
      await runCliEffect(
        evalProposeEvaluationsCommand({
          ...workflowInput(options),
          ...(options.file === undefined ? {} : { file: options.file })
        })
      )
    );
  });

  const approve = evalCommand.command("approve").description("approve an exact artifact digest");
  withRepository(
    approve
      .command("dimensions")
      .description("approve the reviewed routing basis")
      .requiredOption("--digest <sha256>", "exact routing-basis digest")
  ).action(async (options: RepositoryOptions & { digest: string }, command) => {
    const ctx = contextFor(command, runtime);
    presentStatus(
      ctx,
      await runCliEffect(
        evalApproveDimensionsCommand({ ...workflowInput(options), digest: options.digest })
      )
    );
  });
  withRepository(
    approve
      .command("evaluations")
      .description("approve the reviewed dimension suites")
      .requiredOption("--digest <sha256>", "exact evaluation-proposal digest")
  ).action(async (options: RepositoryOptions & { digest: string }, command) => {
    const ctx = contextFor(command, runtime);
    presentStatus(
      ctx,
      await runCliEffect(
        evalApproveEvaluationsCommand({ ...workflowInput(options), digest: options.digest })
      )
    );
  });

  withRepository(
    evalCommand.command("validate").description("validate current approvals and project state")
  ).action(async (options: RepositoryOptions, command) => {
    const ctx = contextFor(command, runtime);
    presentStatus(ctx, await runCliEffect(evalValidateCommand(workflowInput(options))));
  });

  withRepository(
    evalCommand
      .command("estimate")
      .description("create an immutable pilot or full execution plan")
      .option("--scope <scope>", "pilot or full", "pilot")
  ).action(async (options: RepositoryOptions & { scope: string }, command) => {
    if (options.scope !== "pilot" && options.scope !== "full") {
      throw new Error('--scope must be "pilot" or "full"');
    }
    const ctx = contextFor(command, runtime);
    presentPlan(
      ctx,
      await runCliEffect(evalEstimateCommand({ ...workflowInput(options), scope: options.scope }))
    );
  });

  withRepository(
    evalCommand
      .command("run")
      .description("execute an approved immutable plan on the selected RouteKit target")
      .requiredOption("--plan <id>", "immutable execution plan id")
      .option("--gateway-url <url>", "external qualification-only gateway")
      .option("--token-file <path>", "private external gateway credential file")
  ).action(
    async (
      options: RepositoryOptions & {
        plan: string;
        gatewayUrl?: string;
        tokenFile?: string;
      },
      command
    ) => {
    const ctx = contextFor(command, runtime);
    ctx.emit(
      await runCliEffect(
        evalRunCommand({
          ...workflowInput(options),
          planId: options.plan,
          ...(options.gatewayUrl === undefined ? {} : { gatewayUrl: options.gatewayUrl }),
          ...(options.tokenFile === undefined ? {} : { tokenFile: options.tokenFile })
        })
      )
    );
    }
  );

  withRepository(
    evalCommand
      .command("results")
      .description("show sanitized structured qualification results")
      .option("--run <id>", "qualification run id")
  ).action(async (options: RepositoryOptions & { run?: string }, command) => {
    const ctx = contextFor(command, runtime);
    ctx.emit(
      await runCliEffect(
        evalResultsCommand({
          ...workflowInput(options),
          ...(options.run === undefined ? {} : { runId: options.run })
        })
      )
    );
  });

  withRepository(
    evalCommand
      .command("publish")
      .description("atomically activate already-qualified routing evidence")
      .requiredOption("--run <id>", "qualified run id")
  ).action(async (options: RepositoryOptions & { run: string }, command) => {
    const ctx = contextFor(command, runtime);
    ctx.emit(
      await runCliEffect(evalPublishCommand({ ...workflowInput(options), runId: options.run }))
    );
  });
}
