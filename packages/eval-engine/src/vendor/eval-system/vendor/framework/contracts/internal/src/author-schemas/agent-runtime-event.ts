import { Schema } from "effect";

/**
 * Effect Schema mirror of author-facing shapes from `@routekit-eval-contracts/author`.
 * Authors import the plain TypeScript types; the engine decodes against these
 * schemas. `AssertAssignable` keeps each schema Encoded type assignable to the
 * author contract so the two layers cannot drift.
 */
import type { AgentRuntimeEvent as AgentRuntimeEventType } from "../../../author/src/index.ts";

import { AgentRuntimeEventTag } from "../../../author/src/index.ts";
import { MAX_AGENT_FAILURE_TEXT_LENGTH } from "../../../author/src/errors/agent-failure.ts";
import {
  AGENT_FAILURE_CODE_LIST,
  AGENT_FAILURE_KINDS,
  AGENT_FAILURE_STAGES,
} from "../../../author/src/errors/agent-failure-codes.ts";
import {
  AgentRuntimeLifecyclePayloadFields,
  CompactionCancelledPayload,
  CompactionCompletedPayload,
  CompactionStartedPayload,
  RetryCancelledPayload,
  RetryCompletedPayload,
  RetryScheduledPayload,
} from "../../../author/src/agent-runtime-lifecycle.ts";
import {
  AGENT_SESSION_ITEM_STATUSES,
  AGENT_SESSION_TOOL_STATUSES,
} from "../../../author/src/agent-session/index.ts";

type AgentRuntimeEvent = AgentRuntimeEventType;

const RawEventSchema = Schema.Struct({
  payload: Schema.Unknown,
  source: Schema.String,
});

const RuntimeUsageSchema = Schema.Struct({
  cacheCreationTokens: Schema.Number,
  cacheReadTokens: Schema.Number,
  contextTokens: Schema.optionalKey(Schema.UndefinedOr(Schema.Number)),
  costUsd: Schema.optionalKey(Schema.UndefinedOr(Schema.Number)),
  inputTokens: Schema.Number,
  model: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
  outputTokens: Schema.Number,
});

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));

export const AgentFailureSchema = Schema.Struct({
  code: Schema.Literals(AGENT_FAILURE_CODE_LIST),
  kind: Schema.Literals(AGENT_FAILURE_KINDS),
  message: Schema.String.check(
    Schema.isMaxLength(MAX_AGENT_FAILURE_TEXT_LENGTH)
  ),
  remediation: Schema.optionalKey(
    Schema.UndefinedOr(
      Schema.String.check(Schema.isMaxLength(MAX_AGENT_FAILURE_TEXT_LENGTH))
    )
  ),
  retryWithMaxOutputTokens: Schema.optionalKey(Schema.UndefinedOr(PositiveInt)),
  retryable: Schema.optionalKey(Schema.UndefinedOr(Schema.Boolean)),
  stage: Schema.Literals(AGENT_FAILURE_STAGES),
  upstreamCode: Schema.optionalKey(
    Schema.UndefinedOr(
      Schema.Union([
        Schema.Finite,
        Schema.String.check(Schema.isMaxLength(MAX_AGENT_FAILURE_TEXT_LENGTH)),
      ])
    )
  ),
}).annotate({ identifier: "AgentFailure" });

const RuntimeEventSchema = <
  Type extends string,
  Payload extends Schema.Schema<unknown>,
>(
  type: Type,
  payload: Payload
): Schema.Struct<{
  readonly harness: Schema.optionalKey<Schema.UndefinedOr<Schema.String>>;
  readonly model: Schema.optionalKey<
    Schema.UndefinedOr<Schema.NullOr<Schema.String>>
  >;
  readonly payload: Payload;
  readonly raw: Schema.optionalKey<Schema.UndefinedOr<typeof RawEventSchema>>;
  readonly type: Schema.Literal<Type>;
}> =>
  Schema.Struct({
    harness: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
    model: Schema.optionalKey(Schema.UndefinedOr(Schema.NullOr(Schema.String))),
    payload,
    raw: Schema.optionalKey(Schema.UndefinedOr(RawEventSchema)),
    type: Schema.Literal(type),
  });

export const AgentSessionToolStatusSchema = Schema.Literals(
  AGENT_SESSION_TOOL_STATUSES
);

export const AgentSessionItemStatusSchema = Schema.Literals(
  AGENT_SESSION_ITEM_STATUSES
);

const ItemPayloadSchema = Schema.Struct({
  data: Schema.optionalKey(Schema.Unknown),
  detail: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
  itemId: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
  itemType: Schema.String,
  status: Schema.optionalKey(Schema.UndefinedOr(AgentSessionItemStatusSchema)),
  title: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
});

const DeltaPayloadSchema = Schema.Struct({
  contentIndex: Schema.optionalKey(Schema.UndefinedOr(Schema.Number)),
  delta: Schema.String,
  itemId: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
});

export const PermissionOptionKindSchema = Schema.Literals([
  "allow_always",
  "allow_once",
  "reject_always",
  "reject_once",
]);

const PermissionRequestedPayloadSchema = Schema.Struct({
  correlationId: Schema.String,
  operation: Schema.String,
  options: Schema.Array(PermissionOptionKindSchema),
  sessionId: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
  toolCallId: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
});

const PermissionResolvedPayloadSchema = Schema.Union([
  Schema.Struct({
    correlationId: Schema.String,
    optionId: Schema.String,
    outcome: Schema.Literal("selected"),
  }),
  Schema.Struct({
    correlationId: Schema.String,
    outcome: Schema.Literal("cancelled"),
  }),
]).pipe(Schema.toTaggedUnion("outcome"));

export const ElicitationFieldSummarySchema = Schema.Struct({
  default: Schema.optionalKey(
    Schema.UndefinedOr(
      Schema.Union([
        Schema.Boolean,
        Schema.Finite,
        Schema.Array(Schema.String),
        Schema.String,
      ])
    )
  ),
  description: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
  name: Schema.String,
  options: Schema.optionalKey(Schema.UndefinedOr(Schema.Array(Schema.String))),
  required: Schema.optionalKey(Schema.UndefinedOr(Schema.Boolean)),
  type: Schema.Literals([
    "array",
    "boolean",
    "integer",
    "number",
    "string",
    "unknown",
  ]),
});

const ElicitationRequestedPayloadSchema = Schema.Struct({
  correlationId: Schema.String,
  fields: Schema.Array(ElicitationFieldSummarySchema),
  message: Schema.String,
  requestId: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
  sessionId: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
  toolCallId: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
});

const ElicitationResolvedPayloadSchema = Schema.Struct({
  action: Schema.Literals(["accept", "cancel", "decline"]),
  correlationId: Schema.String,
});

export const AuthorAgentRuntimeEventSchema = Schema.Union([
  RuntimeEventSchema(
    AgentRuntimeEventTag.RunStarted,
    Schema.Struct({
      cwd: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
      model: Schema.optionalKey(
        Schema.UndefinedOr(Schema.NullOr(Schema.String))
      ),
      prompt: Schema.String,
      userId: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
    })
  ),
  RuntimeEventSchema(
    AgentRuntimeEventTag.SessionStarted,
    Schema.Struct({
      sessionId: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
    })
  ),
  RuntimeEventSchema(
    AgentRuntimeEventTag.SessionSucceeded,
    Schema.Struct({
      sessionId: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
      usage: Schema.optionalKey(Schema.UndefinedOr(RuntimeUsageSchema)),
    })
  ),
  RuntimeEventSchema(
    AgentRuntimeEventTag.SessionFailed,
    Schema.Struct({
      failure: AgentFailureSchema,
      sessionId: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
      usage: Schema.optionalKey(Schema.UndefinedOr(RuntimeUsageSchema)),
    })
  ),
  RuntimeEventSchema(
    AgentRuntimeEventTag.TurnStarted,
    Schema.Struct({
      prompt: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
    })
  ),
  RuntimeEventSchema(
    AgentRuntimeEventTag.TurnSucceeded,
    Schema.Struct({
      usage: Schema.optionalKey(Schema.UndefinedOr(RuntimeUsageSchema)),
    })
  ),
  RuntimeEventSchema(
    AgentRuntimeEventTag.TurnFailed,
    Schema.Struct({
      failure: AgentFailureSchema,
      usage: Schema.optionalKey(Schema.UndefinedOr(RuntimeUsageSchema)),
    })
  ),
  RuntimeEventSchema(
    AgentRuntimeEventTag.AssistantTextDelta,
    DeltaPayloadSchema
  ),
  RuntimeEventSchema(AgentRuntimeEventTag.ReasoningDelta, DeltaPayloadSchema),
  RuntimeEventSchema(AgentRuntimeEventTag.ToolOutputDelta, DeltaPayloadSchema),
  RuntimeEventSchema(AgentRuntimeEventTag.ContentDelta, DeltaPayloadSchema),
  RuntimeEventSchema(AgentRuntimeEventTag.ItemStarted, ItemPayloadSchema),
  RuntimeEventSchema(AgentRuntimeEventTag.ItemUpdated, ItemPayloadSchema),
  RuntimeEventSchema(AgentRuntimeEventTag.ItemCompleted, ItemPayloadSchema),
  RuntimeEventSchema(
    AgentRuntimeEventTag.ToolStarted,
    Schema.Struct({
      input: Schema.optionalKey(Schema.Unknown),
      name: Schema.String,
      toolCallId: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
    })
  ),
  RuntimeEventSchema(
    AgentRuntimeEventTag.ToolProgress,
    Schema.Struct({
      input: Schema.optionalKey(Schema.Unknown),
      name: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
      partialResult: Schema.optionalKey(Schema.Unknown),
      toolCallId: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
    })
  ),
  RuntimeEventSchema(
    AgentRuntimeEventTag.ToolSucceeded,
    Schema.Struct({
      name: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
      result: Schema.optionalKey(Schema.Unknown),
      toolCallId: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
    })
  ),
  RuntimeEventSchema(
    AgentRuntimeEventTag.ToolFailed,
    Schema.Struct({
      name: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
      result: Schema.optionalKey(Schema.Unknown),
      toolCallId: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
    })
  ),
  RuntimeEventSchema(
    AgentRuntimeEventTag.ToolResultSucceeded,
    Schema.Struct({
      content: Schema.optionalKey(Schema.Unknown),
      name: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
      toolCallId: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
    })
  ),
  RuntimeEventSchema(
    AgentRuntimeEventTag.ToolResultFailed,
    Schema.Struct({
      content: Schema.optionalKey(Schema.Unknown),
      name: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
      toolCallId: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
    })
  ),
  RuntimeEventSchema(
    AgentRuntimeEventTag.PermissionRequested,
    PermissionRequestedPayloadSchema
  ),
  RuntimeEventSchema(
    AgentRuntimeEventTag.PermissionResolved,
    PermissionResolvedPayloadSchema
  ),
  RuntimeEventSchema(
    AgentRuntimeEventTag.ElicitationRequested,
    ElicitationRequestedPayloadSchema
  ),
  RuntimeEventSchema(
    AgentRuntimeEventTag.ElicitationResolved,
    ElicitationResolvedPayloadSchema
  ),
  RuntimeEventSchema(
    AgentRuntimeEventTag.RuntimeWarning,
    Schema.Struct({
      detail: Schema.optionalKey(Schema.Unknown),
      message: Schema.String,
    })
  ),
  RuntimeEventSchema(
    AgentRuntimeEventTag.RuntimeError,
    Schema.Struct({
      failure: AgentFailureSchema,
    })
  ),
  RuntimeEventSchema(
    AgentRuntimeEventTag.CompactionStarted,
    CompactionStartedPayload
  ),
  RuntimeEventSchema(
    AgentRuntimeEventTag.CompactionCompleted,
    CompactionCompletedPayload
  ),
  RuntimeEventSchema(
    AgentRuntimeEventTag.CompactionFailed,
    Schema.Struct({
      ...AgentRuntimeLifecyclePayloadFields.compactionFailed,
      failure: AgentFailureSchema,
    })
  ),
  RuntimeEventSchema(
    AgentRuntimeEventTag.CompactionCancelled,
    CompactionCancelledPayload
  ),
  RuntimeEventSchema(
    AgentRuntimeEventTag.RetryScheduled,
    RetryScheduledPayload
  ),
  RuntimeEventSchema(
    AgentRuntimeEventTag.RetryCompleted,
    RetryCompletedPayload
  ),
  RuntimeEventSchema(
    AgentRuntimeEventTag.RetryFailed,
    Schema.Struct({
      ...AgentRuntimeLifecyclePayloadFields.retryFailed,
      failure: AgentFailureSchema,
    })
  ),
  RuntimeEventSchema(
    AgentRuntimeEventTag.RetryCancelled,
    RetryCancelledPayload
  ),
]).pipe(
  Schema.toTaggedUnion("type")
) satisfies Schema.Schema<AgentRuntimeEvent>;

export const decodeAuthorAgentRuntimeEvent = Schema.decodeUnknownEffect(
  AuthorAgentRuntimeEventSchema
);

export const decodeAuthorAgentRuntimeEventSync = Schema.decodeUnknownSync(
  AuthorAgentRuntimeEventSchema
);

export type { AgentRuntimeEvent };
