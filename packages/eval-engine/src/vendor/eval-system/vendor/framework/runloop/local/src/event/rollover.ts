import type { SessionId } from "../../../../contracts/internal/src/ids.ts";
import type { RuntimeSessionSnapshot } from "../../../../contracts/internal/src/runtime/session-snapshot-types.ts";

/**
 * Rollover compaction (ROUTEKIT_EVAL-471): when a session's context is nearly full — or
 * the harness's own compaction failed / does not exist — the daemon asks the
 * old session for a structured handoff summary, then re-seeds a FRESH session
 * with it, linked via parentSessionId. Pure planning and prompt helpers here;
 * the orchestration lives in daemon-invoke.
 */

const ROLLOVER_MODE_ENV = "ROUTEKIT_EVAL_COMPACTION_ROLLOVER";
const ROLLOVER_THRESHOLD_ENV = "ROUTEKIT_EVAL_COMPACTION_ROLLOVER_THRESHOLD";

// 0.85 leaves headroom for the summary turn itself to fit; community
// convergence is that 95%-style triggers fire too late (ROUTEKIT_EVAL-471 research).
const DEFAULT_ROLLOVER_THRESHOLD = 0.85;

type RolloverMode = "auto" | "manual" | "off";

interface RolloverConfig {
  readonly mode: RolloverMode;
  readonly threshold: number;
}

const parseMode = (value: string | undefined): RolloverMode => {
  if (value === "off" || value === "manual" || value === "auto") {
    return value;
  }
  return "auto";
};

const parseThreshold = (value: string | undefined): number => {
  const parsed = value === undefined ? Number.NaN : Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
    return DEFAULT_ROLLOVER_THRESHOLD;
  }
  return parsed;
};

/**
 * Env-resolved rollover policy. `auto` (the default) exists for unattended
 * Slack sessions; `manual` limits rollover to the /compact fallback and
 * overflow recovery stays off entirely under `off`.
 */
export const resolveRolloverConfig = (
  env: NodeJS.ProcessEnv
): RolloverConfig => ({
  mode: parseMode(env[ROLLOVER_MODE_ENV]?.trim().toLowerCase()),
  threshold: parseThreshold(env[ROLLOVER_THRESHOLD_ENV]),
});

interface RolloverPlan {
  readonly cause?: "overflow" | "threshold" | undefined;
  readonly trigger: "automatic" | "manual";
}

// Without both a context window and a reported occupancy, the planner never
// estimates: the threshold trigger stays off (overflow and manual still work).
const isPastRolloverThreshold = (input: {
  readonly config: RolloverConfig;
  readonly contextWindow: number | undefined;
  readonly snapshot: RuntimeSessionSnapshot;
}): boolean =>
  input.contextWindow !== undefined &&
  input.snapshot.lastContextTokens !== undefined &&
  input.snapshot.lastContextTokens >=
    input.contextWindow * input.config.threshold;

/**
 * Decide whether the incoming turn should roll the session over first.
 * Everything unknown degrades to `null` — exactly today's behavior.
 */
export const planRollover = (input: {
  readonly config: RolloverConfig;
  readonly contextWindow: number | undefined;
  readonly force: boolean;
  readonly snapshot: RuntimeSessionSnapshot | undefined;
}): RolloverPlan | null => {
  const { config, contextWindow, force, snapshot } = input;
  if (config.mode === "off" || snapshot === undefined) {
    return null;
  }
  if (force) {
    return { trigger: "manual" };
  }
  if (config.mode !== "auto") {
    return null;
  }
  if (snapshot.pendingRollover !== undefined) {
    return {
      cause: "overflow",
      trigger: "automatic",
    };
  }
  if (
    isPastRolloverThreshold({
      config,
      contextWindow,
      snapshot,
    })
  ) {
    return {
      cause: "threshold",
      trigger: "automatic",
    };
  }
  return null;
};

/**
 * The fixed summarization prompt sent to the OLD session as a normal turn.
 * Structured sections (the shape pi/gemini-cli/OpenCode converged on) beat
 * freeform summaries for handoff fidelity.
 */
export const buildSummaryPrompt = (): string =>
  [
    "This session is close to its context limit; the conversation will continue in a fresh session seeded with your summary.",
    "Write a handoff summary with exactly these sections:",
    "",
    "## Goal",
    "What the user is ultimately trying to do.",
    "## Done",
    "Work completed: decisions made, files touched, results.",
    "## In progress",
    "The most recent work and any partial state.",
    "## Next steps",
    "In order.",
    "## Constraints & key context",
    "Paths, facts, preferences, and pitfalls the next session must know.",
    "",
    "Write only the summary — no preamble, no tool calls.",
  ].join("\n");

/**
 * The fresh session's first prompt: the handoff summary, the original task
 * framing, a machine-readable pointer to the old session, and the user's
 * actual message — one turn, so the user's prompt is never sacrificed to the
 * rollover.
 */
export const buildRolloverSeedPrompt = (input: {
  readonly baseUrl?: string | undefined;
  readonly oldSessionId: SessionId;
  readonly originalPrompt: string | undefined;
  readonly summary: string;
  readonly userPrompt: string;
}): string => {
  const api = input.baseUrl ?? "";
  const lines: string[] = [
    "This session continues a previous conversation that reached its context limit.",
    "",
    "Handoff summary of the previous session:",
    "",
    input.summary.trim(),
    "",
  ];
  if (input.originalPrompt !== undefined) {
    lines.push(
      "The original request that started the conversation was:",
      "",
      input.originalPrompt,
      ""
    );
  }
  lines.push(
    `The previous session id is \`${input.oldSessionId}\`. Its full event history: GET ${api}/api/events?sessionId=${input.oldSessionId} — and every earlier session in this chain: GET ${api}/api/sessions/${input.oldSessionId}/lineage.`,
    "Fetch those endpoints (curl works) whenever this summary lacks a detail you need from the earlier conversation.",
    ""
  );
  // A bare /compact carries no user message; ending on the instruction keeps
  // the model continuing the work instead of replying to a synthetic prompt.
  const userPrompt = input.userPrompt.trim();
  if (userPrompt.length === 0) {
    lines.push(
      "Continue seamlessly — do not re-introduce yourself or redo completed work; pick the task back up from the summary above."
    );
  } else {
    lines.push(
      "Continue seamlessly — do not re-introduce yourself or redo completed work. The user's next message:",
      "",
      userPrompt
    );
  }
  return lines.join("\n");
};

export type { RolloverConfig, RolloverMode, RolloverPlan };
