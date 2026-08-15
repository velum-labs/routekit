import { Schema } from "effect";

import {
  AcpOptionalTolerantArray,
  AcpTolerantArray,
  AcpUint64,
} from "./primitives.ts";

import {
  acpField,
  acpOptionalField,
  AcpContentBlock,
  AcpMetaFields,
} from "./content.ts";
import { AcpSessionConfigOption } from "./session-config.ts";
import {
  AcpToolCallContent,
  AcpToolCallLocation,
  AcpToolCallStatus,
  AcpToolKind,
} from "./tool-call.ts";

const contentChunkFields = {
  ...AcpMetaFields.fields,
  content: acpField(AcpContentBlock, "A single item of content"),
  messageId: acpOptionalField(
    Schema.String,
    `A unique identifier for the message this chunk belongs to.

All chunks belonging to the same message share the same \`messageId\`.
A change in \`messageId\` indicates a new message has started.`
  ),
} as const;

const AcpUserMessageChunk = Schema.Struct({
  ...contentChunkFields,
  sessionUpdate: acpField(
    Schema.Literal("user_message_chunk"),
    "ACP session update type."
  ),
});

const AcpAgentMessageChunk = Schema.Struct({
  ...contentChunkFields,
  sessionUpdate: acpField(
    Schema.Literal("agent_message_chunk"),
    "ACP session update type."
  ),
});

const AcpAgentThoughtChunk = Schema.Struct({
  ...contentChunkFields,
  sessionUpdate: acpField(
    Schema.Literal("agent_thought_chunk"),
    "ACP session update type."
  ),
});

const toolCallFields = {
  ...AcpMetaFields.fields,
  content: AcpOptionalTolerantArray(
    AcpToolCallContent,
    "Content produced by the tool call."
  ),
  kind: acpOptionalField(
    AcpToolKind,
    `The category of tool being invoked.
Helps clients choose appropriate icons and UI treatment.`
  ),
  locations: AcpOptionalTolerantArray(
    AcpToolCallLocation,
    `File locations affected by this tool call.
Enables "follow-along" features in clients.`
  ),
  rawInput: acpOptionalField(
    Schema.Json,
    "Raw input parameters sent to the tool."
  ),
  rawOutput: acpOptionalField(Schema.Json, "Raw output returned by the tool."),
  status: acpOptionalField(
    AcpToolCallStatus,
    "Current execution status of the tool call."
  ),
} as const;

const AcpToolCall = Schema.Struct({
  ...toolCallFields,
  sessionUpdate: acpField(
    Schema.Literal("tool_call"),
    "ACP session update type."
  ),
  title: acpField(
    Schema.String,
    "Human-readable title describing what the tool is doing."
  ),
  toolCallId: acpField(
    Schema.String,
    "Unique identifier for this tool call within the session."
  ),
});

const AcpToolCallUpdate = Schema.Struct({
  ...AcpMetaFields.fields,
  content: AcpOptionalTolerantArray(
    AcpToolCallContent,
    "Replace the content collection."
  ),
  kind: acpOptionalField(AcpToolKind, "Update the tool kind."),
  locations: AcpOptionalTolerantArray(
    AcpToolCallLocation,
    "Replace the locations collection."
  ),
  rawInput: acpOptionalField(Schema.Json, "Update the raw input."),
  rawOutput: acpOptionalField(Schema.Json, "Update the raw output."),
  sessionUpdate: acpField(
    Schema.Literal("tool_call_update"),
    "ACP session update type."
  ),
  status: acpOptionalField(AcpToolCallStatus, "Update the execution status."),
  title: acpOptionalField(Schema.String, "Update the human-readable title."),
  toolCallId: acpField(Schema.String, "The ID of the tool call being updated."),
});

const AcpPlanEntry = Schema.Struct({
  ...AcpMetaFields.fields,
  content: acpField(
    Schema.String,
    "Human-readable description of what this task aims to accomplish."
  ),
  priority: acpField(
    Schema.Literals(["high", "medium", "low"]),
    `The relative importance of this task.
Used to indicate which tasks are most critical to the overall goal.`
  ),
  status: acpField(
    Schema.Literals(["pending", "in_progress", "completed"]),
    "Current execution status of this task."
  ),
});

const AcpPlan = Schema.Struct({
  ...AcpMetaFields.fields,
  entries: AcpTolerantArray(
    AcpPlanEntry,
    `The list of tasks to be accomplished.

When updating a plan, the agent must send a complete list of all entries
with their current status. The client replaces the entire plan with each update.`
  ),
  sessionUpdate: acpField(Schema.Literal("plan"), "ACP session update type."),
});

const AcpAvailableCommand = Schema.Struct({
  ...AcpMetaFields.fields,
  description: acpField(
    Schema.String,
    "Human-readable description of what the command does."
  ),
  input: acpOptionalField(
    Schema.Struct({
      ...AcpMetaFields.fields,
      hint: acpField(
        Schema.String,
        "A hint to display when the input hasn't been provided yet"
      ),
    }),
    "Input for the command if required"
  ),
  name: acpField(
    Schema.String,
    "Command name (e.g., `create_plan`, `research_codebase`)."
  ),
});

const AcpAvailableCommandsUpdate = Schema.Struct({
  ...AcpMetaFields.fields,
  availableCommands: AcpTolerantArray(
    AcpAvailableCommand,
    "Commands the agent can execute"
  ),
  sessionUpdate: acpField(
    Schema.Literal("available_commands_update"),
    "ACP session update type."
  ),
});

const AcpCurrentModeUpdate = Schema.Struct({
  ...AcpMetaFields.fields,
  currentModeId: acpField(Schema.String, "The ID of the current mode"),
  sessionUpdate: acpField(
    Schema.Literal("current_mode_update"),
    "ACP session update type."
  ),
});

const AcpConfigOptionUpdate = Schema.Struct({
  ...AcpMetaFields.fields,
  configOptions: AcpTolerantArray(
    AcpSessionConfigOption,
    "The full set of configuration options and their current values."
  ),
  sessionUpdate: acpField(
    Schema.Literal("config_option_update"),
    "ACP session update type."
  ),
});

const AcpSessionInfoUpdate = Schema.Struct({
  ...AcpMetaFields.fields,
  sessionUpdate: acpField(
    Schema.Literal("session_info_update"),
    "ACP session update type."
  ),
  title: acpOptionalField(
    Schema.String,
    "Human-readable title for the session. Set to null to clear."
  ),
  updatedAt: acpOptionalField(
    Schema.String,
    "ISO 8601 timestamp of last activity. Set to null to clear."
  ),
});

const AcpUsageUpdate = Schema.Struct({
  ...AcpMetaFields.fields,
  cost: acpOptionalField(
    Schema.Struct({
      ...AcpMetaFields.fields,
      amount: Schema.Finite.annotate({
        description: "Total cumulative cost for session.",
      }),
      currency: acpField(
        Schema.String,
        'ISO 4217 currency code (e.g., "USD", "EUR").'
      ),
    }),
    "Cumulative session cost (optional)."
  ),
  sessionUpdate: acpField(
    Schema.Literal("usage_update"),
    "ACP session update type."
  ),
  size: AcpUint64.annotate({
    description: "Total context window size in tokens.",
  }),
  used: AcpUint64.annotate({
    description: "Tokens currently in context.",
  }),
});

const AcpSessionUpdate = Schema.Union([
  AcpUserMessageChunk,
  AcpAgentMessageChunk,
  AcpAgentThoughtChunk,
  AcpToolCall,
  AcpToolCallUpdate,
  AcpPlan,
  AcpAvailableCommandsUpdate,
  AcpCurrentModeUpdate,
  AcpConfigOptionUpdate,
  AcpSessionInfoUpdate,
  AcpUsageUpdate,
])
  .annotate({ identifier: "AcpSessionUpdate" })
  .pipe(Schema.toTaggedUnion("sessionUpdate"));

export { AcpSessionUpdate, AcpToolCallUpdate };
