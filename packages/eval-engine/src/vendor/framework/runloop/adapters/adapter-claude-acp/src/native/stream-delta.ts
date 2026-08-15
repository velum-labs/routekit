import { Schema, SchemaGetter } from "effect";

// A Claude `stream_event` delta arrives as a loose `{ type, text?, thinking? }`
// bag: only `text_delta` (carrying `text`) and `thinking_delta` (carrying
// `thinking`) project to an ACP chunk, and any other subtype must still decode
// so projection can ignore it. Decoding it into this tagged union quarantines
// that classification here, at the boundary, so the projection layer reads
// clean variants instead of re-checking the discriminant and field presence by
// hand. Both projected variants normalize their payload to `text` so the
// projection never re-branches on which field carried it.
const StreamDelta = Schema.Union([
  Schema.TaggedStruct("TextDelta", { text: Schema.String }),
  Schema.TaggedStruct("ThinkingDelta", { text: Schema.String }),
  Schema.TaggedStruct("OtherStreamDelta", { type: Schema.String }),
]).pipe(Schema.toTaggedUnion("_tag"));

const StreamDeltaWire = Schema.Struct({
  text: Schema.optionalKey(Schema.String),
  thinking: Schema.optionalKey(Schema.String),
  type: Schema.optionalKey(Schema.String),
});

const StreamDeltaEvent = StreamDeltaWire.pipe(
  Schema.decodeTo(StreamDelta, {
    decode: SchemaGetter.transform((wire) => {
      if (wire.type === "text_delta" && wire.text !== undefined) {
        return {
          _tag: "TextDelta" as const,
          text: wire.text,
        };
      }
      if (wire.type === "thinking_delta" && wire.thinking !== undefined) {
        return {
          _tag: "ThinkingDelta" as const,
          text: wire.thinking,
        };
      }
      return {
        _tag: "OtherStreamDelta" as const,
        type: wire.type ?? "unknown",
      };
    }),
    encode: SchemaGetter.transform((delta) => {
      if (delta._tag === "TextDelta") {
        return {
          text: delta.text,
          type: "text_delta",
        };
      }
      if (delta._tag === "ThinkingDelta") {
        return {
          thinking: delta.text,
          type: "thinking_delta",
        };
      }
      return { type: delta.type };
    }),
  })
);

type StreamDelta = typeof StreamDelta.Type;

export { StreamDelta, StreamDeltaEvent };
