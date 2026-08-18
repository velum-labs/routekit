import type { AgentRuntimeEvent } from "./agent-runtime-event-types.ts";
import type { RuntimeJournalEntry } from "./journal-entry.ts";

import { agentRuntimeEventSessionId as extractSessionId } from "../../../author/src/runtime-normalizer.ts";
import { SessionId } from "../ids.ts";

/**
 * The session a runtime event belongs to, branded. The extraction rule itself
 * lives at the author tier ({@link extractSessionId}) so builtins — which may
 * not import internal contracts — share the exact same rule. Returns
 * `undefined` for an event with no derivable session (e.g. a pre-session
 * failure). Shared by the session store projection, the CLI metadata sidecar,
 * and the daemon's `?sessionId=` event filters (Fork Thread, RFC 0003 /
 * RFC 0008) so all agree on exactly one extraction rule.
 */
export const agentRuntimeEventSessionId = (
  event: AgentRuntimeEvent
): SessionId | undefined => {
  const sessionId = extractSessionId(event);
  return sessionId === undefined ? undefined : SessionId.make(sessionId);
};

/** The session a journal entry belongs to (see {@link agentRuntimeEventSessionId}). */
export const journalEntrySessionId = (
  entry: RuntimeJournalEntry
): SessionId | undefined => agentRuntimeEventSessionId(entry.event);
