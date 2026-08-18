import type { ValueOf } from "../../../../utils/core/src/types.ts";

export const AgentSessionContentRole = {
  Assistant: "assistant",
  Reasoning: "reasoning",
  User: "user",
} as const;

export const AgentSessionLifecycleEvent = {
  RetryScheduled: "retry.scheduled",
  RetryCompleted: "retry.completed",
  RetryFailed: "retry.failed",
  RetryCancelled: "retry.cancelled",
  CompactionStarted: "compaction.started",
  CompactionCompleted: "compaction.completed",
  CompactionFailed: "compaction.failed",
  CompactionCancelled: "compaction.cancelled",
} as const;

export const AGENT_SESSION_CONTENT_ROLES = [
  AgentSessionContentRole.Assistant,
  AgentSessionContentRole.Reasoning,
  AgentSessionContentRole.User,
] as const;

export const AGENT_SESSION_LIFECYCLE_EVENTS = [
  AgentSessionLifecycleEvent.RetryScheduled,
  AgentSessionLifecycleEvent.RetryCompleted,
  AgentSessionLifecycleEvent.RetryFailed,
  AgentSessionLifecycleEvent.RetryCancelled,
  AgentSessionLifecycleEvent.CompactionStarted,
  AgentSessionLifecycleEvent.CompactionCompleted,
  AgentSessionLifecycleEvent.CompactionFailed,
  AgentSessionLifecycleEvent.CompactionCancelled,
] as const;

export const AGENT_SESSION_RUNTIME_ITEM_TYPES = [
  "plan",
  "available_commands",
  "current_mode",
  "config_options",
  "session_info",
  "usage",
] as const;

export const AgentSessionItemStatus = {
  Completed: "completed",
  Declined: "declined",
  Failed: "failed",
  InProgress: "inProgress",
} as const;
export type AgentSessionItemStatus = ValueOf<typeof AgentSessionItemStatus>;

export const AGENT_SESSION_TOOL_STATUSES = [
  AgentSessionItemStatus.InProgress,
  AgentSessionItemStatus.Completed,
  AgentSessionItemStatus.Failed,
] as const;

export const AGENT_SESSION_ITEM_STATUSES = [
  ...AGENT_SESSION_TOOL_STATUSES,
  AgentSessionItemStatus.Declined,
] as const;
