import type { AgentFailure } from "./errors/agent-failure.ts";
import type { AgentSessionItemStatus } from "./agent-session/index.ts";
import type { RuntimeUsage } from "./agent-usage.ts";

type ValueOf<T> = T[keyof T];
export const AgentRuntimeEventTag = {
  AssistantTextDelta: "assistant.text.delta",
  CompactionCancelled: "compaction.cancelled",
  CompactionCompleted: "compaction.completed",
  CompactionFailed: "compaction.failed",
  CompactionStarted: "compaction.started",
  ContentDelta: "content.delta",
  ElicitationRequested: "elicitation.requested",
  ElicitationResolved: "elicitation.resolved",
  ItemCompleted: "item.completed",
  ItemStarted: "item.started",
  ItemUpdated: "item.updated",
  PermissionRequested: "permission.requested",
  PermissionResolved: "permission.resolved",
  ReasoningDelta: "reasoning.delta",
  RetryCancelled: "retry.cancelled",
  RetryCompleted: "retry.completed",
  RetryFailed: "retry.failed",
  RetryScheduled: "retry.scheduled",
  RunStarted: "run.started",
  RuntimeError: "runtime.error",
  RuntimeWarning: "runtime.warning",
  SessionFailed: "session.failed",
  SessionStarted: "session.started",
  SessionSucceeded: "session.succeeded",
  ToolFailed: "tool.failed",
  ToolOutputDelta: "tool.output.delta",
  ToolProgress: "tool.progress",
  ToolResultFailed: "tool.result.failed",
  ToolResultSucceeded: "tool.result.succeeded",
  ToolStarted: "tool.started",
  ToolSucceeded: "tool.succeeded",
  TurnFailed: "turn.failed",
  TurnStarted: "turn.started",
  TurnSucceeded: "turn.succeeded",
} as const;
export type AgentRuntimeEventTag = ValueOf<typeof AgentRuntimeEventTag>;

/**
 * The kinds of option an ACP `session/request_permission` offers, projected as
 * the safe vocabulary a permission prompt journals. Raw provider payloads do
 * not cross the author seam.
 */
const permissionOptionKinds = [
  "allow_always",
  "allow_once",
  "reject_always",
  "reject_once",
] as const;
export type PermissionOptionKind = (typeof permissionOptionKinds)[number];

/**
 * The value type of a single field an elicitation form requests. This is a
 * summary vocabulary only; accepted values are not carried on runtime events.
 */
const elicitationFieldTypes = [
  "array",
  "boolean",
  "integer",
  "number",
  "string",
  "unknown",
] as const;
export type ElicitationFieldType = (typeof elicitationFieldTypes)[number];
export type ElicitationFieldDefault =
  | boolean
  | number
  | readonly string[]
  | string;

/**
 * The terminal action a form elicitation settles on. Decline and cancel carry
 * no accepted content.
 */
const elicitationResolvedActions = ["accept", "cancel", "decline"] as const;
export type ElicitationResolvedAction =
  (typeof elicitationResolvedActions)[number];

/** A journal-safe summary of one requested elicitation field. */
export interface ElicitationFieldSummary {
  readonly default?: ElicitationFieldDefault | undefined;
  readonly description?: string | undefined;
  readonly name: string;
  /** Fixed choices offered by an enum field; absent for free-form input. */
  readonly options?: readonly string[] | undefined;
  readonly required?: boolean | undefined;
  readonly type: ElicitationFieldType;
}

export type AgentRuntimeRawSource = string;

export interface AgentRuntimeRawEvent {
  readonly payload: unknown;
  readonly source: AgentRuntimeRawSource;
}

/**
 * Metadata the engine stamps on observed runtime events. Contributions emit
 * the same union without setting these engine-owned fields.
 */
export type AgentRuntimeHarnessName = string;
/**
 * The four-field envelope every {@link AgentRuntimeEvent} carries: the engine
 * stamps `harness`/`model`/`raw` on the observe side, and each member supplies
 * its own literal `type` tag plus a tag-specific `payload`. Factoring the
 * envelope out keeps the ~20 union members to their distinguishing payloads
 * without re-declaring the metadata on each one. Because `type` stays a literal
 * on every instance, `Extract<AgentRuntimeEvent, { type: … }>` and `switch`
 * narrowing behave exactly as they did with the fully hand-written members.
 */
interface AgentRuntimeEventOf<Tag extends AgentRuntimeEventTag, Payload> {
  readonly harness?: AgentRuntimeHarnessName | undefined;
  readonly model?: string | null | undefined;
  readonly payload: Payload;
  readonly raw?: AgentRuntimeRawEvent | undefined;
  readonly type: Tag;
}

interface ContentDeltaPayload {
  readonly contentIndex?: number | undefined;
  readonly delta: string;
  readonly itemId?: string | undefined;
}

export type AgentRuntimeEvent =
  | AgentRuntimeEventOf<
      typeof AgentRuntimeEventTag.RunStarted,
      {
        readonly cwd?: string | undefined;
        readonly model?: string | null | undefined;
        readonly prompt: string;
        readonly userId?: string | undefined;
      }
    >
  | AgentRuntimeEventOf<
      typeof AgentRuntimeEventTag.SessionStarted,
      {
        readonly sessionId?: string | undefined;
      }
    >
  | AgentRuntimeEventOf<
      typeof AgentRuntimeEventTag.SessionSucceeded,
      {
        readonly sessionId?: string | undefined;
        readonly usage?: RuntimeUsage | undefined;
      }
    >
  | AgentRuntimeEventOf<
      typeof AgentRuntimeEventTag.SessionFailed,
      {
        readonly failure: AgentFailure;
        readonly sessionId?: string | undefined;
        readonly usage?: RuntimeUsage | undefined;
      }
    >
  | AgentRuntimeEventOf<
      typeof AgentRuntimeEventTag.TurnStarted,
      {
        readonly prompt?: string | undefined;
      }
    >
  | AgentRuntimeEventOf<
      typeof AgentRuntimeEventTag.TurnSucceeded,
      {
        readonly usage?: RuntimeUsage | undefined;
      }
    >
  | AgentRuntimeEventOf<
      typeof AgentRuntimeEventTag.TurnFailed,
      {
        readonly failure: AgentFailure;
        readonly usage?: RuntimeUsage | undefined;
      }
    >
  | AgentRuntimeEventOf<
      typeof AgentRuntimeEventTag.AssistantTextDelta,
      ContentDeltaPayload
    >
  | AgentRuntimeEventOf<
      typeof AgentRuntimeEventTag.ReasoningDelta,
      ContentDeltaPayload
    >
  | AgentRuntimeEventOf<
      typeof AgentRuntimeEventTag.ToolOutputDelta,
      ContentDeltaPayload
    >
  | AgentRuntimeEventOf<
      typeof AgentRuntimeEventTag.ContentDelta,
      ContentDeltaPayload
    >
  | AgentRuntimeEventOf<
      | typeof AgentRuntimeEventTag.ItemCompleted
      | typeof AgentRuntimeEventTag.ItemStarted
      | typeof AgentRuntimeEventTag.ItemUpdated,
      {
        readonly data?: unknown;
        readonly detail?: string | undefined;
        readonly itemId?: string | undefined;
        readonly itemType: string;
        readonly status?: AgentSessionItemStatus | undefined;
        readonly title?: string | undefined;
      }
    >
  | AgentRuntimeEventOf<
      typeof AgentRuntimeEventTag.ToolStarted,
      {
        readonly input?: unknown;
        readonly name: string;
        readonly toolCallId?: string | undefined;
      }
    >
  | AgentRuntimeEventOf<
      typeof AgentRuntimeEventTag.ToolProgress,
      {
        readonly input?: unknown;
        readonly name?: string | undefined;
        readonly partialResult?: unknown;
        readonly toolCallId?: string | undefined;
      }
    >
  | AgentRuntimeEventOf<
      typeof AgentRuntimeEventTag.ToolSucceeded,
      {
        readonly name?: string | undefined;
        readonly result?: unknown;
        readonly toolCallId?: string | undefined;
      }
    >
  | AgentRuntimeEventOf<
      typeof AgentRuntimeEventTag.ToolFailed,
      {
        readonly name?: string | undefined;
        readonly result?: unknown;
        readonly toolCallId?: string | undefined;
      }
    >
  | AgentRuntimeEventOf<
      typeof AgentRuntimeEventTag.ToolResultSucceeded,
      {
        readonly content?: unknown;
        readonly name?: string | undefined;
        readonly toolCallId?: string | undefined;
      }
    >
  | AgentRuntimeEventOf<
      typeof AgentRuntimeEventTag.ToolResultFailed,
      {
        readonly content?: unknown;
        readonly name?: string | undefined;
        readonly toolCallId?: string | undefined;
      }
    >
  | AgentRuntimeEventOf<
      typeof AgentRuntimeEventTag.PermissionRequested,
      {
        readonly correlationId: string;
        readonly operation: string;
        readonly options: readonly PermissionOptionKind[];
        readonly sessionId?: string | undefined;
        readonly toolCallId?: string | undefined;
      }
    >
  | AgentRuntimeEventOf<
      typeof AgentRuntimeEventTag.PermissionResolved,
      | {
          readonly correlationId: string;
          readonly optionId: string;
          readonly outcome: "selected";
        }
      | {
          readonly correlationId: string;
          readonly outcome: "cancelled";
        }
    >
  | AgentRuntimeEventOf<
      typeof AgentRuntimeEventTag.ElicitationRequested,
      {
        readonly correlationId: string;
        readonly fields: readonly ElicitationFieldSummary[];
        readonly message: string;
        readonly requestId?: string | undefined;
        readonly sessionId?: string | undefined;
        readonly toolCallId?: string | undefined;
      }
    >
  | AgentRuntimeEventOf<
      typeof AgentRuntimeEventTag.ElicitationResolved,
      {
        readonly action: ElicitationResolvedAction;
        readonly correlationId: string;
      }
    >
  | AgentRuntimeEventOf<
      typeof AgentRuntimeEventTag.RuntimeError,
      {
        readonly failure: AgentFailure;
      }
    >
  | AgentRuntimeEventOf<
      typeof AgentRuntimeEventTag.RuntimeWarning,
      {
        readonly detail?: unknown;
        readonly message: string;
      }
    >
  | AgentRuntimeEventOf<
      | typeof AgentRuntimeEventTag.CompactionStarted
      | typeof AgentRuntimeEventTag.CompactionCancelled,
      {
        readonly cause?: "overflow" | "threshold" | undefined;
        readonly trigger: "automatic" | "manual" | "unknown";
      }
    >
  | AgentRuntimeEventOf<
      typeof AgentRuntimeEventTag.CompactionCompleted,
      {
        readonly cause?: "overflow" | "threshold" | undefined;
        readonly durationMs?: number | undefined;
        readonly tokensAfter?: number | undefined;
        readonly tokensBefore?: number | undefined;
        readonly trigger: "automatic" | "manual" | "unknown";
        readonly willRetry?: boolean | undefined;
      }
    >
  | AgentRuntimeEventOf<
      typeof AgentRuntimeEventTag.CompactionFailed,
      {
        readonly cause?: "overflow" | "threshold" | undefined;
        readonly failure: AgentFailure;
        readonly trigger: "automatic" | "manual" | "unknown";
        readonly willRetry?: boolean | undefined;
      }
    >
  | AgentRuntimeEventOf<
      typeof AgentRuntimeEventTag.RetryScheduled,
      {
        readonly attempt?: number | undefined;
        readonly delayMs?: number | undefined;
        readonly maxAttempts?: number | undefined;
        readonly message?: string | undefined;
      }
    >
  | AgentRuntimeEventOf<
      typeof AgentRuntimeEventTag.RetryCompleted,
      {
        readonly attempt?: number | undefined;
      }
    >
  | AgentRuntimeEventOf<
      typeof AgentRuntimeEventTag.RetryFailed,
      {
        readonly attempt?: number | undefined;
        readonly failure: AgentFailure;
      }
    >
  | AgentRuntimeEventOf<
      typeof AgentRuntimeEventTag.RetryCancelled,
      {
        readonly attempt?: number | undefined;
      }
    >;

/**
 * Narrow an {@link AgentRuntimeEvent} to the assistant text delta variant —
 * the prose stream every surface renders. Shared so consumers do not each
 * restate the Extract-by-tag predicate. Generic so refinements of the event
 * union (e.g. the internal metadata-carrying event) keep their extra fields
 * after narrowing.
 */
export const isAssistantTextDelta = <Event extends AgentRuntimeEvent>(
  event: Event
): event is Extract<
  Event,
  { readonly type: typeof AgentRuntimeEventTag.AssistantTextDelta }
> => event.type === AgentRuntimeEventTag.AssistantTextDelta;
