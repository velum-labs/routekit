import type {
  AgentRuntimeEvent as AuthorAgentRuntimeEvent,
  AgentRuntimeRawEvent,
  RuntimeUsage,
} from "../../../author/src/index.ts";
import type {
  HarnessName,
  RunId,
  RuntimeEventId,
  SessionId,
  TurnId,
} from "../ids.ts";

export interface AgentRuntimeEventMetadata {
  readonly createdAt: string;
  readonly eventId: RuntimeEventId;
  readonly harness: HarnessName;
  readonly itemId?: string | undefined;
  readonly model?: string | null | undefined;
  /**
   * The session this event's session was forked from (Fork Thread, RFC
   * 0003). Carried on a forked session's events so a subscriber tailing the
   * child can resolve the parent thread without a separate snapshot lookup.
   * Absent on root sessions.
   */
  readonly parentSessionId?: SessionId | undefined;
  readonly runId: RunId;
  readonly sessionId?: SessionId | undefined;
  readonly turnId?: TurnId | undefined;
}

export type AgentRuntimeEvent = AuthorAgentRuntimeEvent &
  AgentRuntimeEventMetadata;
export type { AgentRuntimeRawEvent, RuntimeUsage };
