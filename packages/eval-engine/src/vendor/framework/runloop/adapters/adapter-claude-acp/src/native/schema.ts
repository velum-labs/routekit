import { Schema } from "effect";

import { StreamDeltaEvent } from "./stream-delta.ts";
import { DiagnosticText } from "../../../../../contracts/internal/src/runtime/agent-event-diagnostic.ts";

const NonNegativeInt = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0)
).annotate({ identifier: "NonNegativeInt" });
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0)).annotate({
  identifier: "PositiveInt",
});
const FiniteNonNegative = Schema.Number.check(
  Schema.isFinite(),
  Schema.isGreaterThanOrEqualTo(0)
);

// Outbound commands written to the Claude Code CLI stdin (stream-json input).
// The native wire is Claude Code 2.1.197's own SDK JSONL and stays private
// behind this adapter; nothing here is exposed as ACP.

const UserPromptCommand = Schema.Struct({
  message: Schema.Struct({
    content: Schema.String,
    role: Schema.Literal("user"),
  }),
  parent_tool_use_id: Schema.Null,
  session_id: Schema.NonEmptyString,
  type: Schema.Literal("user"),
});
const InterruptCommand = Schema.Struct({
  request: Schema.Struct({ subtype: Schema.Literal("interrupt") }),
  request_id: Schema.NonEmptyString,
  type: Schema.Literal("control_request"),
});
const AskUserSuccessResponse = Schema.Struct({
  request_id: Schema.NonEmptyString,
  response: Schema.Struct({
    response: Schema.String,
    subtype: Schema.Literal("success"),
  }),
  type: Schema.Literal("control_response"),
});
const AskUserCancelledResponse = Schema.Struct({
  request_id: Schema.NonEmptyString,
  response: Schema.Struct({ subtype: Schema.Literal("cancelled") }),
  type: Schema.Literal("control_response"),
});

const ClaudeCommand = Schema.Union([
  UserPromptCommand,
  InterruptCommand,
  AskUserSuccessResponse,
  AskUserCancelledResponse,
]);

const AskUserControlResponse = Schema.Union([
  AskUserSuccessResponse,
  AskUserCancelledResponse,
]);

// Inbound records emitted by the Claude Code CLI on stdout (stream-json output
// with --include-partial-messages), modeled once with their full payload so the
// projection consumes typed variants instead of re-decoding from `unknown`.

// The stream-event delta decodes into a tagged union at the boundary (see
// `#native/stream-delta`): only `text_delta`/`thinking_delta` carry a
// projection, and any other `delta.type` (or a delta-less partial event) still
// decodes so projection can ignore it, returning no ACP update.
const StreamEvent = Schema.Struct({
  event: Schema.Struct({
    delta: Schema.optionalKey(StreamDeltaEvent),
    type: Schema.String,
  }),
  type: Schema.Literal("stream_event"),
});

const ToolUseBlock = Schema.Struct({
  id: Schema.NonEmptyString,
  input: Schema.Json,
  name: Schema.NonEmptyString,
  type: Schema.Literal("tool_use"),
});
const TextBlock = Schema.Struct({
  text: Schema.String,
  type: Schema.Literal("text"),
});
const ThinkingBlock = Schema.Struct({
  thinking: Schema.String,
  type: Schema.Literal("thinking"),
});
const RedactedThinkingBlock = Schema.Struct({
  data: Schema.String,
  type: Schema.Literal("redacted_thinking"),
});
// A permissive fallback keeps an assistant message decodable when it carries a
// block kind this adapter does not model; projection extracts tool_use and
// ignores the rest, matching the pre-refactor lenient projection.
const OtherAssistantBlock = Schema.Struct({ type: Schema.String });
const AssistantContentBlock = Schema.Union([
  ToolUseBlock,
  TextBlock,
  ThinkingBlock,
  RedactedThinkingBlock,
  OtherAssistantBlock,
]);
const AssistantEvent = Schema.Struct({
  message: Schema.Struct({
    content: Schema.Array(AssistantContentBlock),
  }),
  type: Schema.Literal("assistant"),
});

const ToolResultBlock = Schema.Struct({
  is_error: Schema.optionalKey(Schema.Boolean),
  tool_use_id: Schema.NonEmptyString,
  type: Schema.Literal("tool_result"),
});
// A `user` event echoes tool results, but Claude may also carry a block kind
// this adapter does not project (e.g. an echoed text turn). A permissive
// fallback keeps the event decodable so projection extracts tool_result and
// ignores the rest, matching the lenient assistant-block handling above rather
// than misreporting the whole event as malformed.
const OtherUserBlock = Schema.Struct({ type: Schema.String });
const UserContentBlock = Schema.Union([ToolResultBlock, OtherUserBlock]);
const UserEvent = Schema.Struct({
  message: Schema.Struct({
    content: Schema.Array(UserContentBlock),
  }),
  type: Schema.Literal("user"),
});

const ClaudeResultUsage = Schema.Struct({
  cache_creation_input_tokens: Schema.optionalKey(NonNegativeInt),
  cache_read_input_tokens: Schema.optionalKey(NonNegativeInt),
  input_tokens: Schema.optionalKey(NonNegativeInt),
  output_tokens: Schema.optionalKey(NonNegativeInt),
});
const ClaudeModelUsage = Schema.Struct({
  cacheCreationInputTokens: Schema.optionalKey(NonNegativeInt),
  cacheReadInputTokens: Schema.optionalKey(NonNegativeInt),
  contextWindow: Schema.optionalKey(NonNegativeInt),
  costUSD: Schema.optionalKey(FiniteNonNegative),
  inputTokens: Schema.optionalKey(NonNegativeInt),
  outputTokens: Schema.optionalKey(NonNegativeInt),
});
const ClaudeModelUsageRecord = Schema.Record(Schema.String, ClaudeModelUsage);
const ClaudeTotalCost = FiniteNonNegative;
const ResultEvent = Schema.Struct({
  is_error: Schema.optionalKey(Schema.Boolean),
  modelUsage: Schema.optionalKey(Schema.Unknown),
  session_id: Schema.optionalKey(Schema.String),
  stop_reason: Schema.optionalKey(Schema.String),
  total_cost_usd: Schema.optionalKey(Schema.Unknown),
  type: Schema.Literal("result"),
  usage: Schema.optionalKey(Schema.Unknown),
});

const ApiRetryEvent = Schema.Struct({
  attempt: PositiveInt,
  error: Schema.optionalKey(DiagnosticText),
  max_retries: PositiveInt,
  retry_delay_ms: FiniteNonNegative,
  subtype: Schema.Literal("api_retry"),
  type: Schema.Literal("system"),
});
const CompactBoundaryEvent = Schema.Struct({
  compact_metadata: Schema.optionalKey(
    Schema.Struct({
      pre_tokens: Schema.optionalKey(NonNegativeInt),
      trigger: Schema.optionalKey(Schema.String),
    })
  ),
  subtype: Schema.Literal("compact_boundary"),
  type: Schema.Literal("system"),
});
// Every other `system` record (init banners, unrecognized subtypes) decodes to
// this fallback and projects to nothing, so it is never misreported as unknown.
const OtherSystemEvent = Schema.Struct({
  session_id: Schema.optionalKey(Schema.String),
  subtype: Schema.optionalKey(Schema.String),
  type: Schema.Literal("system"),
});
const SystemEvent = Schema.Union([
  ApiRetryEvent,
  CompactBoundaryEvent,
  OtherSystemEvent,
]);

const AskUserQuestionOption = Schema.Struct({
  description: Schema.optionalKey(Schema.String),
  label: Schema.NonEmptyString,
});
const AskUserQuestion = Schema.Struct({
  header: Schema.optionalKey(Schema.String),
  multiSelect: Schema.optionalKey(Schema.Boolean),
  options: Schema.Array(AskUserQuestionOption),
  question: Schema.NonEmptyString,
});
const AskUserControlRequest = Schema.Struct({
  request: Schema.Struct({
    input: Schema.Struct({ questions: Schema.Array(AskUserQuestion) }),
    subtype: Schema.Literal("can_use_tool"),
    tool_name: Schema.Literal("AskUserQuestion"),
  }),
  request_id: Schema.NonEmptyString,
  type: Schema.Literal("control_request"),
});
// A forward-compatible control request (permission subtypes, other can_use_tool
// tools) that still decodes carrying `request_id` so the elicitation projection
// can settle Claude's blocked peer rather than leave it waiting.
const OtherControlRequest = Schema.Struct({
  request: Schema.Struct({
    subtype: Schema.String,
    tool_name: Schema.optionalKey(Schema.String),
  }),
  request_id: Schema.NonEmptyString,
  type: Schema.Literal("control_request"),
});
const ClaudeControlRequest = Schema.Union([
  AskUserControlRequest,
  OtherControlRequest,
]);

const ClaudeInbound = Schema.Union([
  StreamEvent,
  AssistantEvent,
  UserEvent,
  ResultEvent,
  SystemEvent,
  ClaudeControlRequest,
]);

// Discriminant-only envelope: separates a genuinely unknown record type from a
// known type whose payload failed to decode, at the boundary.
const ClaudeEnvelope = Schema.Struct({
  diagnosticHarness: Schema.optionalKey(Schema.String),
  type: Schema.NonEmptyString,
});
const KNOWN_INBOUND_TYPES: ReadonlySet<string> = new Set([
  "stream_event",
  "assistant",
  "user",
  "result",
  "system",
  "control_request",
]);

type ClaudeCommand = typeof ClaudeCommand.Type;
type AskUserControlResponse = typeof AskUserControlResponse.Type;
type ClaudeInbound = typeof ClaudeInbound.Type;
type ClaudeControlRequest = typeof ClaudeControlRequest.Type;
type ClaudeEnvelope = typeof ClaudeEnvelope.Type;

export {
  ApiRetryEvent,
  AskUserControlRequest,
  ClaudeCommand,
  ClaudeControlRequest,
  ClaudeModelUsageRecord,
  ClaudeResultUsage,
  ClaudeTotalCost,
  ClaudeEnvelope,
  ClaudeInbound,
  CompactBoundaryEvent,
  KNOWN_INBOUND_TYPES,
  ToolResultBlock,
  ToolUseBlock,
};
export type { AskUserControlResponse as AskUserControlResponseType };
