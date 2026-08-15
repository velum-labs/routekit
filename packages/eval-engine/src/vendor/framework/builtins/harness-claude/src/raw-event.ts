import { Effect, Option, Schema } from "effect";
import { HarnessProtocolError } from "../../ori/src/index.ts";

const JsonObjectSchema = Schema.Record(Schema.String, Schema.Unknown);

const ClaudeContentBlockSchema = Schema.Struct({
  content: Schema.optionalKey(Schema.Unknown),
  id: Schema.optionalKey(Schema.String),
  input: Schema.optionalKey(Schema.Unknown),
  is_error: Schema.optionalKey(Schema.Boolean),
  name: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(Schema.String),
  tool_use_id: Schema.optionalKey(Schema.String),
  type: Schema.optionalKey(Schema.String),
});

const ClaudeMessageSchema = Schema.Struct({
  content: Schema.optionalKey(Schema.Array(ClaudeContentBlockSchema)),
  role: Schema.optionalKey(Schema.String),
});

const ClaudeStreamInnerEventSchema = Schema.Struct({
  delta: Schema.optionalKey(
    Schema.Struct({
      text: Schema.optionalKey(Schema.String),
      type: Schema.optionalKey(Schema.String),
    })
  ),
  index: Schema.optionalKey(Schema.Number),
  type: Schema.optionalKey(Schema.String),
});

// Claude's `compact_boundary` system event carries pre-compaction metadata.
// The CLI wire has used both snake_case and camelCase spellings across
// versions (top-level results already mix `session_id` with `modelUsage`), so
// both are decoded and merged in the projector.
const ClaudeCompactMetadataSchema = Schema.Struct({
  pre_tokens: Schema.optionalKey(Schema.Number),
  preTokens: Schema.optionalKey(Schema.Number),
  trigger: Schema.optionalKey(Schema.String),
});

const ClaudeSystemEventSchema = Schema.Struct({
  compact_metadata: Schema.optionalKey(ClaudeCompactMetadataSchema),
  compactMetadata: Schema.optionalKey(ClaudeCompactMetadataSchema),
  error: Schema.optionalKey(Schema.String),
  session_id: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.String),
  subtype: Schema.optionalKey(Schema.String),
  type: Schema.Literal("system"),
});

const ClaudeAssistantEventSchema = Schema.Struct({
  message: Schema.optionalKey(ClaudeMessageSchema),
  type: Schema.Literal("assistant"),
});

const ClaudeUserEventSchema = Schema.Struct({
  message: Schema.optionalKey(ClaudeMessageSchema),
  type: Schema.Literal("user"),
});

const ClaudeStreamEventSchema = Schema.Struct({
  event: Schema.optionalKey(ClaudeStreamInnerEventSchema),
  type: Schema.Literal("stream_event"),
});

const ClaudeResultUsageSchema = Schema.Struct({
  cache_creation_input_tokens: Schema.optionalKey(Schema.Number),
  cache_read_input_tokens: Schema.optionalKey(Schema.Number),
  input_tokens: Schema.optionalKey(Schema.Number),
  output_tokens: Schema.optionalKey(Schema.Number),
});

// Per-model entry in the result's `modelUsage` map. Unlike the top-level
// `usage` (which reports only the final API turn), these are the run's
// cumulative totals and align with `total_cost_usd`.
const ClaudeModelUsageSchema = Schema.Struct({
  cacheCreationInputTokens: Schema.optionalKey(Schema.Number),
  cacheReadInputTokens: Schema.optionalKey(Schema.Number),
  inputTokens: Schema.optionalKey(Schema.Number),
  outputTokens: Schema.optionalKey(Schema.Number),
});

const ClaudeResultEventSchema = Schema.Struct({
  error: Schema.optionalKey(Schema.String),
  errors: Schema.optionalKey(Schema.Array(Schema.String)),
  is_error: Schema.optionalKey(Schema.Boolean),
  message: Schema.optionalKey(Schema.String),
  // `modelUsage` is keyed by model id (e.g. "claude-opus-4-8[1m]"); the first
  // key is surfaced as the model label and its cumulative token counts.
  modelUsage: Schema.optionalKey(
    Schema.Record(Schema.String, ClaudeModelUsageSchema)
  ),
  result: Schema.optionalKey(Schema.String),
  session_id: Schema.optionalKey(Schema.String),
  // Claude's machine-readable failure discriminator (`error_max_turns`,
  // `error_during_execution`, …). It is the only non-prose signal on a failed
  // result, so it is decoded and carried as the failure's `upstreamCode`.
  subtype: Schema.optionalKey(Schema.String),
  total_cost_usd: Schema.optionalKey(Schema.Number),
  type: Schema.Union([
    Schema.Literal("agent_error"),
    Schema.Literal("error"),
    Schema.Literal("result"),
  ]),
  usage: Schema.optionalKey(ClaudeResultUsageSchema),
});

const ClaudeRawEventSchema = Schema.Union([
  ClaudeAssistantEventSchema,
  ClaudeResultEventSchema,
  ClaudeStreamEventSchema,
  ClaudeSystemEventSchema,
  ClaudeUserEventSchema,
]);

type ClaudeRawEvent = typeof ClaudeRawEventSchema.Type;
type ClaudeRawPayload = typeof JsonObjectSchema.Type;
type ClaudeAssistantEvent = typeof ClaudeAssistantEventSchema.Type;
type ClaudeResultEvent = typeof ClaudeResultEventSchema.Type;
type ClaudeStreamEvent = typeof ClaudeStreamEventSchema.Type;
type ClaudeSystemEvent = typeof ClaudeSystemEventSchema.Type;
type ClaudeUserEvent = typeof ClaudeUserEventSchema.Type;

interface DecodedClaudeRawEvent {
  readonly event: ClaudeRawEvent;
  readonly raw: ClaudeRawPayload;
}

const decodeClaudeRawPayloadLine = Schema.decodeUnknownEffect(
  Schema.fromJsonString(JsonObjectSchema)
);
const decodeClaudeRawEvent = Schema.decodeUnknownEffect(ClaudeRawEventSchema);
const decodeClaudeRawPayloadLineOption = Schema.decodeUnknownOption(
  Schema.fromJsonString(JsonObjectSchema)
);
const decodeClaudeRawEventOption =
  Schema.decodeUnknownOption(ClaudeRawEventSchema);

export const decodeClaudeRawEventLineEffect = Effect.fn(
  "ClaudeRawEvent.decodeLine"
)(function* (line: string) {
  const raw = yield* decodeClaudeRawPayloadLine(line).pipe(
    Effect.mapError(
      (cause) =>
        new HarnessProtocolError({
          cause,
          detail: "Invalid Claude JSON line",
          line,
        })
    )
  );
  const event = yield* decodeClaudeRawEvent(raw).pipe(
    Effect.mapError(
      (cause) =>
        new HarnessProtocolError({
          cause,
          detail: "Invalid Claude raw event",
          line,
        })
    )
  );
  return {
    event,
    raw,
  } satisfies DecodedClaudeRawEvent;
});

export const decodeClaudeRawEventLine = (
  line: string
): DecodedClaudeRawEvent | undefined => {
  const raw = decodeClaudeRawPayloadLineOption(line);
  if (Option.isNone(raw)) {
    return;
  }

  const event = decodeClaudeRawEventOption(raw.value);
  return Option.isNone(event)
    ? undefined
    : {
        event: event.value,
        raw: raw.value,
      };
};

export type {
  ClaudeRawPayload,
  ClaudeAssistantEvent,
  ClaudeResultEvent,
  ClaudeStreamEvent,
  ClaudeSystemEvent,
  ClaudeUserEvent,
  DecodedClaudeRawEvent,
};
