import { Schema } from "effect";

import type { OptionalNullableSchema } from "./primitives.ts";

import {
  AcpInt64,
  AcpOptionalMeta,
  AcpOptionalNullable,
  AcpOptionalTolerantArray,
} from "./primitives.ts";

const acpField = <T, E extends Schema.Json, RD, RE>(
  schema: Schema.Codec<T, E, RD, RE>,
  description: string
): Schema.Codec<T, E, RD, RE> => schema.annotate({ description });

const acpOptionalField = <T, E extends Schema.Json, RD, RE>(
  schema: Schema.Codec<T, E, RD, RE>,
  description: string
): OptionalNullableSchema<T, E, RD, RE> =>
  AcpOptionalNullable(acpField(schema, description), description);
const AcpMetaFields = Schema.Struct({ _meta: AcpOptionalMeta });

const AcpAnnotations = Schema.Struct({
  ...AcpMetaFields.fields,
  audience: AcpOptionalTolerantArray(
    Schema.Literals(["user", "assistant"]),
    "Intended recipients for this content, such as the user or assistant."
  ),
  lastModified: acpOptionalField(
    Schema.String,
    "Timestamp indicating when the underlying resource was last modified."
  ),
  priority: acpOptionalField(
    Schema.Finite,
    "Relative importance of this content when clients choose what to surface."
  ),
});

const contentFields = {
  ...AcpMetaFields.fields,
  annotations: acpOptionalField(
    AcpAnnotations,
    "Optional annotations that help clients decide how to display or route this content."
  ),
} as const;

const AcpTextContent = Schema.Struct({
  ...contentFields,
  text: acpField(Schema.String, "Text payload carried by this content block."),
  type: acpField(Schema.Literal("text"), "ACP content block type."),
});

const AcpImageContent = Schema.Struct({
  ...contentFields,
  data: acpField(Schema.String, "Base64-encoded media payload."),
  mimeType: acpField(
    Schema.String,
    "MIME type describing the encoded media payload."
  ),
  type: acpField(Schema.Literal("image"), "ACP content block type."),
  uri: acpOptionalField(
    Schema.String,
    "URI associated with this resource or media payload."
  ),
});

const AcpAudioContent = Schema.Struct({
  ...contentFields,
  data: acpField(Schema.String, "Base64-encoded media payload."),
  mimeType: acpField(
    Schema.String,
    "MIME type describing the encoded media payload."
  ),
  type: acpField(Schema.Literal("audio"), "ACP content block type."),
});

const AcpResourceLink = Schema.Struct({
  ...contentFields,
  description: acpOptionalField(
    Schema.String,
    "Optional human-readable details shown with this protocol object."
  ),
  mimeType: acpOptionalField(
    Schema.String,
    "MIME type describing the encoded media payload."
  ),
  name: acpField(
    Schema.String,
    "Human-readable name shown for this protocol object."
  ),
  size: acpOptionalField(
    AcpInt64,
    "Optional size of the linked resource in bytes, if known."
  ),
  title: acpOptionalField(
    Schema.String,
    "Optional display title for end-user UI."
  ),
  type: acpField(Schema.Literal("resource_link"), "ACP content block type."),
  uri: acpField(
    Schema.String,
    "URI associated with this resource or media payload."
  ),
});

const resourceFields = {
  ...AcpMetaFields.fields,
  mimeType: acpOptionalField(
    Schema.String,
    "MIME type describing the encoded media payload."
  ),
  uri: acpField(
    Schema.String,
    "URI associated with this resource or media payload."
  ),
} as const;

const AcpTextResourceContents = Schema.Struct({
  ...resourceFields,
  text: acpField(Schema.String, "Text payload carried by this content block."),
});

const AcpBlobResourceContents = Schema.Struct({
  ...resourceFields,
  blob: acpField(
    Schema.String,
    "Base64-encoded bytes for a binary resource payload."
  ),
});

const AcpEmbeddedResource = Schema.Struct({
  ...contentFields,
  resource: acpField(
    Schema.Union([AcpTextResourceContents, AcpBlobResourceContents]),
    "Embedded resource payload, either text or binary data."
  ),
  type: acpField(Schema.Literal("resource"), "ACP content block type."),
});

const AcpContentBlock = Schema.Union([
  AcpTextContent,
  AcpImageContent,
  AcpAudioContent,
  AcpResourceLink,
  AcpEmbeddedResource,
])
  .annotate({
    description: `Content blocks represent displayable information in the Agent Client Protocol.

They provide a structured way to handle various types of user-facing content—whether
it's text from language models, images for analysis, or embedded resources for context.

Content blocks appear in:
- User prompts sent via \`session/prompt\`
- Language model output streamed through \`session/update\` notifications
- Progress updates and results from tool calls

This structure is compatible with the Model Context Protocol (MCP), enabling
agents to seamlessly forward content from MCP tool outputs without transformation.

See protocol docs: [Content](https://agentclientprotocol.com/protocol/content)`,
    identifier: "AcpContentBlock",
  })
  .pipe(Schema.toTaggedUnion("type"));

export { acpField, acpOptionalField, AcpContentBlock, AcpMetaFields };
