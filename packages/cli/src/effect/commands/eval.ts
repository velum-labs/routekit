import {
  type CliRuntime,
  type CommandContext,
  contextForFlags,
  processCliRuntime
} from "@velum-labs/routekit-cli-core";
import type { EvalExecutionPlan, EvalProjectStatus } from "@velum-labs/routekit-eval-setup";
import { Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";

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
} from "../eval-cli.js";
import { cliFailure } from "../../cli-session.js";
import { routekitRoot } from "../root-command.js";

type RepositoryOptions = {
  readonly repository?: string;
};

const workflowInput = (options: RepositoryOptions): EvalWorkflowCliInput => ({
  ...(options.repository === undefined ? {} : { repositoryRoot: options.repository })
});

const optionalString = (name: string) =>
  Flag.string(name).pipe(
    Flag.optional,
    Flag.map(Option.getOrUndefined)
  );

const repository = optionalString("repository").pipe(
  Flag.withDefault("."),
  Flag.withDescription("repository root")
);

function presentStatus(ctx: CommandContext, result: EvalProjectStatus | undefined): void {
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

function presentPlan(ctx: CommandContext, plan: EvalExecutionPlan): void {
  if (ctx.json) {
    ctx.emit(plan);
    return;
  }
  ctx.presenter.status("ok", "plan", plan.planId);
  ctx.presenter.status("ok", "scope", plan.scope);
  ctx.presenter.status("ok", "candidate calls", String(plan.expectedCandidateCalls));
  ctx.presenter.status("ok", "judge calls", String(plan.expectedJudgeCalls));
  ctx.presenter.status("ok", "total calls", String(plan.expectedCallCount));
  ctx.presenter.status("ok", "maximum output per call", `${String(plan.maximumOutputTokens)} tokens`);
  ctx.presenter.status("warn", "estimated USD", "unknown");
  ctx.presenter.line(
    "Dollar failsafes are unavailable for unpriced calls; call, token, output, and wall-time limits remain active."
  );
}

const withStatus = <A, E, R>(
  runtime: CliRuntime,
  effect: Effect.Effect<EvalProjectStatus | undefined, E, R>
) =>
  Effect.gen(function* () {
    const ctx = contextForFlags(yield* routekitRoot, runtime);
    presentStatus(ctx, yield* effect);
  });

export const makeEvalCommand = (
  runtime: CliRuntime = processCliRuntime
): Command.Command.Any => {
  const setup = Command.make("setup", { repository }, (options) =>
    withStatus(runtime, evalSetupCommand(workflowInput(options)))
  ).pipe(Command.withDescription("initialize or resume an eval project"));
  const status = Command.make("status", { repository }, (options) =>
    withStatus(runtime, evalStatusCommand(workflowInput(options)))
  ).pipe(Command.withDescription("show durable eval project state"));
  const answer = Command.make(
    "answer",
    {
      repository,
      answer: optionalString("answer").pipe(
        Flag.withDescription("answer to the current question")
      ),
      answerFile: optionalString("answer-file").pipe(
        Flag.withDescription("file containing the answer to the current question")
      )
    },
    (options) =>
      Effect.gen(function* () {
        if ((options.answer === undefined) === (options.answerFile === undefined)) {
          return yield* cliFailure("provide exactly one of --answer or --answer-file");
        }
        yield* withStatus(
          runtime,
          evalAnswerCommand({
            ...workflowInput(options),
            ...(options.answer === undefined ? {} : { answer: options.answer }),
            ...(options.answerFile === undefined ? {} : { answerFile: options.answerFile })
          })
        );
      })
  ).pipe(Command.withDescription("answer exactly one setup question"));

  const proposeDimensions = Command.make(
    "dimensions",
    {
      repository,
      file: optionalString("file").pipe(
        Flag.withDescription("import a reviewed JSON workload-dimension proposal")
      )
    },
    (options) =>
      withStatus(
        runtime,
        evalProposeDimensionsCommand({
          ...workflowInput(options),
          ...(options.file === undefined ? {} : { file: options.file })
        })
      )
  ).pipe(
    Command.withDescription("author a proposed routing basis on the configured RouteKit target")
  );
  const proposeEvaluations = Command.make(
    "evaluations",
    {
      repository,
      file: optionalString("file").pipe(
        Flag.withDescription("import a reviewed JSON evaluation proposal")
      )
    },
    (options) =>
      withStatus(
        runtime,
        evalProposeEvaluationsCommand({
          ...workflowInput(options),
          ...(options.file === undefined ? {} : { file: options.file })
        })
      )
  ).pipe(
    Command.withDescription("author proposed dimension suites on the configured RouteKit target")
  );
  const propose = Command.make("propose").pipe(
    Command.withDescription("create reviewable eval artifacts"),
    Command.withSubcommands([proposeDimensions, proposeEvaluations])
  );

  const approveDimensions = Command.make(
    "dimensions",
    {
      repository,
      digest: Flag.string("digest").pipe(
        Flag.withDescription("exact routing-basis digest")
      )
    },
    (options) =>
      withStatus(
        runtime,
        evalApproveDimensionsCommand({
          ...workflowInput(options),
          digest: options.digest
        })
      )
  ).pipe(Command.withDescription("approve the reviewed routing basis"));
  const approveEvaluations = Command.make(
    "evaluations",
    {
      repository,
      digest: Flag.string("digest").pipe(
        Flag.withDescription("exact evaluation-proposal digest")
      )
    },
    (options) =>
      withStatus(
        runtime,
        evalApproveEvaluationsCommand({
          ...workflowInput(options),
          digest: options.digest
        })
      )
  ).pipe(Command.withDescription("approve the reviewed dimension suites"));
  const approve = Command.make("approve").pipe(
    Command.withDescription("approve an exact artifact digest"),
    Command.withSubcommands([approveDimensions, approveEvaluations])
  );

  const validate = Command.make("validate", { repository }, (options) =>
    withStatus(runtime, evalValidateCommand(workflowInput(options)))
  ).pipe(Command.withDescription("validate current approvals and project state"));
  const estimate = Command.make(
    "estimate",
    {
      repository,
      scope: Flag.choice("scope", ["pilot", "full"] as const).pipe(
        Flag.withDefault("pilot"),
        Flag.withDescription("pilot or full")
      )
    },
    (options) =>
      Effect.gen(function* () {
        const ctx = contextForFlags(yield* routekitRoot, runtime);
        presentPlan(
          ctx,
          yield* evalEstimateCommand({
            ...workflowInput(options),
            scope: options.scope
          })
        );
      })
  ).pipe(Command.withDescription("create an immutable pilot or full execution plan"));
  const run = Command.make(
    "run",
    {
      repository,
      plan: Flag.string("plan").pipe(
        Flag.withDescription("immutable execution plan id")
      ),
      gatewayUrl: optionalString("gateway-url").pipe(
        Flag.withDescription("external qualification-only gateway")
      ),
      tokenFile: optionalString("token-file").pipe(
        Flag.withDescription("private external gateway credential file")
      )
    },
    (options) =>
      Effect.gen(function* () {
        const ctx = contextForFlags(yield* routekitRoot, runtime);
        ctx.emit(
          yield* evalRunCommand({
            ...workflowInput(options),
            planId: options.plan,
            ...(options.gatewayUrl === undefined ? {} : { gatewayUrl: options.gatewayUrl }),
            ...(options.tokenFile === undefined ? {} : { tokenFile: options.tokenFile })
          })
        );
      })
  ).pipe(
    Command.withDescription("execute an approved immutable plan on the selected RouteKit target")
  );
  const results = Command.make(
    "results",
    {
      repository,
      run: optionalString("run").pipe(
        Flag.withDescription("qualification run id")
      )
    },
    (options) =>
      Effect.gen(function* () {
        const ctx = contextForFlags(yield* routekitRoot, runtime);
        ctx.emit(
          yield* evalResultsCommand({
            ...workflowInput(options),
            ...(options.run === undefined ? {} : { runId: options.run })
          })
        );
      })
  ).pipe(Command.withDescription("show sanitized structured qualification results"));
  const publish = Command.make(
    "publish",
    {
      repository,
      run: Flag.string("run").pipe(Flag.withDescription("qualified run id"))
    },
    (options) =>
      Effect.gen(function* () {
        const ctx = contextForFlags(yield* routekitRoot, runtime);
        ctx.emit(
          yield* evalPublishCommand({
            ...workflowInput(options),
            runId: options.run
          })
        );
      })
  ).pipe(Command.withDescription("atomically activate already-qualified routing evidence"));

  return Command.make("eval").pipe(
    Command.withDescription("build and activate compositional eval-driven routing"),
    Command.withSubcommands([
      setup,
      status,
      answer,
      propose,
      approve,
      validate,
      estimate,
      run,
      results,
      publish
    ])
  );
};
