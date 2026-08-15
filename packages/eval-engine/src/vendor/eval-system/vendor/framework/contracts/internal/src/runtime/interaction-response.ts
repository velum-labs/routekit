import { Schema } from "effect";

import type { ChatInteractionResponse } from "../../../author/src/chat.ts";
import type { AssertAssignable } from "../type-boundary.ts";

const PermissionOptionKindSchema = Schema.Literals([
  "allow_always",
  "allow_once",
  "reject_always",
  "reject_once",
]);

const PermissionResponseSchema = Schema.Struct({
  correlationId: Schema.String,
  kind: Schema.Literal("permission"),
  response: Schema.Union([
    Schema.Struct({
      outcome: Schema.Literal("cancelled"),
    }),
    Schema.Struct({
      optionKind: PermissionOptionKindSchema,
      outcome: Schema.Literal("selected"),
    }),
  ]),
  sessionId: Schema.String,
});

const ElicitationContentValueSchema = Schema.Union([
  Schema.Boolean,
  Schema.Number,
  Schema.String,
  Schema.Array(Schema.String),
]);

const ElicitationResponseSchema = Schema.Struct({
  correlationId: Schema.String,
  kind: Schema.Literal("elicitation"),
  response: Schema.Union([
    Schema.Struct({
      action: Schema.Literal("accept"),
      content: Schema.optionalKey(
        Schema.Record(Schema.String, ElicitationContentValueSchema)
      ),
    }),
    Schema.Struct({
      action: Schema.Literals(["cancel", "decline"]),
    }),
  ]),
  sessionId: Schema.String,
});

const ChatInteractionResponseSchema = Schema.Union([
  PermissionResponseSchema,
  ElicitationResponseSchema,
]);

type _SchemaMatchesContract = AssertAssignable<
  typeof ChatInteractionResponseSchema.Type,
  ChatInteractionResponse
>;

const decodeChatInteractionResponse = Schema.decodeUnknownEffect(
  ChatInteractionResponseSchema
);

export { ChatInteractionResponseSchema, decodeChatInteractionResponse };
