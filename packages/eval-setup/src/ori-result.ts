/**
 * Structural Ori library result. RouteKit setup persists and relays this JSON
 * without importing the eval-engine authoring module.
 */
export type OriEvalResult = {
  readonly ok: boolean;
  readonly status?: string;
  readonly runDirectory?: string;
  readonly scratchWorkspace?: string;
  readonly tag?: string;
  readonly prompt?: string;
  readonly question?: string;
  readonly context?: string;
  readonly options?: unknown;
  readonly accepted?: boolean;
  readonly state?: unknown;
  readonly evalRuns?: unknown;
  readonly evalRunTotals?: unknown;
  readonly attemptTotals?: unknown;
  readonly error?: string;
  readonly [key: string]: unknown;
};

export type OriEvalAuthoringApi = {
  readonly prepare: (input: {
    readonly repository: string;
    readonly request?: string;
    readonly harness?: "pi" | "claude" | "codex";
    readonly model?: string;
    readonly judgeModel?: string;
    readonly existing?: "resume" | "archive" | "stop";
  }) => Promise<OriEvalResult>;
  readonly run: (input: {
    readonly repository?: string;
    readonly runDirectory?: string;
  }) => Promise<OriEvalResult>;
  readonly answer: (input: {
    readonly answer: string;
    readonly repository?: string;
    readonly runDirectory?: string;
  }) => Promise<OriEvalResult>;
  readonly status: (input: {
    readonly repository?: string;
    readonly runDirectory?: string;
  }) => Promise<OriEvalResult>;
};
