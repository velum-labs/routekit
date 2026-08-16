import { invokeSpawnWorkflow } from "./spawn-workflow.ts";
import { createProductionAuthorTurnAdapter } from "./production-author-turn.ts";
import type {
  CreateEvalAnswerInput,
  CreateEvalAuthoring,
  CreateEvalPrepareInput,
  CreateEvalResult,
  CreateEvalRunInput,
  CreateEvalRuntime,
  CreateEvalStatusInput,
} from "./public-api.ts";

const addOption = (
  args: string[],
  name: string,
  value: string | undefined,
): void => {
  if (value !== undefined) args.push(name, value);
};

const structured = async (
  args: readonly string[],
  runtime: CreateEvalRuntime,
): Promise<CreateEvalResult> => {
  const result = await invokeSpawnWorkflow(args, runtime);
  if (typeof result.output === "string") {
    throw new Error(`Expected a structured create-eval result for ${args[0] ?? "operation"}`);
  }
  return result.output as CreateEvalResult;
};

const prepareArgs = (input: CreateEvalPrepareInput): readonly string[] => {
  const args = ["prepare", "--repo", input.repository];
  addOption(args, "--request", input.request);
  addOption(args, "--harness", input.harness);
  addOption(args, "--model", input.model);
  addOption(args, "--judge-model", input.judgeModel);
  addOption(args, "--existing", input.existing);
  return args;
};

const runArgs = (
  command: "run" | "status",
  input: CreateEvalRunInput | CreateEvalStatusInput,
): readonly string[] => {
  const args = [command];
  addOption(args, "--repo", input.repository);
  addOption(args, "--run-directory", input.runDirectory);
  return args;
};

const answerArgs = (input: CreateEvalAnswerInput): readonly string[] => {
  const args = ["answer", "--answer", input.answer];
  addOption(args, "--repo", input.repository);
  addOption(args, "--run-directory", input.runDirectory);
  return args;
};

/**
 * Create an isolated, durable eval-authoring controller.
 *
 * The returned API never reads CLI argv, writes process stdio, changes
 * process.exitCode, or invokes the Ori executable. By default it adapts Ori's
 * production headless author runtime and dedicated eval worker; hosts may
 * override those ports for deterministic embedding tests.
 */
export const createEvalAuthoring = (
  runtime: CreateEvalRuntime,
): CreateEvalAuthoring => {
  const production = createProductionAuthorTurnAdapter(runtime.production);
  const configured: CreateEvalRuntime = {
    ...runtime,
    evalCommand: runtime.evalCommand ?? production.evalCommand,
    runAuthorTurn: runtime.runAuthorTurn ?? production.runAuthorTurn,
  };
  return {
    prepare: (input) => structured(prepareArgs(input), configured),
    run: (input) => structured(runArgs("run", input), configured),
    answer: (input) => structured(answerArgs(input), configured),
    status: (input) => structured(runArgs("status", input), configured),
    manifest: () => structured(["manifest"], configured),
    skill: async () => {
      const result = await invokeSpawnWorkflow(["skill"], configured);
      if (typeof result.output !== "string") {
        throw new Error("Expected create-eval skill text");
      }
      return result.output;
    },
  };
};

export {
  createProductionAuthorTurnAdapter,
};

export const runEvalTool = async (
  input: import("./public-api.ts").CreateEvalToolInput,
): Promise<import("./public-api.ts").CreateEvalToolResult> =>
  (await import("./eval-tool.ts")).runEvalTool(input);

export type {
  CreateEvalAnswerInput,
  CreateEvalAttempt,
  CreateEvalAttemptSummary,
  CreateEvalAuthorHarness,
  CreateEvalAuthoring,
  CreateEvalAuthorTurnInput,
  CreateEvalAuthorTurnResult,
  CreateEvalCredentialInput,
  CreateEvalCredentialResult,
  CreateEvalExistingChoice,
  CreateEvalPrepareInput,
  CreateEvalQuestion,
  CreateEvalResult,
  CreateEvalRunInput,
  CreateEvalRunStatus,
  CreateEvalRuntime,
  CreateEvalState,
  CreateEvalStatusInput,
  CreateEvalToolInput,
  CreateEvalToolResult,
  ProductionAuthorTurnAdapter,
  ProductionAuthorTurnAdapterOptions,
  ProductionHeadlessAuthorInput,
} from "./public-api.ts";
