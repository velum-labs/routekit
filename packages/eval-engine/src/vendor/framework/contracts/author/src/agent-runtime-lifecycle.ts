import { Schema } from "effect";

const NonNegativeInt = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0)
).annotate({ identifier: "RuntimeLifecycleNonNegativeInt" });

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0)).annotate({
  identifier: "RuntimeLifecyclePositiveInt",
});

const CompactionTrigger = Schema.Literals(["manual", "automatic", "unknown"]);
const CompactionCause = Schema.Literals(["threshold", "overflow"]);

// Optional fields are `optionalKey(UndefinedOr(...))`, not bare `optionalKey`:
// harness projectors pass optional payload fields straight through, so a key
// can be present with an explicit `undefined` (the #694 regression) and the
// schema must treat that the same as an absent key.
const AgentRuntimeLifecyclePayloadFields = {
  compactionCancelled: {
    cause: Schema.optionalKey(Schema.UndefinedOr(CompactionCause)),
    trigger: CompactionTrigger,
  },
  compactionCompleted: {
    cause: Schema.optionalKey(Schema.UndefinedOr(CompactionCause)),
    durationMs: Schema.optionalKey(Schema.UndefinedOr(NonNegativeInt)),
    tokensAfter: Schema.optionalKey(Schema.UndefinedOr(NonNegativeInt)),
    tokensBefore: Schema.optionalKey(Schema.UndefinedOr(NonNegativeInt)),
    trigger: CompactionTrigger,
    willRetry: Schema.optionalKey(Schema.UndefinedOr(Schema.Boolean)),
  },
  compactionFailed: {
    cause: Schema.optionalKey(Schema.UndefinedOr(CompactionCause)),
    trigger: CompactionTrigger,
    willRetry: Schema.optionalKey(Schema.UndefinedOr(Schema.Boolean)),
  },
  compactionStarted: {
    cause: Schema.optionalKey(Schema.UndefinedOr(CompactionCause)),
    trigger: CompactionTrigger,
  },
  retryCancelled: {
    attempt: Schema.optionalKey(Schema.UndefinedOr(PositiveInt)),
  },
  retryCompleted: {
    attempt: Schema.optionalKey(Schema.UndefinedOr(PositiveInt)),
  },
  retryFailed: {
    attempt: Schema.optionalKey(Schema.UndefinedOr(PositiveInt)),
  },
  retryScheduled: {
    attempt: Schema.optionalKey(Schema.UndefinedOr(PositiveInt)),
    delayMs: Schema.optionalKey(Schema.UndefinedOr(NonNegativeInt)),
    maxAttempts: Schema.optionalKey(Schema.UndefinedOr(PositiveInt)),
    message: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
  },
} as const;

const RetryScheduledPayload = Schema.Struct({
  ...AgentRuntimeLifecyclePayloadFields.retryScheduled,
}).annotate({ identifier: "RetryScheduledPayload" });

const RetryCompletedPayload = Schema.Struct(
  AgentRuntimeLifecyclePayloadFields.retryCompleted
).annotate({ identifier: "RetryCompletedPayload" });

const RetryCancelledPayload = Schema.Struct(
  AgentRuntimeLifecyclePayloadFields.retryCancelled
).annotate({ identifier: "RetryCancelledPayload" });

const CompactionStartedPayload = Schema.Struct(
  AgentRuntimeLifecyclePayloadFields.compactionStarted
).annotate({
  identifier: "CompactionStartedPayload",
});

const CompactionCompletedPayload = Schema.Struct({
  ...AgentRuntimeLifecyclePayloadFields.compactionCompleted,
}).annotate({ identifier: "CompactionCompletedPayload" });

const CompactionCancelledPayload = Schema.Struct(
  AgentRuntimeLifecyclePayloadFields.compactionCancelled
).annotate({ identifier: "CompactionCancelledPayload" });

export {
  AgentRuntimeLifecyclePayloadFields,
  CompactionCancelledPayload,
  CompactionCause,
  CompactionCompletedPayload,
  CompactionStartedPayload,
  CompactionTrigger,
  RetryCancelledPayload,
  RetryCompletedPayload,
  RetryScheduledPayload,
};
export type CompactionCancelledPayload = typeof CompactionCancelledPayload.Type;
export type CompactionCompletedPayload = typeof CompactionCompletedPayload.Type;
export type CompactionStartedPayload = typeof CompactionStartedPayload.Type;
export type RetryCancelledPayload = typeof RetryCancelledPayload.Type;
export type RetryCompletedPayload = typeof RetryCompletedPayload.Type;
export type RetryScheduledPayload = typeof RetryScheduledPayload.Type;
