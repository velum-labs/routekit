import type { AgentRuntimeEvent } from "../../../../contracts/internal/src/runtime/agent-runtime-event-types.ts";
import type { RuntimeJournalEntry } from "../../../../contracts/internal/src/runtime/journal-entry.ts";

import {
  AgentRuntimeEventTag,
  isAssistantTextDelta,
} from "../../../../contracts/author/src/index.ts";
import { RuntimeValidationError } from "../../../../contracts/internal/src/errors.ts";
import { SessionId } from "../../../../contracts/internal/src/ids.ts";
import { journalEntrySessionId } from "../../../../contracts/internal/src/runtime/journal-entry-session.ts";

/**
 * Fork-thread runtime helpers (Fork Thread, RFC 0003). Pure functions the
 * daemon composes into the `agent.invoke` path: validate the fork directive,
 * summarize the parent thread from its journaled events, compose the child's
 * seed prompt (summary + a machine-readable parent pointer), and stamp lineage
 * onto the child's emitted events.
 *
 * The v1 summary is a deterministic **projection** of the parent's journal
 * (RFC 0003 permits either a projection or a dedicated summarization turn); a
 * turn-based summary can replace {@link summarizeParentThread} later without
 * touching the seed/lineage contract.
 */

const MAX_SUMMARY_CHARS = 4000;
const ELLIPSIS = "…";

interface ForkPlan {
  readonly parentSessionId: SessionId;
}

/**
 * Validate a fork directive against its command. Forking always mints a new
 * child, so pairing it with a resume `sessionId` is rejected. Returns the plan
 * when the directive is present and valid, `null` when there is no directive
 * (a normal, non-fork invoke), or fails with a validation error.
 */
const planFork = (command: {
  readonly sessionId?: SessionId | undefined;
  readonly fork?: { readonly parentSessionId: SessionId } | undefined;
}):
  | { readonly ok: true; readonly plan: ForkPlan | null }
  | { readonly ok: false; readonly error: RuntimeValidationError } => {
  if (command.fork === undefined) {
    return {
      ok: true,
      plan: null,
    };
  }
  if (command.sessionId !== undefined) {
    return {
      error: new RuntimeValidationError({
        cause: undefined,
        detail:
          "a fork directive and a resume sessionId are mutually exclusive: forking always mints a new child session",
      }),
      ok: false,
    };
  }
  if (command.fork.parentSessionId.length === 0) {
    return {
      error: new RuntimeValidationError({
        cause: undefined,
        detail: "fork.parentSessionId must be a non-empty session id",
      }),
      ok: false,
    };
  }
  return {
    ok: true,
    plan: { parentSessionId: command.fork.parentSessionId },
  };
};

/**
 * Whether the parent session is known to the daemon — it MUST have at least one
 * journaled event before a child may reference it, so a dangling backref is
 * never minted (RFC 0003, Lineage backref).
 */
const parentIsKnown = (
  entries: readonly RuntimeJournalEntry[],
  parentSessionId: SessionId
): boolean =>
  entries.some((entry) => journalEntrySessionId(entry) === parentSessionId);

const userPromptFromEvent = (
  event: RuntimeJournalEntry["event"]
): string | undefined => {
  let raw = "";
  if (event.type === AgentRuntimeEventTag.RunStarted) {
    raw = event.payload.prompt;
  } else if (event.type === AgentRuntimeEventTag.TurnStarted) {
    raw = event.payload.prompt ?? "";
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const MAX_FIRST_PROMPT_CHARS = 2000;

/**
 * The first user prompt journaled for a session, clamped — rollover uses it to
 * remind the re-seeded session what originally started the conversation.
 */
const firstSessionPrompt = (
  entries: readonly RuntimeJournalEntry[],
  sessionId: SessionId
): string | undefined => {
  for (const entry of entries) {
    if (journalEntrySessionId(entry) !== sessionId) {
      continue;
    }
    const prompt = userPromptFromEvent(entry.event);
    if (prompt !== undefined) {
      return prompt.length > MAX_FIRST_PROMPT_CHARS
        ? `${prompt.slice(0, MAX_FIRST_PROMPT_CHARS)}${ELLIPSIS}`
        : prompt;
    }
  }
  return undefined;
};

/**
 * Project a bounded, human-readable summary of a parent thread from its
 * journaled events: the prompts that drove it and the assistant text it
 * produced, in order, clamped to {@link MAX_SUMMARY_CHARS}. This is a seed, not
 * a replay — it is deliberately lossy, and the child uses the `parentSessionId`
 * backref to fetch anything the summary omits.
 */
const summarizeParentThread = (
  entries: readonly RuntimeJournalEntry[],
  parentSessionId: SessionId
): string => {
  const parts: string[] = [];
  let assistantRun = "";

  const flushAssistant = (): void => {
    const trimmed = assistantRun.trim();
    if (trimmed.length > 0) {
      parts.push(`Assistant: ${trimmed}`);
    }
    assistantRun = "";
  };

  for (const entry of entries) {
    if (journalEntrySessionId(entry) !== parentSessionId) {
      continue;
    }
    const { event } = entry;
    const prompt = userPromptFromEvent(event);
    if (prompt !== undefined) {
      flushAssistant();
      parts.push(`User: ${prompt}`);
    } else if (isAssistantTextDelta(event)) {
      assistantRun += event.payload.delta;
    }
  }
  flushAssistant();

  const summary = parts.join("\n");
  if (summary.length <= MAX_SUMMARY_CHARS) {
    return summary;
  }
  // Keep the tail — the most recent context is the most useful seed.
  return `${ELLIPSIS}${summary.slice(summary.length - MAX_SUMMARY_CHARS + ELLIPSIS.length)}`;
};

/**
 * Compose the child's first prompt: the parent summary framed as inherited
 * context, a machine-readable pointer to the parent thread (so an in-session
 * tool can retrieve parent detail on demand), and the fork instruction — the
 * task the child was forked to do. When the parent produced no summarizable
 * context, the summary block is omitted but the pointer is always present.
 */
const composeForkSeedPrompt = (input: {
  readonly parentSessionId: SessionId;
  readonly parentSummary: string;
  readonly forkInstruction: string;
}): string => {
  const lines: string[] = [];
  const summary = input.parentSummary.trim();
  if (summary.length > 0) {
    lines.push(
      "You were forked from another thread. Here is a summary of that thread's context so far:",
      "",
      summary,
      ""
    );
  } else {
    lines.push("You were forked from another thread.", "");
  }
  lines.push(
    `The thread you were forked from has session id \`${input.parentSessionId}\`. You can look it up for full detail via GET /api/events?sessionId=${input.parentSessionId} (its complete history) or GET /api/sessions (its snapshot).`,
    "",
    "Your task:",
    "",
    input.forkInstruction
  );
  return lines.join("\n");
};

/**
 * Stamp a child session's lineage onto one of its runtime events. Applied to
 * every event the forked run emits so a subscriber tailing the child can read
 * `parentSessionId` directly (RFC 0003 / RFC 0008), without a separate snapshot
 * lookup. Never overwrites a lineage already on the event.
 */
const stampLineage = (
  event: AgentRuntimeEvent,
  parentSessionId: SessionId
): AgentRuntimeEvent =>
  event.parentSessionId === undefined
    ? {
        ...event,
        parentSessionId,
      }
    : event;

export {
  composeForkSeedPrompt,
  firstSessionPrompt,
  parentIsKnown,
  planFork,
  SessionId,
  stampLineage,
  summarizeParentThread,
};
export type { ForkPlan };
