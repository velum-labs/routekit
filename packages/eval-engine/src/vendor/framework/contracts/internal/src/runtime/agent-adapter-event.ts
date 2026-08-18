import { Schema } from "effect";

import { AcpSessionUpdate } from "../acp/protocol/session-update.ts";

import {
  AgentEventSafeText,
  NonNegativeInt,
  PositiveInt,
} from "./schema-primitives.ts";

const AcpSessionUpdateReceived = Schema.Struct({
  event: Schema.Literal("acp.session_update"),
  update: AcpSessionUpdate,
}).annotate({ identifier: "AcpSessionUpdateReceived" });

const RetryScheduledObservation = Schema.Struct({
  attempt: Schema.optionalKey(PositiveInt),
  delayMs: Schema.optionalKey(NonNegativeInt),
  event: Schema.Literal("retry.scheduled"),
  maxAttempts: Schema.optionalKey(PositiveInt),
  message: Schema.optionalKey(AgentEventSafeText),
}).annotate({ identifier: "RetryScheduledObservation" });

const RetryCompletedObservation = Schema.Struct({
  attempt: Schema.optionalKey(PositiveInt),
  event: Schema.Literal("retry.completed"),
}).annotate({ identifier: "RetryCompletedObservation" });

const RetryFailedObservation = Schema.Struct({
  attempt: Schema.optionalKey(PositiveInt),
  event: Schema.Literal("retry.failed"),
  message: Schema.optionalKey(AgentEventSafeText),
}).annotate({ identifier: "RetryFailedObservation" });

const RetryCancelledObservation = Schema.Struct({
  attempt: Schema.optionalKey(PositiveInt),
  event: Schema.Literal("retry.cancelled"),
}).annotate({ identifier: "RetryCancelledObservation" });

const CompactionTrigger = Schema.Literals(["manual", "automatic", "unknown"]);
const CompactionCause = Schema.Literals(["threshold", "overflow"]);
const compactionFields = {
  cause: Schema.optionalKey(CompactionCause),
  trigger: CompactionTrigger,
} as const;

const CompactionStartedObservation = Schema.Struct({
  ...compactionFields,
  event: Schema.Literal("compaction.started"),
}).annotate({ identifier: "CompactionStartedObservation" });

const CompactionCompletedObservation = Schema.Struct({
  ...compactionFields,
  durationMs: Schema.optionalKey(NonNegativeInt),
  event: Schema.Literal("compaction.completed"),
  tokensAfter: Schema.optionalKey(NonNegativeInt),
  tokensBefore: Schema.optionalKey(NonNegativeInt),
  willRetry: Schema.optionalKey(Schema.Boolean),
}).annotate({ identifier: "CompactionCompletedObservation" });

const CompactionFailedObservation = Schema.Struct({
  ...compactionFields,
  event: Schema.Literal("compaction.failed"),
  message: Schema.optionalKey(AgentEventSafeText),
  willRetry: Schema.optionalKey(Schema.Boolean),
}).annotate({ identifier: "CompactionFailedObservation" });

const CompactionCancelledObservation = Schema.Struct({
  ...compactionFields,
  event: Schema.Literal("compaction.cancelled"),
}).annotate({ identifier: "CompactionCancelledObservation" });

const AgentAdapterObservation = Schema.Union([
  RetryScheduledObservation,
  RetryCompletedObservation,
  RetryFailedObservation,
  RetryCancelledObservation,
  CompactionStartedObservation,
  CompactionCompletedObservation,
  CompactionFailedObservation,
  CompactionCancelledObservation,
])
  .annotate({ identifier: "AgentAdapterObservation" })
  .pipe(Schema.toTaggedUnion("event"));

const AgentAdapterEvent = Schema.Union([
  AcpSessionUpdateReceived,
  ...AgentAdapterObservation.members,
])
  .annotate({ identifier: "AgentAdapterEvent" })
  .pipe(Schema.toTaggedUnion("event"));

export {
  AcpSessionUpdateReceived,
  AgentAdapterEvent,
  AgentAdapterObservation,
  CompactionCancelledObservation,
  CompactionCause,
  CompactionCompletedObservation,
  CompactionFailedObservation,
  CompactionStartedObservation,
  CompactionTrigger,
  RetryCancelledObservation,
  RetryCompletedObservation,
  RetryFailedObservation,
  RetryScheduledObservation,
};
export type AcpSessionUpdateReceived = typeof AcpSessionUpdateReceived.Type;
export type AgentAdapterEvent = typeof AgentAdapterEvent.Type;
export type AgentAdapterObservation = typeof AgentAdapterObservation.Type;
export type CompactionCancelledObservation =
  typeof CompactionCancelledObservation.Type;
export type CompactionCompletedObservation =
  typeof CompactionCompletedObservation.Type;
export type CompactionFailedObservation =
  typeof CompactionFailedObservation.Type;
export type CompactionStartedObservation =
  typeof CompactionStartedObservation.Type;
export type RetryCancelledObservation = typeof RetryCancelledObservation.Type;
export type RetryCompletedObservation = typeof RetryCompletedObservation.Type;
export type RetryFailedObservation = typeof RetryFailedObservation.Type;
export type RetryScheduledObservation = typeof RetryScheduledObservation.Type;
