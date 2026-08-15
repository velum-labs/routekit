import { Schema } from "effect";

import { AcpUint32 } from "./primitives.ts";

import {
  acpField,
  acpOptionalField,
  AcpContentBlock,
  AcpMetaFields,
} from "./content.ts";

const AcpToolKind = Schema.Literals([
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "switch_mode",
  "other",
]);

const AcpToolCallStatus = Schema.Literals([
  "pending",
  "in_progress",
  "completed",
  "failed",
]);

const AcpToolCallContentBlock = Schema.Struct({
  ...AcpMetaFields.fields,
  content: acpField(AcpContentBlock, "The actual content block."),
  type: acpField(Schema.Literal("content"), "ACP tool-call content type."),
});

const AcpToolCallDiff = Schema.Struct({
  ...AcpMetaFields.fields,
  newText: acpField(Schema.String, "The new content after modification."),
  oldText: acpOptionalField(
    Schema.String,
    "The original content (None for new files)."
  ),
  path: acpField(Schema.String, "The absolute file path being modified."),
  type: acpField(Schema.Literal("diff"), "ACP tool-call content type."),
});

const AcpToolCallTerminal = Schema.Struct({
  ...AcpMetaFields.fields,
  terminalId: acpField(
    Schema.String,
    "Identifier of the terminal instance to embed in the content stream."
  ),
  type: acpField(Schema.Literal("terminal"), "ACP tool-call content type."),
});

const AcpToolCallContent = Schema.Union([
  AcpToolCallContentBlock,
  AcpToolCallDiff,
  AcpToolCallTerminal,
])
  .annotate({
    description: `Content produced by a tool call.

Tool calls can produce different types of content including
standard content blocks (text, images) or file diffs.

See protocol docs: [Content](https://agentclientprotocol.com/protocol/tool-calls#content)`,
    identifier: "AcpToolCallContent",
  })
  .pipe(Schema.toTaggedUnion("type"));

const AcpToolCallLocation = Schema.Struct({
  ...AcpMetaFields.fields,
  line: acpOptionalField(AcpUint32, "Optional line number within the file."),
  path: acpField(
    Schema.String,
    "The absolute file path being accessed or modified."
  ),
});

export {
  AcpToolCallContent,
  AcpToolCallLocation,
  AcpToolCallStatus,
  AcpToolKind,
};
