// The harness-neutral usage shape, in its own module rather than inside the
// event union: it is read on its own by surfaces that never touch the union (the
// chat TUI footer, the OTel metrics, the eval report), and `agent-event.ts` was
// at the architecture file-length cap.

/**
 * Harness-neutral token/cost usage for a completed run, normalized from each
 * harness's own result shape (Claude's `result.usage` + `modelUsage`, pi's
 * `agent_end`/`turn_end` `usage`). Surfaces (e.g. the chat TUI footer) read this
 * instead of reaching into harness-specific `raw.payload`, so any harness that
 * reports usage lights up the same UI. Token counts default to 0; `costUsd` and
 * `model` are `undefined` when the harness does not report them.
 */
export interface RuntimeUsage {
  readonly cacheCreationTokens: number;
  readonly cacheReadTokens: number;
  /** Tokens occupying the context after the run's FINAL model call (not cumulative) — the rollover threshold signal. */
  readonly contextTokens?: number | undefined;
  readonly costUsd?: number | undefined;
  readonly generationId?: string | undefined;
  readonly inputTokens: number;
  readonly model?: string | undefined;
  readonly outputTokens: number;
}
