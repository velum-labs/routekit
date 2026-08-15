import { Schema } from "effect";

import type {
  HarnessName,
  RunId,
  SessionId,
  TurnId,
} from "../ids.ts";

export const PendingRolloverReasonSchema = Schema.Literals([
  "compaction-failed",
  "overflow",
]);
export type PendingRolloverReason = typeof PendingRolloverReasonSchema.Type;

export interface RuntimeSessionSnapshot {
  readonly completedTurns: number;
  readonly failedTurns: number;
  readonly firstSeenAt: string;
  readonly harness: HarnessName;
  /**
   * Context occupancy reported by the session's last terminal event
   * (RuntimeUsage.contextTokens) and the model it ran — the rollover
   * threshold inputs. Absent until a terminal event carries usage.
   *
   * `optionalKey` in the backing schema (`RuntimeSessionSnapshotSchema`), so the
   * key is absent — not present-and-undefined — when there is no value; the
   * builder omits it on undefined and the HttpApi success channel decodes to that
   * exact shape. Declared `?: X` (not `?: X | undefined`) to match.
   */
  readonly lastContextTokens?: number;
  readonly lastEventType: string;
  readonly lastUsageModel?: string;
  /**
   * The session this one was forked from (Fork Thread, RFC 0003). Present
   * only on sessions created by fork-thread; absent (never an empty string)
   * on root sessions. Immutable once set.
   */
  readonly parentSessionId?: SessionId;
  /**
   * Set when the session's context is known to be unusable without a rollover:
   * a terminal failure matched the context-overflow table, or the harness
   * reported a failed compaction. Cleared by a later successful turn or
   * completed compaction. Derived state, rebuilt from the journal.
   */
  readonly pendingRollover?: PendingRolloverReason;
  readonly runIds: readonly RunId[];
  readonly sessionId: SessionId;
  readonly turnIds: readonly TurnId[];
  readonly updatedAt: string;
}
