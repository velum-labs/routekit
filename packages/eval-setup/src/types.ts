import type {
  CompiledRoutingPolicy,
  EvalComparisonResult,
  EvalSetupEvent,
  EvalSetupRunMode,
  RoutingObjective,
  RoutingProfile
} from "@velum-labs/routekit-eval-contracts";

import type { OriEvalResult } from "./ori-result.js";

export type SetupQuestion = {
  readonly id: string;
  readonly prompt: string;
  readonly context?: string;
  readonly options: readonly string[];
};

export type RepositorySurface = {
  readonly name: string;
  readonly path: string;
  readonly model?: string;
};

export type RepositoryMaterial = {
  readonly kind: "doc" | "prompt" | "dataset" | "fixture" | "test" | "schema";
  readonly path: string;
};

export type RepositoryInspection = {
  readonly repositoryRoot: string;
  readonly surfaces: readonly RepositorySurface[];
  readonly materials: readonly RepositoryMaterial[];
  readonly summary: {
    readonly entriesVisited: number;
    readonly textFilesConsidered: number;
    readonly filesRead: number;
    readonly bytesRead: number;
    readonly skippedOversizedFiles: number;
    readonly truncated: boolean;
  };
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

export type SetupStateView = {
  readonly profileId: string;
  readonly repositoryRoot: string;
  readonly stage: string;
  readonly revision: number;
  readonly updatedAt: string;
  readonly answers: Record<string, string>;
  readonly runDirectory?: string;
  readonly scratchWorkspace?: string;
  readonly publishApproved?: boolean;
};

export type SetupStatus = {
  readonly state: SetupStateView;
  readonly question?: SetupQuestion;
  readonly result?: OriEvalResult;
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
    result: OriEvalResult
  ) => import("effect").Effect.Effect<void, import("./errors.js").EvalSetupRunnerError>;
  readonly estimate: (
    result: OriEvalResult,
    mode: EvalSetupRunMode
  ) => import("effect").Effect.Effect<SetupEstimate, import("./errors.js").EvalSetupRunnerError>;
  readonly publish: (input: {
    readonly profileId: string;
    readonly description: string;
    readonly repositoryRoot: string;
    readonly objective: RoutingObjective;
    readonly result: OriEvalResult;
  }) => import("effect").Effect.Effect<
    {
      readonly comparison: EvalComparisonResult;
      readonly proposal: CompiledRoutingPolicy;
    },
    import("./errors.js").EvalSetupRunnerError
  >;
};

export type EvalSetupRunCheckpoint = {
  readonly comparison: EvalComparisonResult;
  readonly proposal: CompiledRoutingPolicy;
};

export type { EvalSetupRunMode };
