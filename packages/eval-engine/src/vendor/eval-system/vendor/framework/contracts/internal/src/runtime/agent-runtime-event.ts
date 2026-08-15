import { Schema } from "effect";

import type { AgentRuntimeEventTag as AgentRuntimeEventTagType } from "../../../author/src/index.ts";
import type {
  AgentRuntimeEvent as AgentRuntimeEventType,
  AgentRuntimeRawEvent as AgentRuntimeRawEventType,
} from "./agent-runtime-event-types.ts";
import type { AssertAssignable } from "../type-boundary.ts";

import { AgentRuntimeEventTag as AgentRuntimeEventTagValue } from "../../../author/src/index.ts";
import {
  AgentRuntimeLifecyclePayloadFields,
  CompactionCancelledPayload,
  CompactionCompletedPayload,
  CompactionStartedPayload,
  RetryCancelledPayload,
  RetryCompletedPayload,
  RetryScheduledPayload,
} from "../../../author/src/agent-runtime-lifecycle.ts";
import { AgentFailureSchema } from "../author-schemas/agent-runtime-event.ts";
import {
  HarnessName,
  RunId,
  RuntimeEventId,
  SessionId,
  TurnId,
} from "../ids.ts";

const AgentRuntimeEventTag = AgentRuntimeEventTagValue;
type AgentRuntimeEventTag = AgentRuntimeEventTagType;

const RawEventSchema = Schema.Struct({
  payload: Schema.Unknown,
  source: Schema.String,
});

const RuntimeUsageSchema = Schema.Struct({
  cacheCreationTokens: Schema.Number,
  cacheReadTokens: Schema.Number,
  contextTokens: Schema.optionalKey(Schema.UndefinedOr(Schema.Number)),
  costUsd: Schema.optionalKey(Schema.UndefinedOr(Schema.Number)),
  generationId: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
  inputTokens: Schema.Number,
  model: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
  outputTokens: Schema.Number,
});

const MetadataFields = {
  createdAt: Schema.String,
  eventId: RuntimeEventId,
  harness: HarnessName,
  itemId: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
  model: Schema.optionalKey(Schema.UndefinedOr(Schema.NullOr(Schema.String))),
  // Lineage backref stamped on a forked session's events (Fork Thread,
  // RFC 0003); without it here the decode in journal.append would strip it.
  parentSessionId: Schema.optionalKey(Schema.UndefinedOr(SessionId)),
  raw: Schema.optionalKey(Schema.UndefinedOr(RawEventSchema)),
  runId: RunId,
  sessionId: Schema.optionalKey(Schema.UndefinedOr(SessionId)),
  turnId: Schema.optionalKey(Schema.UndefinedOr(TurnId)),
} as const;

const RuntimeEventSchema = <
  Type extends string,
  Payload extends Schema.Schema<unknown>,
>(
  type: Type,
  payload: Payload
): Schema.Struct<{
  readonly payload: Payload;
  readonly type: Schema.Literal<Type>;
  readonly createdAt: Schema.String;
  readonly eventId: Schema.brand<Schema.String, "RuntimeEventId">;
  readonly harness: Schema.brand<Schema.String, "HarnessName">;
  readonly itemId: Schema.optionalKey<Schema.UndefinedOr<Schema.String>>;
  readonly model: Schema.optionalKey<
    Schema.UndefinedOr<Schema.NullOr<Schema.String>>
  >;
  readonly parentSessionId: Schema.optionalKey<
    Schema.UndefinedOr<Schema.brand<Schema.String, "SessionId">>
  >;
  readonly raw: Schema.optionalKey<
    Schema.UndefinedOr<
      Schema.Struct<{
        readonly payload: Schema.Unknown;
        readonly source: Schema.String;
      }>
    >
  >;
  readonly runId: Schema.brand<Schema.String, "RunId">;
  readonly sessionId: Schema.optionalKey<
    Schema.UndefinedOr<Schema.brand<Schema.String, "SessionId">>
  >;
  readonly turnId: Schema.optionalKey<
    Schema.UndefinedOr<Schema.brand<Schema.String, "TurnId">>
  >;
}> =>
  Schema.Struct({
    ...MetadataFields,
    payload,
    type: Schema.Literal(type),
  });

// The former ContentDelta `streamKind` sub-discriminant is now the event
// `type`, so the payload no longer carries it.
const DeltaPayloadSchema = Schema.Struct({
  contentIndex: Schema.optionalKey(Schema.UndefinedOr(Schema.Number)),
  delta: Schema.String,
  itemId: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
});

const ItemPayloadSchema = Schema.Struct({
  data: Schema.optionalKey(Schema.Unknown),
  detail: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
  itemId: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
  itemType: Schema.String,
  status: Schema.optionalKey(
    Schema.UndefinedOr(
      Schema.Literals(["completed", "declined", "failed", "inProgress"])
    )
  ),
  title: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
});

const PermissionOptionKindSchema = Schema.Literals([
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

const ElicitationFieldSummarySchema = Schema.Struct({
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

export const AgentRuntimeEventSchema = Schema.Union([
  RuntimeEventSchema(
    AgentRuntimeEventTag.RunStarted,
    Schema.Struct({
      cwd: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
      model: Schema.optionalKey(
        Schema.UndefinedOr(Schema.NullOr(Schema.String))
      ),
      prompt: Schema.String,
      // The invoking user this run runs on behalf of (ROUTEKIT_EVAL-361), when the caller
      // supplied one on `agent.invoke`. Kept on the wire schema so it survives
      // the journal/run-file encode and reaches every projection (session
      // metadata sidecar, daemon reads) rather than being dropped at decode.
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
  // `content` is optional to match its producers: the pi projector forwards an
  // `optionalKey` raw field, and `JSON.stringify` drops an `undefined`-valued
  // key from the NDJSON line — a required key here rejected real writer output
  // on the way back in.
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
]).pipe(Schema.toTaggedUnion("type"));

export type AgentRuntimeEvent = AgentRuntimeEventType;
export type AgentRuntimeRawEvent = AgentRuntimeRawEventType;

// Drift guard: every decoded runtime event must stay assignable to the
// contract type (author event + engine metadata), mirroring the `satisfies`
// guard on the author-schemas copy.
type _AgentRuntimeEventSchemaDecodesContract = AssertAssignable<
  typeof AgentRuntimeEventSchema.Type,
  AgentRuntimeEvent
>;

export const decodeAgentRuntimeEvent = Schema.decodeUnknownEffect(
  AgentRuntimeEventSchema
);

export const decodeAgentRuntimeEventSync = Schema.decodeUnknownSync(
  AgentRuntimeEventSchema
);

export { AgentRuntimeEventTag, RuntimeUsageSchema };
