import { Schema } from "effect";

import { AssistantMessageEvent } from "./assistant-message.ts";

import { CompactionEnd, CompactionStart } from "./compaction-schema.ts";
import {
  AgentEnd,
  ForkCommand,
  ForkResult,
  GetForkMessagesCommand,
  GetForkMessagesResult,
  RetryEnd,
  RetryStart,
} from "./retry-schema.ts";

const PiCommandId = Schema.NonEmptyString;
const OptionalCommandId = Schema.optionalKey(PiCommandId);

const PromptCommand = Schema.Struct({
  id: OptionalCommandId,
  message: Schema.String,
  type: Schema.Literal("prompt"),
});
const AbortCommand = Schema.Struct({
  id: OptionalCommandId,
  type: Schema.Literal("abort"),
});
const NewSessionCommand = Schema.Struct({
  id: OptionalCommandId,
  type: Schema.Literal("new_session"),
});
const GetStateCommand = Schema.Struct({
  id: OptionalCommandId,
  type: Schema.Literal("get_state"),
});
const GetMessagesCommand = Schema.Struct({
  id: OptionalCommandId,
  type: Schema.Literal("get_messages"),
});
const SwitchSessionCommand = Schema.Struct({
  id: OptionalCommandId,
  sessionPath: Schema.String,
  type: Schema.Literal("switch_session"),
});

const ExtensionUiResponse = Schema.Union([
  Schema.Struct({
    id: PiCommandId,
    type: Schema.Literal("extension_ui_response"),
    value: Schema.String,
  }),
  Schema.Struct({
    confirmed: Schema.Boolean,
    id: PiCommandId,
    type: Schema.Literal("extension_ui_response"),
  }),
  Schema.Struct({
    cancelled: Schema.Literal(true),
    id: PiCommandId,
    type: Schema.Literal("extension_ui_response"),
  }),
]);

// Request commands are a real tagged union on `type`. The extension-UI response
// is separate: its three variants share `type`, differing by field presence.
const PiRequestCommand = Schema.Union([
  PromptCommand,
  AbortCommand,
  NewSessionCommand,
  GetStateCommand,
  GetMessagesCommand,
  GetForkMessagesCommand,
  ForkCommand,
  SwitchSessionCommand,
]).pipe(Schema.toTaggedUnion("type"));

const PiCommand = Schema.Union([PiRequestCommand, ExtensionUiResponse]);

const PiSessionState = Schema.Struct({
  autoCompactionEnabled: Schema.Boolean,
  followUpMode: Schema.Literals(["all", "one-at-a-time"]),
  isCompacting: Schema.Boolean,
  isStreaming: Schema.Boolean,
  messageCount: Schema.Int,
  model: Schema.optionalKey(Schema.Unknown),
  pendingMessageCount: Schema.Int,
  sessionFile: Schema.optionalKey(Schema.String),
  sessionId: Schema.NonEmptyString,
  sessionName: Schema.optionalKey(Schema.String),
  steeringMode: Schema.Literals(["all", "one-at-a-time"]),
  thinkingLevel: Schema.Literals([
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
  ]),
});

// Ties each command type to its result schema for derived caller result types.
const PiCommandResultSchemas = {
  abort: Schema.Void,
  fork: ForkResult,
  get_fork_messages: GetForkMessagesResult,
  get_messages: Schema.Struct({ messages: Schema.Array(Schema.Unknown) }),
  get_state: PiSessionState,
  new_session: Schema.Struct({ cancelled: Schema.Boolean }),
  prompt: Schema.Void,
  switch_session: Schema.Struct({ cancelled: Schema.Boolean }),
} satisfies Record<PiCommandType, Schema.Top>;
const successfulResponse = <Command extends string, Data extends Schema.Top>(
  command: Command,
  data: Data
): Schema.Struct<{
  readonly command: Schema.Literal<Command>;
  readonly data: Data;
  readonly id: Schema.optionalKey<Schema.NonEmptyString>;
  readonly success: Schema.Literal<true>;
  readonly type: Schema.Literal<"response">;
}> =>
  Schema.Struct({
    command: Schema.Literal(command),
    data,
    id: OptionalCommandId,
    success: Schema.Literal(true),
    type: Schema.Literal("response"),
  });

const successfulVoidResponse = <Command extends string>(
  command: Command
): Schema.Struct<{
  readonly command: Schema.Literal<Command>;
  readonly id: Schema.optionalKey<Schema.NonEmptyString>;
  readonly success: Schema.Literal<true>;
  readonly type: Schema.Literal<"response">;
}> =>
  Schema.Struct({
    command: Schema.Literal(command),
    id: OptionalCommandId,
    success: Schema.Literal(true),
    type: Schema.Literal("response"),
  });

const PiSuccessResponse = Schema.Union([
  successfulVoidResponse("prompt"),
  successfulVoidResponse("abort"),
  successfulResponse("fork", PiCommandResultSchemas.fork),
  successfulResponse(
    "get_fork_messages",
    PiCommandResultSchemas.get_fork_messages
  ),
  successfulResponse("new_session", PiCommandResultSchemas.new_session),
  successfulResponse("get_state", PiCommandResultSchemas.get_state),
  successfulResponse("get_messages", PiCommandResultSchemas.get_messages),
  successfulResponse("switch_session", PiCommandResultSchemas.switch_session),
]);
const PiFailureResponse = Schema.Struct({
  command: Schema.String,
  error: Schema.String,
  id: OptionalCommandId,
  success: Schema.Literal(false),
  type: Schema.Literal("response"),
});
const PiResponse = Schema.Union([PiSuccessResponse, PiFailureResponse]);

const event = <Type extends string>(
  type: Type
): Schema.Struct<{ readonly type: Schema.Literal<Type> }> =>
  Schema.Struct({ type: Schema.Literal(type) });

const MessageUpdate = Schema.Struct({
  assistantMessageEvent: AssistantMessageEvent,
  type: Schema.Literal("message_update"),
});
const ToolStart = Schema.Struct({
  args: Schema.Json,
  toolCallId: Schema.NonEmptyString,
  toolName: Schema.NonEmptyString,
  type: Schema.Literal("tool_execution_start"),
});
const ToolEnd = Schema.Struct({
  isError: Schema.Boolean,
  result: Schema.Struct({
    content: Schema.Array(
      Schema.Struct({
        text: Schema.String,
        type: Schema.Literal("text"),
      })
    ),
  }),
  toolCallId: Schema.NonEmptyString,
  type: Schema.Literal("tool_execution_end"),
});
export const UsageBearingPiMessage = Schema.Struct({
  errorMessage: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.String),
  responseId: Schema.optionalKey(Schema.String),
  responseModel: Schema.optionalKey(Schema.String),
  role: Schema.Literals(["assistant", "toolResult", "user"]),
  stopReason: Schema.optionalKey(Schema.String),
  // Pi may omit usage on failures; optional preserves provider text for 402 clamping.
  usage: Schema.optionalKey(Schema.Unknown),
});
const MessageEnd = Schema.Struct({
  // Pi ends the user's turn with a `message_end` too, not just the assistant's.
  message: UsageBearingPiMessage,
  type: Schema.Literal("message_end"),
});
const TurnEnd = Schema.Struct({
  message: Schema.optionalKey(Schema.Unknown),
  type: Schema.Literal("turn_end"),
});
const SessionInfoChanged = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  type: Schema.Literal("session_info_changed"),
});

const PiKnownSessionEvent = Schema.Union([
  event("agent_start"),
  AgentEnd,
  event("turn_start"),
  TurnEnd,
  event("message_start"),
  event("tool_execution_update"),
  event("queue_update"),
  event("thinking_level_changed"),
  MessageUpdate,
  MessageEnd,
  ToolStart,
  ToolEnd,
  SessionInfoChanged,
  CompactionStart,
  CompactionEnd,
  RetryStart,
  RetryEnd,
]).pipe(Schema.toTaggedUnion("type"));

const ExtensionUiRequestKnown = Schema.Union([
  Schema.Struct({
    id: PiCommandId,
    method: Schema.Literal("select"),
    options: Schema.Array(Schema.String),
    timeout: Schema.optionalKey(Schema.Number),
    title: Schema.String,
    type: Schema.Literal("extension_ui_request"),
  }),
  Schema.Struct({
    id: PiCommandId,
    message: Schema.String,
    method: Schema.Literal("confirm"),
    timeout: Schema.optionalKey(Schema.Number),
    title: Schema.String,
    type: Schema.Literal("extension_ui_request"),
  }),
  Schema.Struct({
    id: PiCommandId,
    method: Schema.Literal("input"),
    placeholder: Schema.optionalKey(Schema.String),
    timeout: Schema.optionalKey(Schema.Number),
    title: Schema.String,
    type: Schema.Literal("extension_ui_request"),
  }),
  Schema.Struct({
    id: PiCommandId,
    method: Schema.Literal("editor"),
    prefill: Schema.optionalKey(Schema.String),
    title: Schema.String,
    type: Schema.Literal("extension_ui_request"),
  }),
  Schema.Struct({
    id: PiCommandId,
    message: Schema.String,
    method: Schema.Literal("notify"),
    notifyType: Schema.optionalKey(
      Schema.Literals(["info", "warning", "error"])
    ),
    type: Schema.Literal("extension_ui_request"),
  }),
  Schema.Struct({
    id: PiCommandId,
    method: Schema.Literal("setStatus"),
    statusKey: Schema.String,
    statusText: Schema.optionalKey(Schema.String),
    type: Schema.Literal("extension_ui_request"),
  }),
  Schema.Struct({
    id: PiCommandId,
    method: Schema.Literal("setWidget"),
    widgetKey: Schema.String,
    widgetLines: Schema.optionalKey(Schema.Array(Schema.String)),
    widgetPlacement: Schema.optionalKey(
      Schema.Literals(["aboveEditor", "belowEditor"])
    ),
    type: Schema.Literal("extension_ui_request"),
  }),
  Schema.Struct({
    id: PiCommandId,
    method: Schema.Literal("setTitle"),
    title: Schema.String,
    type: Schema.Literal("extension_ui_request"),
  }),
  Schema.Struct({
    id: PiCommandId,
    method: Schema.Literal("set_editor_text"),
    text: Schema.String,
    type: Schema.Literal("extension_ui_request"),
  }),
]).pipe(Schema.toTaggedUnion("method"));

// A forward-compatible extension request whose `method` Pi does not document
// today. It still decodes (carrying `id`) so the elicitation projection can
// settle the native peer rather than leave Pi blocked on an unanswered request.
const ExtensionUiRequestUnknown = Schema.Struct({
  id: PiCommandId,
  method: Schema.String,
  type: Schema.Literal("extension_ui_request"),
});
const ExtensionUiRequest = Schema.Union([
  ExtensionUiRequestKnown,
  ExtensionUiRequestUnknown,
]);

const PiInbound = Schema.Union([
  PiResponse,
  PiKnownSessionEvent,
  ExtensionUiRequest,
]);

// Discriminant-only envelope: separates a genuinely unknown event type from a
// known type whose payload failed to decode, at the boundary.
const PiEnvelope = Schema.Struct({
  diagnosticHarness: Schema.optionalKey(Schema.String),
  type: Schema.NonEmptyString,
});
const SESSION_EVENT_TYPES = [
  "agent_start",
  "agent_end",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "queue_update",
  "compaction_start",
  "session_info_changed",
  "thinking_level_changed",
  "compaction_end",
  "auto_retry_start",
  "auto_retry_end",
] as const;
const KNOWN_INBOUND_TYPES: ReadonlySet<string> = new Set([
  ...SESSION_EVENT_TYPES,
  "response",
  "extension_ui_request",
]);

type PiCommand = typeof PiCommand.Type;
type PiCommandType = Exclude<PiCommand["type"], "extension_ui_response">;
type PiCommandResult<Type extends PiCommandType> =
  (typeof PiCommandResultSchemas)[Type]["Type"];
type PiResponse = typeof PiResponse.Type;
type PiSuccessResponse = typeof PiSuccessResponse.Type;
type PiInbound = typeof PiInbound.Type;
type PiEnvelope = typeof PiEnvelope.Type;
type PiKnownSessionEvent = typeof PiKnownSessionEvent.Type;
type PiExtensionUiRequest = typeof ExtensionUiRequest.Type;
type PiExtensionUiResponse = typeof ExtensionUiResponse.Type;
type PiSessionState = typeof PiSessionState.Type;
export {
  ExtensionUiRequestKnown,
  KNOWN_INBOUND_TYPES,
  PiCommand,
  PiCommandResultSchemas,
  PiEnvelope,
  PiInbound,
  PiKnownSessionEvent,
  PiResponse,
  PiSessionState,
};
export type {
  PiCommandResult,
  PiCommandType,
  PiExtensionUiRequest,
  PiExtensionUiResponse,
  PiSuccessResponse,
};
