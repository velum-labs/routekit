import { Effect, Option, Schema } from "effect";
import { HarnessProtocolError } from "../../../ori/src/index.ts";

const JsonObjectSchema = Schema.Record(Schema.String, Schema.Unknown);

const PiContentBlockSchema = Schema.Struct({
  arguments: Schema.optionalKey(Schema.Unknown),
  id: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(Schema.String),
  thinking: Schema.optionalKey(Schema.String),
  type: Schema.optionalKey(Schema.String),
});

// Pi reports token/cost on the assistant message of turn_end / message_end /
// agent_end events.
const PiUsageSchema = Schema.Struct({
  cacheRead: Schema.optionalKey(Schema.Number),
  cacheWrite: Schema.optionalKey(Schema.Number),
  cost: Schema.optionalKey(
    Schema.Struct({
      total: Schema.optionalKey(Schema.Number),
    })
  ),
  input: Schema.optionalKey(Schema.Number),
  output: Schema.optionalKey(Schema.Number),
});

const PiMessageSchema = Schema.Struct({
  api: Schema.optionalKey(Schema.String),
  content: Schema.optionalKey(Schema.Array(PiContentBlockSchema)),
  errorMessage: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.String),
  role: Schema.optionalKey(Schema.String),
  stopReason: Schema.optionalKey(Schema.String),
  usage: Schema.optionalKey(PiUsageSchema),
});

const PiAssistantMessageEventSchema = Schema.Struct({
  contentIndex: Schema.optionalKey(Schema.Number),
  delta: Schema.optionalKey(Schema.String),
  toolCall: Schema.optionalKey(
    Schema.Struct({
      arguments: Schema.optionalKey(Schema.Unknown),
      id: Schema.optionalKey(Schema.String),
      name: Schema.optionalKey(Schema.String),
    })
  ),
  type: Schema.optionalKey(Schema.String),
});

const PiToolResultSchema = Schema.Struct({
  content: Schema.optionalKey(Schema.Unknown),
  isError: Schema.optionalKey(Schema.Boolean),
  toolCallId: Schema.optionalKey(Schema.String),
  toolName: Schema.optionalKey(Schema.String),
});

const PiRawEventSchema = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  aborted: Schema.optionalKey(Schema.Boolean),
  args: Schema.optionalKey(Schema.Unknown),
  assistantMessageEvent: Schema.optionalKey(PiAssistantMessageEventSchema),
  errorMessage: Schema.optionalKey(Schema.String),
  isError: Schema.optionalKey(Schema.Boolean),
  message: Schema.optionalKey(PiMessageSchema),
  messages: Schema.optionalKey(Schema.Array(PiMessageSchema)),
  partialResult: Schema.optionalKey(Schema.Unknown),
  reason: Schema.optionalKey(Schema.String),
  result: Schema.optionalKey(Schema.Unknown),
  toolCallId: Schema.optionalKey(Schema.String),
  toolName: Schema.optionalKey(Schema.String),
  toolResults: Schema.optionalKey(Schema.Array(PiToolResultSchema)),
  type: Schema.String,
  willRetry: Schema.optionalKey(Schema.Boolean),
});

// Pi's compaction_end carries a CompactionResult; only the token counts are
// projected. Decoded leniently from the generic `result` field so summary text
// and extension details never leak into runtime events.
const PiCompactionResultSchema = Schema.Struct({
  estimatedTokensAfter: Schema.optionalKey(Schema.Number),
  tokensBefore: Schema.optionalKey(Schema.Number),
});

export const decodePiCompactionResultOption = Schema.decodeUnknownOption(
  PiCompactionResultSchema
);

type PiRawEvent = typeof PiRawEventSchema.Type;
type PiMessage = typeof PiMessageSchema.Type;
type PiRawPayload = typeof JsonObjectSchema.Type;

interface DecodedPiRawEvent {
  readonly event: PiRawEvent;
  readonly raw: PiRawPayload;
}

const decodePiRawPayloadLine = Schema.decodeUnknownEffect(
  Schema.fromJsonString(JsonObjectSchema)
);
const decodePiRawEvent = Schema.decodeUnknownEffect(PiRawEventSchema);
const decodePiRawPayloadLineOption = Schema.decodeUnknownOption(
  Schema.fromJsonString(JsonObjectSchema)
);
const decodePiRawEventOption = Schema.decodeUnknownOption(PiRawEventSchema);

export const decodePiRawEventLineEffect = Effect.fn("PiRawEvent.decodeLine")(
  function* (line: string) {
    const raw = yield* decodePiRawPayloadLine(line).pipe(
      Effect.mapError(
        (cause) =>
          new HarnessProtocolError({
            cause,
            detail: "Invalid Pi JSON line",
            line,
          })
      )
    );
    const event = yield* decodePiRawEvent(raw).pipe(
      Effect.mapError(
        (cause) =>
          new HarnessProtocolError({
            cause,
            detail: "Invalid Pi raw event",
            line,
          })
      )
    );
    return {
      event,
      raw,
    } satisfies DecodedPiRawEvent;
  }
);

export const decodePiRawEventLine = (
  line: string
): DecodedPiRawEvent | undefined => {
  const raw = decodePiRawPayloadLineOption(line);
  if (Option.isNone(raw)) {
    return;
  }

  const event = decodePiRawEventOption(raw.value);
  return Option.isNone(event)
    ? undefined
    : {
        event: event.value,
        raw: raw.value,
      };
};

export type { PiRawEvent, PiMessage, PiRawPayload, DecodedPiRawEvent };
