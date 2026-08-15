import { Schema, SchemaGetter } from "effect";

// Pi's `message_update.assistantMessageEvent` arrives as a loose `{ type, delta? }`
// bag: only `text_delta` and `thinking_delta` (with a delta present) carry an ACP
// projection, and any other subtype must still decode so projection can ignore it.
// Decoding it into this tagged union quarantines that classification here, at the
// boundary, so the projection layer reads clean variants instead of re-checking the
// discriminant and delta presence by hand.
const AssistantMessageDelta = Schema.Union([
  Schema.TaggedStruct("TextDelta", { text: Schema.String }),
  Schema.TaggedStruct("ThinkingDelta", { text: Schema.String }),
  Schema.TaggedStruct("OtherAssistantEvent", {
    delta: Schema.optionalKey(Schema.String),
    type: Schema.String,
  }),
]).pipe(Schema.toTaggedUnion("_tag"));

const AssistantMessageWire = Schema.Struct({
  delta: Schema.optionalKey(Schema.String),
  type: Schema.String,
});

const AssistantMessageEvent = AssistantMessageWire.pipe(
  Schema.decodeTo(AssistantMessageDelta, {
    decode: SchemaGetter.transform((wire) => {
      if (wire.type === "text_delta" && wire.delta !== undefined) {
        return {
          _tag: "TextDelta" as const,
          text: wire.delta,
        };
      }
      if (wire.type === "thinking_delta" && wire.delta !== undefined) {
        return {
          _tag: "ThinkingDelta" as const,
          text: wire.delta,
        };
      }
      return {
        _tag: "OtherAssistantEvent" as const,
        ...wire,
      };
    }),
    encode: SchemaGetter.transform((delta) => {
      if (delta._tag === "TextDelta") {
        return {
          delta: delta.text,
          type: "text_delta",
        };
      }
      if (delta._tag === "ThinkingDelta") {
        return {
          delta: delta.text,
          type: "thinking_delta",
        };
      }
      const { _tag, ...wire } = delta;
      return wire;
    }),
  })
);

type AssistantMessageDelta = typeof AssistantMessageDelta.Type;

export { AssistantMessageDelta, AssistantMessageEvent };
