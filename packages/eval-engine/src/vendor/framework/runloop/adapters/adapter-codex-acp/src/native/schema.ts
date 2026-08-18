import { Effect, Schema } from "effect";

import { DiagnosticText } from "../../../../../contracts/internal/src/runtime/agent-event-diagnostic.ts";

// Pinned against the installed `@openai/codex` dependency by
// `native/protocol-pin.test.ts`; bump both together when Codex is upgraded.
const CODEX_PROTOCOL_VERSION = "0.133.0";

const RequestId = Schema.Union([Schema.Number, Schema.String]);

// Outgoing (ORI -> Codex) request params, keyed by JSON-RPC method.
const InitializeParams = Schema.Struct({
  capabilities: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        experimentalApi: Schema.optionalKey(Schema.Boolean),
      })
    )
  ),
  clientInfo: Schema.Struct({
    name: Schema.String,
    title: Schema.optionalKey(Schema.NullOr(Schema.String)),
    version: Schema.String,
  }),
});
const ThreadStartParams = Schema.Struct({
  cwd: Schema.String,
  developerInstructions: Schema.optionalKey(Schema.String),
  model: Schema.String,
});
const ThreadResumeParams = Schema.Struct({
  threadId: Schema.String,
});
const TurnStartParams = Schema.Struct({
  input: Schema.Array(
    Schema.Struct({
      text: Schema.String,
      text_elements: Schema.Array(Schema.Unknown),
      type: Schema.Literal("text"),
    })
  ),
  threadId: Schema.String,
});
const TurnInterruptParams = Schema.Struct({
  threadId: Schema.String,
  turnId: Schema.String,
});

const InitializeCommand = Schema.Struct({
  method: Schema.Literal("initialize"),
  params: InitializeParams,
});
const ThreadStartCommand = Schema.Struct({
  method: Schema.Literal("thread/start"),
  params: ThreadStartParams,
});
const ThreadResumeCommand = Schema.Struct({
  method: Schema.Literal("thread/resume"),
  params: ThreadResumeParams,
});
const TurnStartCommand = Schema.Struct({
  method: Schema.Literal("turn/start"),
  params: TurnStartParams,
});
const TurnInterruptCommand = Schema.Struct({
  method: Schema.Literal("turn/interrupt"),
  params: TurnInterruptParams,
});

// A real JSON-RPC request Codex must ack; the tagged union lets one request
// helper mint the id and stay generic over which method/params pair is sent.
const CodexRequestCommand = Schema.Union([
  InitializeCommand,
  ThreadStartCommand,
  ThreadResumeCommand,
  TurnStartCommand,
  TurnInterruptCommand,
]).pipe(Schema.toTaggedUnion("method"));

// Push notifications (Codex -> ORI) carrying no id; these stream during a turn.
const Delta = Schema.Struct({ delta: Schema.String });
const AgentMessageDeltaEvent = Schema.Struct({
  method: Schema.Literal("item/agentMessage/delta"),
  params: Delta,
});
const ReasoningTextDeltaEvent = Schema.Struct({
  method: Schema.Literal("item/reasoning/textDelta"),
  params: Delta,
});
const ReasoningSummaryTextDeltaEvent = Schema.Struct({
  method: Schema.Literal("item/reasoning/summaryTextDelta"),
  params: Delta,
});
const StartedItemPayload = Schema.Struct({
  command: Schema.optionalKey(Schema.String),
  id: Schema.NonEmptyString,
  type: Schema.NonEmptyString,
});
const ItemStartedEvent = Schema.Struct({
  method: Schema.Literal("item/started"),
  params: Schema.Struct({ item: StartedItemPayload }),
});
const CompletedItemPayload = Schema.Struct({
  id: Schema.NonEmptyString,
  status: Schema.optionalKey(Schema.String),
  type: Schema.NonEmptyString,
});
const ItemCompletedEvent = Schema.Struct({
  method: Schema.Literal("item/completed"),
  params: Schema.Struct({ item: CompletedItemPayload }),
});
const TokenUsageEvent = Schema.Struct({
  method: Schema.Literal("thread/tokenUsage/updated"),
  params: Schema.Struct({
    tokenUsage: Schema.Struct({
      modelContextWindow: Schema.optionalKey(Schema.Int),
      total: Schema.Struct({ totalTokens: Schema.Int }),
    }),
  }),
});
const ThreadCompactedEvent = Schema.Struct({
  method: Schema.Literal("thread/compacted"),
  params: Schema.Unknown,
});
const TurnCompletedEvent = Schema.Struct({
  method: Schema.Literal("turn/completed"),
  params: Schema.Unknown,
});
const RetryOutcome = Schema.Literals([
  "scheduled",
  "completed",
  "failed",
  "cancelled",
]);
const CompactionOrigin = Schema.Literals(["threshold", "overflow"]);
const CompactionOutcome = Schema.Literals([
  "started",
  "completed",
  "failed",
  "cancelled",
]);
const CompactionSource = Schema.Literals(["manual", "automatic", "unknown"]);
const RetryParams = Schema.Struct({
  attemptNumber: Schema.optionalKey(Schema.Int),
  delayMilliseconds: Schema.optionalKey(Schema.Int),
  limit: Schema.optionalKey(Schema.Int),
  outcome: RetryOutcome,
  reason: Schema.optionalKey(DiagnosticText),
});
const RetryEvent = Schema.Struct({
  method: Schema.Literal("ori/retry"),
  params: RetryParams,
});
const CompactionParams = Schema.Struct({
  afterTokens: Schema.optionalKey(Schema.Int),
  beforeTokens: Schema.optionalKey(Schema.Int),
  elapsedMilliseconds: Schema.optionalKey(Schema.Int),
  origin: Schema.optionalKey(CompactionOrigin),
  outcome: CompactionOutcome,
  reason: Schema.optionalKey(DiagnosticText),
  retry: Schema.optionalKey(Schema.Boolean),
  source: CompactionSource,
});
const CompactionEvent = Schema.Struct({
  method: Schema.Literal("ori/compaction"),
  params: CompactionParams,
});

const CodexKnownSessionEvent = Schema.Union([
  AgentMessageDeltaEvent,
  ReasoningTextDeltaEvent,
  ReasoningSummaryTextDeltaEvent,
  ItemStartedEvent,
  ItemCompletedEvent,
  TokenUsageEvent,
  ThreadCompactedEvent,
  TurnCompletedEvent,
  RetryEvent,
  CompactionEvent,
]).pipe(Schema.toTaggedUnion("method"));

// A blocking request Codex sends us (carries an id, expects a matching
// JSON-RPC response) when a turn needs a user's answer to continue.
const AskUserQuestionOption = Schema.Struct({
  description: Schema.String,
  label: Schema.String,
});
const AskUserQuestion = Schema.Struct({
  header: Schema.String,
  id: Schema.String,
  isOther: Schema.Boolean.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(false))
  ),
  isSecret: Schema.Boolean.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(false))
  ),
  options: Schema.optionalKey(
    Schema.NullOr(Schema.Array(AskUserQuestionOption))
  ),
  question: Schema.String,
});
const AskUserRequestParams = Schema.Struct({
  itemId: Schema.String,
  questions: Schema.Array(AskUserQuestion),
  threadId: Schema.String,
  turnId: Schema.String,
});
const CodexAskUserRequest = Schema.Struct({
  id: RequestId,
  method: Schema.Literal("item/tool/requestUserInput"),
  params: AskUserRequestParams,
});
const CodexAskUserResponse = Schema.Struct({
  answers: Schema.Record(
    Schema.String,
    Schema.Struct({ answers: Schema.Array(Schema.String) })
  ),
});

// A forward-compatible request whose method Codex does not document today. It
// still decodes (carrying `id`) so the connection can settle Codex with a
// JSON-RPC error response rather than leave it blocked on an unanswered call.
const CodexUnknownRequest = Schema.Struct({
  id: RequestId,
  method: Schema.String,
});

// Replies to a request ORI sent Codex, correlated back to the pending map by id.
const CodexSuccessResponse = Schema.Struct({
  id: RequestId,
  result: Schema.Unknown,
});
const CodexFailureResponse = Schema.Struct({
  error: Schema.Struct({
    code: Schema.Number,
    message: Schema.String,
  }),
  id: RequestId,
});
const CodexResponse = Schema.Union([
  CodexSuccessResponse,
  CodexFailureResponse,
]);

const KNOWN_NOTIFICATION_METHODS: ReadonlySet<string> = new Set([
  "item/agentMessage/delta",
  "item/reasoning/textDelta",
  "item/reasoning/summaryTextDelta",
  "item/started",
  "item/completed",
  "thread/tokenUsage/updated",
  "thread/compacted",
  "turn/completed",
  "ori/retry",
  "ori/compaction",
]);

type CodexRequestCommand = typeof CodexRequestCommand.Type;
type CodexKnownSessionEvent = typeof CodexKnownSessionEvent.Type;
type CodexAskUserRequest = typeof CodexAskUserRequest.Type;
type CodexAskUserResponse = typeof CodexAskUserResponse.Type;
type CodexUnknownRequest = typeof CodexUnknownRequest.Type;
type CodexResponse = typeof CodexResponse.Type;
type RequestId = typeof RequestId.Type;

export {
  CODEX_PROTOCOL_VERSION,
  CodexAskUserRequest,
  CodexAskUserResponse,
  CodexKnownSessionEvent,
  CodexRequestCommand,
  CodexResponse,
  CodexUnknownRequest,
  KNOWN_NOTIFICATION_METHODS,
  RequestId,
};
