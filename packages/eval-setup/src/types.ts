import type {
  CompiledRoutingPolicy,
  EvalComparisonResult,
  EvalSetupEvent,
  EvalSetupRunMode,
  EvalSetupStage,
  EvalSetupState,
  RoutingObjective,
  RoutingProfile
} from "@velum-labs/routekit-eval-contracts";

export type SetupQuestion = {
  readonly id: EvalSetupStage;
  readonly prompt: string;
  readonly options: readonly [string, string, string];
};

export type RepositorySurface = {
  readonly name: string;
  readonly path: string;
  readonly model?: string;
};

export type RepositoryMaterial = {
  readonly kind: "prompt" | "dataset" | "fixture" | "test" | "schema";
  readonly path: string;
};

export type RepositoryInspection = {
  readonly repositoryRoot: string;
  readonly surfaces: readonly RepositorySurface[];
  readonly materials: readonly RepositoryMaterial[];
};

export type SetupEstimate = {
  readonly callCount: number;
  readonly maximumCostUsd?: number;
  readonly pricingKnown: boolean;
};

export type ScaffoldInput = {
  readonly profileId: string;
  readonly repositoryRoot: string;
  readonly surface: string;
  readonly dataSource: string;
  readonly criteria: string;
  readonly constraint: string;
  readonly candidates: readonly string[];
  readonly judgeModel: string;
  readonly objective: RoutingObjective;
};

export type ScaffoldResult = {
  readonly evalPath: string;
  readonly profilePath: string;
  readonly profile: RoutingProfile;
};

export type SetupStatus = {
  readonly state: EvalSetupState;
  readonly question?: SetupQuestion;
  readonly inspection?: RepositoryInspection;
};

export type SetupAnswerResult = SetupStatus & {
  readonly events: readonly EvalSetupEvent[];
};

export type SetupRunResult = SetupAnswerResult & {
  readonly comparison?: EvalComparisonResult;
  readonly proposal?: CompiledRoutingPolicy;
};

export type EvalSetupRunnerShape = {
  readonly validate: (
    input: ScaffoldResult
  ) => import("effect").Effect.Effect<void, import("./errors.js").EvalSetupRunnerError>;
  readonly estimate: (
    input: ScaffoldResult,
    mode: Exclude<EvalSetupRunMode, "save-only">
  ) => import("effect").Effect.Effect<SetupEstimate, import("./errors.js").EvalSetupRunnerError>;
  readonly runPilot: (
    input: ScaffoldResult
  ) => import("effect").Effect.Effect<EvalComparisonResult, import("./errors.js").EvalSetupRunnerError>;
  readonly runFull: (
    input: ScaffoldResult
  ) => import("effect").Effect.Effect<EvalComparisonResult, import("./errors.js").EvalSetupRunnerError>;
  readonly propose: (
    input: EvalComparisonResult
  ) => import("effect").Effect.Effect<CompiledRoutingPolicy, import("./errors.js").EvalSetupRunnerError>;
  readonly publish: (
    input: CompiledRoutingPolicy
  ) => import("effect").Effect.Effect<void, import("./errors.js").EvalSetupRunnerError>;
};

export type EvalSetupRunCheckpoint = {
  readonly comparison: EvalComparisonResult;
  readonly proposal: CompiledRoutingPolicy;
};
