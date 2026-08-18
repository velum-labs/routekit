export type CreateEvalAuthorHarness = "pi" | "claude" | "codex";
export type CreateEvalExistingChoice = "resume" | "archive" | "stop";
export type CreateEvalRunStatus =
  | "prepared"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "stopped";

export interface CreateEvalQuestion {
  readonly context: string;
  readonly tag:
    | "surface"
    | "workspace-files"
    | "workspace-data"
    | "criteria-priority"
    | "evaluation-constraint"
    | "candidates"
    | "next-step"
    | "untagged";
  readonly text: string;
  readonly violation?: string;
}

export interface CreateEvalAttemptSummary {
  readonly contextTokens?: number;
  readonly costUsd?: number;
  readonly durationMs?: number;
  readonly inputTokens?: number;
  readonly model?: string;
  readonly outputTokens?: number;
  readonly requestedModel?: string;
}

export interface CreateEvalAttempt {
  readonly answerFile: string;
  readonly durationMs: number;
  readonly endedAt: string;
  readonly errorFile: string;
  readonly exitCode: number;
  readonly number: number;
  readonly startedAt: string;
  readonly summary?: CreateEvalAttemptSummary;
}

export interface CreateEvalState {
  readonly activeQuestion?: CreateEvalQuestion;
  readonly activeChildPid?: number;
  readonly attempts: readonly CreateEvalAttempt[];
  readonly authorWorkspace: string;
  readonly createdAt: string;
  readonly createEvalSkillSha256: string;
  readonly harness: string;
  readonly judgeModel: string;
  readonly protocolVersion: 2;
  readonly repoRoot: string;
  readonly request: string;
  readonly runDirectory: string;
  readonly runModel: string;
  readonly scratchWorkspace?: string;
  readonly spawnSkillSha256: string;
  readonly status: CreateEvalRunStatus;
  readonly updatedAt: string;
}

/**
 * One structured controller result. Status-specific fields are intentionally
 * additive and remain JSON-compatible so hosts can persist or relay them.
 */
export interface CreateEvalResult {
  readonly ok: boolean;
  readonly status?: string;
  readonly runDirectory?: string;
  readonly state?: CreateEvalState;
  readonly error?: string;
  readonly [key: string]: unknown;
}

export interface CreateEvalAuthorTurnInput {
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly evalRunRecordFile: string;
  readonly scratchWorkspaceRecordFile: string;
  readonly harness: string;
  readonly judgeModel: string;
  readonly model: string;
  readonly prompt: string;
  readonly runDirectory: string;
}

export interface CreateEvalAuthorTurnResult {
  readonly exitCode: number;
  readonly stderr?: string;
  readonly stdout?: string;
}

export interface CreateEvalCredentialInput {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly repository: string;
}

export interface CreateEvalCredentialResult {
  readonly authenticated: boolean;
  readonly detail?: string;
}

export interface CreateEvalRuntime {
  /**
   * Optional author override. By default Ori runs its production headless
   * author harness. An override may launch provider subprocesses, but must not
   * invoke the Ori CLI as its integration boundary.
   */
  readonly runAuthorTurn?: (
    input: CreateEvalAuthorTurnInput,
  ) => Promise<CreateEvalAuthorTurnResult>;
  /** Root under which deterministic per-repository state directories live. */
  readonly stateRoot?: string;
  /** Complete gateway/credential environment passed to the author adapter. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly clock?: {
    readonly now: () => Date;
  };
  readonly credential?: {
    readonly check: (input: CreateEvalCredentialInput) => Promise<CreateEvalCredentialResult>;
  };
  readonly repository?: {
    readonly resolveRoot: (requested?: string) => Promise<string>;
  };
  /** Production adapter overrides, primarily for embedding tests. */
  readonly production?: ProductionAuthorTurnAdapterOptions;
  /**
   * Optional argv installed as `ori` inside the private author workspace.
   * This is only for harnesses whose shell tools still follow the shipped
   * create-eval text literally. Omit it when the author adapter supplies eval
   * execution without a command shim.
   */
  readonly evalCommand?: readonly [string, ...string[]];
}

export interface CreateEvalToolInput {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory: string;
}

export interface CreateEvalToolResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

export interface ProductionHeadlessAuthorInput extends CreateEvalAuthorTurnInput {
  readonly homeDirectory: string;
}

export interface ProductionAuthorTurnAdapterOptions {
  /**
   * Optional low-level author-session seam. The default directly runs Ori's
   * production headless code session.
   */
  readonly runHeadlessAuthor?: (
    input: ProductionHeadlessAuthorInput,
  ) => Promise<CreateEvalAuthorTurnResult>;
  /** Override only for embedding/tests; defaults to Ori's dedicated eval worker. */
  readonly evalToolCommand?: readonly [string, ...string[]];
}

export interface ProductionAuthorTurnAdapter {
  readonly evalCommand: readonly [string, ...string[]];
  readonly runAuthorTurn: (
    input: CreateEvalAuthorTurnInput,
  ) => Promise<CreateEvalAuthorTurnResult>;
}

export interface CreateEvalPrepareInput {
  readonly repository: string;
  readonly request?: string;
  readonly harness?: CreateEvalAuthorHarness;
  readonly model?: string;
  readonly judgeModel?: string;
  readonly existing?: CreateEvalExistingChoice;
}

export interface CreateEvalRunInput {
  readonly repository?: string;
  readonly runDirectory?: string;
}

export interface CreateEvalAnswerInput extends CreateEvalRunInput {
  readonly answer: string;
}

export interface CreateEvalStatusInput extends CreateEvalRunInput {}

export interface CreateEvalAuthoring {
  readonly prepare: (input: CreateEvalPrepareInput) => Promise<CreateEvalResult>;
  readonly run: (input: CreateEvalRunInput) => Promise<CreateEvalResult>;
  readonly answer: (input: CreateEvalAnswerInput) => Promise<CreateEvalResult>;
  readonly status: (input: CreateEvalStatusInput) => Promise<CreateEvalResult>;
  readonly manifest: () => Promise<CreateEvalResult>;
  readonly skill: () => Promise<string>;
}

export declare const createEvalAuthoring: (runtime: CreateEvalRuntime) => CreateEvalAuthoring;
export declare const createProductionAuthorTurnAdapter: (
  options?: ProductionAuthorTurnAdapterOptions,
) => ProductionAuthorTurnAdapter;
export declare const runEvalTool: (input: CreateEvalToolInput) => Promise<CreateEvalToolResult>;
